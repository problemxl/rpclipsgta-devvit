/**
 * Pure validation and orchestration helpers for moderator-created clip fixtures.
 *
 * Fixture posts are ordinary Reddit link posts, not crossposts: the original
 * Twitch/Kick URL remains the post's submitted URL so clipbackup can detect it.
 */

/** The only subreddits a fixture may be created in. */
export const FIXTURE_TARGETS = [
  {
    key: 'dev',
    subreddit: 'S17Cjn21GT',
    label: 'Development (S17Cjn21GT)',
    titlePrefix: '[DEV FIXTURE]',
  },
  {
    key: 'qa',
    subreddit: 'rpclipsgta_mod_dev',
    label: 'QA/staging (rpclipsgta_mod_dev)',
    titlePrefix: '[QA FIXTURE]',
  },
] as const;

export type FixtureTarget = (typeof FIXTURE_TARGETS)[number];

/** Minimal source-post shape needed to create a fixture. */
export interface FixtureSourcePost {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly permalink: string;
}

/** Link-post options accepted by the Reddit client. */
export interface FixturePost {
  readonly subredditName: string;
  readonly title: string;
  readonly url: string;
  readonly runAs: 'APP';
}

export interface FixtureCreatedPost {
  readonly id: string;
  readonly permalink?: string;
  /** Post.edit is supplied by the Devvit Reddit Post model. */
  readonly edit?: (options: { text: string }) => Promise<void>;
}

export interface FixtureRedditClient {
  submitPost(options: FixturePost): Promise<FixtureCreatedPost>;
}

export interface FixtureDedupeStore {
  set(key: string, value: string, options: { nx: true }): Promise<string>;
  del(key: string): Promise<unknown>;
}

export interface CreateFixtureOptions {
  source: FixtureSourcePost;
  target: FixtureTarget;
  actor: string | undefined;
  reddit: FixtureRedditClient;
  dedupe: FixtureDedupeStore;
}

export interface CreateFixtureResult {
  readonly created: boolean;
  readonly duplicate?: boolean;
  readonly post?: FixtureCreatedPost;
}

/** An input error that can be shown directly to a moderator. */
export class FixtureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureInputError';
  }
}

/** Resolve one select value; arbitrary subreddit names are never accepted. */
export function fixtureTargetFromSelection(
  values: readonly string[] | undefined
): FixtureTarget | undefined {
  if (!values || values.length !== 1) return undefined;
  return FIXTURE_TARGETS.find((target) => target.key === values[0]);
}

function isFixtureTarget(target: FixtureTarget): boolean {
  return FIXTURE_TARGETS.some(
    (allowed) =>
      allowed.key === target.key &&
      allowed.subreddit === target.subreddit &&
      allowed.titlePrefix === target.titlePrefix
  );
}

/** Normalize the current user and require an authenticated moderator identity. */
export function requireFixtureActor(actor: string | undefined): string {
  const normalized = actor?.trim();
  if (!normalized) {
    throw new FixtureInputError('Could not determine the acting moderator.');
  }
  return normalized;
}

/** Return true only for Twitch or Kick clip URLs supported by clipbackup. */
export function isClipUrl(url: string | undefined): boolean {
  const value = url?.trim() ?? '';
  if (!value) return false;

  const twitch =
    /^https?:\/\/clips\.twitch\.tv\/[A-Za-z0-9][A-Za-z0-9_-]*(?:[/?#]|$)/i.test(value) ||
    /^https?:\/\/clips\.twitch\.tv\/embed\?[^#\s]*\bclip=[A-Za-z0-9][A-Za-z0-9_-]*(?:[&#]|$)/i.test(
      value
    ) ||
    /^https?:\/\/(?:www\.|go\.|m\.)?twitch\.tv\/[^/?#\s]+\/clip\/[A-Za-z0-9][A-Za-z0-9_-]*(?:[/?#]|$)/i.test(
      value
    );
  const kick =
    /^https?:\/\/(?:www\.)?kick\.com\/[\w-]+\/clips\/clip_[A-Za-z0-9-]+(?:[/?#]|$)/i.test(
      value
    ) ||
    /^https?:\/\/(?:www\.)?kick\.com\/[\w-]+\/?\?[^#\s]*\bclip=clip_[A-Za-z0-9-]+(?:[&#]|$)/i.test(
      value
    );
  return twitch || kick;
}

function compactTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Bounded self-text traceability for the generated link post. */
export function fixtureBody(source: FixtureSourcePost): string {
  return (
    `Fixture source post: ${source.id.trim()}\n` +
    `Source permalink: ${source.permalink.trim()}`
  ).slice(0, 1000);
}

/**
 * Build a bounded ordinary link-post payload.
 *
 * The source ID and permalink are carried in both the bounded title and the
 * generated post body for traceability. The submitted `url` is left untouched
 * for the detector.
 */
export function buildFixturePost(
  source: FixtureSourcePost,
  target: FixtureTarget
): FixturePost {
  if (!isFixtureTarget(target)) {
    throw new FixtureInputError('The fixture target is not an allowed test subreddit.');
  }
  const sourceUrl = source.url.trim();
  if (!isClipUrl(sourceUrl)) {
    throw new FixtureInputError(
      'The source post does not contain a Twitch or Kick clip URL.'
    );
  }
  if (!source.id.trim() || !source.permalink.trim()) {
    throw new FixtureInputError('The source post is missing an ID or permalink.');
  }

  const trace = `source:${source.id.trim()} ${source.permalink.trim()}`;
  const prefix = `${target.titlePrefix} `;
  const separator = ' — ';
  const available = 300 - prefix.length - separator.length - trace.length;
  const sourceTitle = compactTitle(source.title);
  const titlePart = available > 0 ? sourceTitle.slice(0, available).trim() : '';
  const title = `${prefix}${titlePart}${separator}${trace}`.slice(0, 300).trim();

  return {
    subredditName: target.subreddit,
    title,
    // Preserve the original URL rather than canonicalizing it or crossposting.
    url: source.url,
    runAs: 'APP',
  };
}

/** Stable key used to deduplicate retries for one source and target. */
export function fixtureDedupeKey(sourceId: string, target: FixtureTarget): string {
  return `clip-fixture:${sourceId}:${target.key}`;
}

/**
 * Claim, submit, and release the claim on failure. The Redis NX claim makes
 * repeated presses for the same source+target idempotent in normal operation.
 */
export async function createFixture(
  options: CreateFixtureOptions
): Promise<CreateFixtureResult> {
  requireFixtureActor(options.actor);
  const post = buildFixturePost(options.source, options.target);
  const key = fixtureDedupeKey(options.source.id.trim(), options.target);
  const claim = await options.dedupe.set(key, '1', { nx: true });
  if (!claim) return { created: false, duplicate: true };

  let created: FixtureCreatedPost;
  try {
    created = await options.reddit.submitPost(post);
  } catch (error) {
    try {
      await options.dedupe.del(key);
    } catch (releaseError) {
      console.error('[fixture] failed to release dedupe claim', releaseError);
    }
    throw error;
  }

  // Link posts can receive self-text after submission. Keeping this separate
  // from the link URL preserves the detector input and avoids a crosspost.
  // The title already carries the trace, so an edit failure must not report a
  // successful Reddit submission as failed or release its dedupe claim.
  if (created.edit) {
    try {
      await created.edit({ text: fixtureBody(options.source) });
    } catch (error) {
      console.error('[fixture] created post body trace could not be added', error);
    }
  }
  return { created: true, post: created };
}
