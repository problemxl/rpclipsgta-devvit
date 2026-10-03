/** Domains permitted by rule 5 for link-post submissions. */
export const WHITELISTED_DOMAINS = [
  'clips.twitch.tv',
  'twitch.tv',
  'facebook.com',
  'fb.watch',
  'kick.com',
  'streamable.com',
  'youtube.com',
  'imgur.com',
];

/** Streamer names whose submissions are covered by rule 12. */
export const BANNED_STREAMERS = ['koil', 'dasmehdi', 'zombie_barricades'];

/** The framework-free fields needed by the deterministic content checks. */
export interface SubmissionInput {
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly isTextPost: boolean;
}

/** The automatic action associated with a detected violation. */
export type AutoAction = 'remove' | 'remove-and-escalate';

/** A single deterministic subreddit-rule violation. */
export interface Violation {
  readonly rule: number;
  readonly reason: string;
  readonly action: AutoAction;
}

/** The parsed URL fields used by the detector and duplicate claim logic. */
export type ParsedSubmissionUrl =
  | { readonly ok: true; readonly host: string; readonly path: string }
  | { readonly ok: false };

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

/**
 * Parse a submission URL accepted by the detector. Link submissions are
 * intentionally limited to HTTP(S); malformed links are simply not
 * whitelisted rather than being allowed to throw from a trigger.
 */
export function parseSubmissionUrl(value: string): ParsedSubmissionUrl {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false };
    }
    const host = normalizeHost(parsed.hostname);
    if (!host) return { ok: false };
    return { ok: true, host, path: parsed.pathname };
  } catch {
    return { ok: false };
  }
}

/** Return true only for one of the eight exact allowlisted hosts. */
export function isWhitelistedHost(host: string): boolean {
  return WHITELISTED_DOMAINS.includes(normalizeHost(host));
}

function isTwitchHost(host: string): boolean {
  return normalizeHost(host) === 'twitch.tv';
}

function isKickHost(host: string): boolean {
  return normalizeHost(host) === 'kick.com';
}

/** Split a URL path into non-empty segments, allowing one trailing slash. */
function pathSegments(path: string): string[] {
  const segments = path.split('/');
  if (segments[0] === '') segments.shift();
  if (segments.at(-1) === '') segments.pop();
  if (segments.some((segment) => !segment)) return [];
  return segments;
}

function isVodPath(host: string, path: string): boolean {
  const segments = pathSegments(path).map((segment) => segment.toLowerCase());
  if (isTwitchHost(host)) {
    return (
      (segments.length === 2 && segments[0] === 'videos') ||
      (segments.length === 3 && segments[1] === 'video') ||
      (segments.length === 3 && segments[1] === 'videos')
    );
  }
  if (isKickHost(host)) {
    return (
      (segments.length === 2 && segments[0] === 'videos') ||
      (segments.length === 3 && segments[1] === 'videos')
    );
  }
  return false;
}

function isTwitchLegacyClipPath(host: string, path: string): boolean {
  if (!isTwitchHost(host)) return false;
  const segments = pathSegments(path);
  return segments.length === 3 && segments[1].toLowerCase() === 'clip';
}

function isTwitchChannelLink(host: string, path: string): boolean {
  return isTwitchHost(host) && pathSegments(path).length === 1;
}

function hasStreamableBracketTitle(title: string): boolean {
  const firstGroup = title.trim().match(/^\[([^\]]*)\]/u);
  return Boolean(firstGroup && /\p{L}/u.test(firstGroup[1]));
}

const SENTENCE_PLACEHOLDER = '\uE000';

function hasAtLeastTwoSentences(body: string): boolean {
  const cleaned = body
    // Markdown links contribute their visible text, not their URL.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // URLs do not contribute their path punctuation as sentence boundaries;
    // preserve punctuation immediately following a bare URL.
    .replace(/https?:\/\/[^\s<>()]+/gi, (url) => url.match(/[.!?]+$/u)?.[0] ?? ' ')
    // Decimal points are not sentence boundaries.
    .replace(/(\d)\.(?=\d)/g, `$1${SENTENCE_PLACEHOLDER}`);

  const sentenceCount = cleaned
    .split(/[.!?]+/)
    .filter((segment) => /\p{L}/u.test(segment));
  return sentenceCount.length >= 2;
}

function containsLetters(value: string): boolean {
  return /\p{L}/u.test(value.trim());
}

function decodedPathSegments(url: string): string[] {
  const parsed = parseSubmissionUrl(url);
  if (!parsed.ok) return [];

  return parsed.path
    .split('/')
    .filter(Boolean)
    .flatMap((segment) => {
      try {
        return [decodeURIComponent(segment)];
      } catch {
        // A malformed segment must not prevent later path segments being read.
        return [];
      }
    });
}

function containsBannedStreamer(value: string, streamer: string): boolean {
  const normalized = streamer === 'zombie_barricades' ? 'zombie barricades' : streamer;
  const words = normalized.split(' ');
  const phrase = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^\\p{L}\\p{N}]+');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${phrase}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(
    value
  );
}

function matchesBannedStreamer(title: string, url: string, isTextPost: boolean): boolean {
  const scannedText = [title, ...(isTextPost ? [] : decodedPathSegments(url))].join(' ');
  return BANNED_STREAMERS.some((streamer) => containsBannedStreamer(scannedText, streamer));
}

function makeViolation(
  rule: number,
  reason: string,
  action: AutoAction
): Violation {
  return { rule, reason, action };
}

/**
 * Detect deterministic violations. There is at most one result per rule:
 * R5 precedence is non-whitelisted/malformed host, then VOD, then an invalid
 * Twitch path, then the Streamable title convention; R4 precedence is a
 * Twitch channel, then a short text post, then an emote-only title. R12 has
 * one combined title/path name check.
 *
 * Rule 6 is intentionally omitted because it requires Redis state.
 */
export function detectContentViolations(submission: SubmissionInput): Violation[] {
  const violations: Violation[] = [];
  const parsedUrl = submission.isTextPost ? undefined : parseSubmissionUrl(submission.url);

  // Rule 5: only link posts are checked against the exact domain allowlist.
  if (!submission.isTextPost) {
    let reason: string | undefined;
    if (!parsedUrl?.ok || !isWhitelistedHost(parsedUrl.host)) {
      reason = 'link domain is not whitelisted';
    } else if (isVodPath(parsedUrl.host, parsedUrl.path)) {
      reason = 'VOD links are prohibited as submissions';
    } else if (
      isTwitchHost(parsedUrl.host) &&
      !isTwitchLegacyClipPath(parsedUrl.host, parsedUrl.path)
    ) {
      reason = 'Twitch clips must be posted via clips.twitch.tv';
    } else if (
      parsedUrl.host === 'streamable.com' &&
      !hasStreamableBracketTitle(submission.title)
    ) {
      reason = 'streamable title must start with a bracket tag containing letters';
    }
    if (reason) violations.push(makeViolation(5, reason, 'remove-and-escalate'));
  }

  // Rule 4: only the highest-precedence deterministic reason is returned.
  if (
    parsedUrl?.ok &&
    isTwitchChannelLink(parsedUrl.host, parsedUrl.path)
  ) {
    violations.push(
      makeViolation(4, 'link is a twitch channel, not a clip', 'remove-and-escalate')
    );
  } else if (submission.isTextPost && !hasAtLeastTwoSentences(submission.body)) {
    violations.push(makeViolation(4, 'text post under two sentences', 'remove-and-escalate'));
  } else if (!containsLetters(submission.title)) {
    violations.push(makeViolation(4, 'emote-only title', 'remove-and-escalate'));
  }

  // Rule 12 scans only the title and decoded URL path segments.
  if (matchesBannedStreamer(submission.title, submission.url, submission.isTextPost)) {
    violations.push(
      makeViolation(12, 'submission mentions a banned streamer', 'remove')
    );
  }

  return violations;
}

/**
 * Normalize a link URL for rule 6 duplicate detection. Invalid or non-HTTP(S)
 * URLs return an empty string; callers should only use this for link posts.
 */
export function normalizeUrlForDuplication(url: string): string {
  const parsed = parseSubmissionUrl(url);
  if (!parsed.ok) return '';

  try {
    const original = new URL(url);
    const port = original.port ? `:${original.port}` : '';
    const pathname = original.pathname.replace(/\/+$/, '');
    const search = new URLSearchParams();
    for (const [key, value] of original.searchParams) {
      if (/^(?:utm_.+|fbclid|gclid|igshid)$/i.test(key)) continue;
      search.append(key, value);
    }
    const query = search.toString();
    return `${original.protocol.toLowerCase()}//${parsed.host}${port}${pathname}${
      query ? `?${query}` : ''
    }`;
  } catch {
    return '';
  }
}

/** Compare two link URLs after applying the rule 6 duplicate normalization. */
export function isDuplicateUrl(url: string, knownUrl: string | null): boolean {
  if (!knownUrl) return false;
  const normalizedUrl = normalizeUrlForDuplication(url);
  const normalizedKnownUrl = normalizeUrlForDuplication(knownUrl);
  return Boolean(normalizedUrl && normalizedKnownUrl && normalizedUrl === normalizedKnownUrl);
}
