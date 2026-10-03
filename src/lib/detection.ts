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

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '');
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function isWhitelistedHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return WHITELISTED_DOMAINS.some(
    (root) => normalized === root || normalized.endsWith(`.${root}`)
  );
}

function isTwitchHost(host: string): boolean {
  return normalizeHost(host) === 'twitch.tv';
}

function isKickHost(host: string): boolean {
  return normalizeHost(host) === 'kick.com';
}

function isVodPath(url: URL): boolean {
  const path = url.pathname;
  return (
    ((isTwitchHost(url.hostname) &&
      (/^\/videos(?:\/|$)/i.test(path) || /^\/[^/]+\/video(?:\/|$)/i.test(path))) ||
      (isKickHost(url.hostname) && /^\/videos(?:\/|$)/i.test(path)))
  );
}

function hasStreamableBracketTitle(title: string): boolean {
  return /\[[^\]]*\S[^\]]*\]/.test(title);
}

function isTwitchChannelLink(url: URL): boolean {
  const host = normalizeHost(url.hostname);
  if (host === 'clips.twitch.tv' || !isTwitchHost(host)) return false;
  return /^\/[^/?#]+\/?$/.test(url.pathname);
}

function hasAtLeastTwoSentences(body: string): boolean {
  return body
    .split(/[.!?—]/)
    .map((segment) => segment.trim())
    .filter(Boolean).length >= 2;
}

function containsLetters(value: string): boolean {
  return /\p{L}/u.test(value.trim());
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containsBannedStreamer(value: string, streamer: string): boolean {
  if (streamer === 'zombie_barricades') {
    return new RegExp('\\bzombie(?:[\\s_-]+)barricades\\b', 'i').test(value);
  }
  return new RegExp(`\\b${escapedRegExp(streamer)}\\b`, 'i').test(value);
}

function matchesBannedStreamer(value: string): boolean {
  let decoded = value;
  try {
    decoded = `${value} ${decodeURIComponent(value)}`;
  } catch {
    // The raw URL/title is still checked when a URL contains malformed escapes.
  }
  return BANNED_STREAMERS.some((streamer) => containsBannedStreamer(decoded, streamer));
}

/**
 * Detect all high-confidence automated violations in canonical priority-group
 * order. Rule 6 is intentionally omitted because it requires Redis state.
 */
export function detectContentViolations(submission: SubmissionInput): Violation[] {
  const violations: Violation[] = [];
  const parsedUrl = submission.isTextPost ? undefined : parseUrl(submission.url);

  // Rule 5: only link posts are checked against the exact domain allowlist.
  if (!submission.isTextPost) {
    if (!parsedUrl || !isWhitelistedHost(parsedUrl.hostname)) {
      violations.push({
        rule: 5,
        reason: 'link domain is not whitelisted',
        action: 'remove-and-escalate',
      });
    } else if (isVodPath(parsedUrl)) {
      // Rule 5: whole Twitch/Kick VOD links are prohibited as submissions.
      violations.push({
        rule: 5,
        reason: 'VOD links are prohibited as submissions',
        action: 'remove-and-escalate',
      });
    }

    if (
      parsedUrl &&
      normalizeHost(parsedUrl.hostname) === 'streamable.com' &&
      !hasStreamableBracketTitle(submission.title)
    ) {
      // Rule 5: Streamable submissions must identify the streamer in brackets.
      violations.push({
        rule: 5,
        reason: 'streamable title must include streamer name in brackets',
        action: 'remove-and-escalate',
      });
    }
  }

  // Rule 4: these are the three deterministic low-effort checks only.
  if (parsedUrl && isTwitchChannelLink(parsedUrl)) {
    violations.push({
      rule: 4,
      reason: 'link is a twitch channel, not a clip',
      action: 'remove-and-escalate',
    });
  }
  if (submission.isTextPost && !hasAtLeastTwoSentences(submission.body)) {
    violations.push({
      rule: 4,
      reason: 'text post under two sentences',
      action: 'remove-and-escalate',
    });
  }
  if (!containsLetters(submission.title)) {
    violations.push({
      rule: 4,
      reason: 'emote-only title',
      action: 'remove-and-escalate',
    });
  }

  // Rule 12: mentions remove the submission but never warn or ban the author.
  if (matchesBannedStreamer(`${submission.title} ${submission.url}`)) {
    violations.push({
      rule: 12,
      reason: 'submission mentions a banned streamer',
      action: 'remove',
    });
  }

  return violations;
}

/**
 * Normalize a link URL for rule 6 duplicate detection. Invalid URLs return an
 * empty string; callers should only use this helper for parseable link posts.
 */
export function normalizeUrlForDuplication(url: string): string {
  const parsed = parseUrl(url);
  if (!parsed) return '';

  const hostname = normalizeHost(parsed.hostname);
  const port = parsed.port ? `:${parsed.port}` : '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  const search = new URLSearchParams();
  for (const [key, value] of parsed.searchParams) {
    if (/^(?:utm_.+|fbclid|gclid|igshid)$/i.test(key)) continue;
    search.append(key, value);
  }
  const query = search.toString();
  return `${parsed.protocol.toLowerCase()}//${hostname}${port}${pathname}${
    query ? `?${query}` : ''
  }`;
}

/** Compare two link URLs after applying the rule 6 duplicate normalization. */
export function isDuplicateUrl(url: string, knownUrl: string | null): boolean {
  if (!knownUrl) return false;
  const normalizedUrl = normalizeUrlForDuplication(url);
  const normalizedKnownUrl = normalizeUrlForDuplication(knownUrl);
  return Boolean(normalizedUrl && normalizedKnownUrl && normalizedUrl === normalizedKnownUrl);
}
