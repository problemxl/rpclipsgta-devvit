/**
 * Validation and orchestration helpers for moderator-created clip fixtures.
 *
 * Fixture posts are ordinary Reddit link posts, not crossposts: the original
 * Twitch/Kick URL remains the post's submitted URL so clipbackup can detect it.
 * Traceability is stored in the app's global Redis metadata because Reddit's
 * link-post API does not support a body or arbitrary metadata field.
 */

/** The only subreddit from which a fixture command may be launched. */
export const FIXTURE_SOURCE_SUBREDDIT = 'rpclipsgta';

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
}

export interface FixtureRedditClient {
  submitPost(options: FixturePost): Promise<FixtureCreatedPost>;
}

export interface FixtureDedupeStore {
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: { nx?: true; xx?: true; expiration?: Date }
  ): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
}

export interface CreateFixtureOptions {
  source: FixtureSourcePost;
  target: FixtureTarget;
  actor: string | undefined;
  reddit: FixtureRedditClient;
  dedupe: FixtureDedupeStore;
}

export interface FixtureRecord {
  readonly version: 1;
  readonly status: 'pending' | 'created';
  readonly sourceId: string;
  readonly sourcePermalink: string;
  readonly targetKey: FixtureTarget['key'];
  readonly targetSubreddit: string;
  readonly actor: string;
  readonly claimedAt: string;
  readonly claimToken: string;
  readonly createdAt?: string;
  readonly fixturePostId?: string;
  readonly fixturePermalink?: string;
}

export interface CreateFixtureResult {
  readonly created: boolean;
  readonly duplicate?: boolean;
  readonly record?: FixtureRecord;
  readonly post?: FixtureCreatedPost;
}

export interface FixtureAuthorizationClient {
  getModerators(options: {
    subredditName: string;
    username: string;
    limit?: number;
    pageSize?: number;
  }): { all(): Promise<readonly unknown[]> };
  getUserByUsername(username: string): Promise<{ readonly isAdmin?: boolean } | undefined>;
}

/** An input error that can be shown directly to a moderator. */
export class FixtureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FixtureInputError';
  }
}

/** Return true only for the explicitly permitted source subreddit. */
export function isAllowedFixtureSourceSubreddit(
  subredditName: string | undefined
): boolean {
  return subredditName?.trim().toLowerCase() === FIXTURE_SOURCE_SUBREDDIT.toLowerCase();
}

/**
 * Check the current actor against Reddit's moderator listing. The menu's
 * `forUserType` is a visibility filter, so this check is defense in depth for
 * form replays and direct handler invocations.
 */
export async function isAuthorizedFixtureActor(
  reddit: FixtureAuthorizationClient,
  subredditName: string,
  actor: string
): Promise<boolean> {
  try {
    const moderators = await reddit
      .getModerators({
        subredditName,
        username: actor,
        limit: 1,
        pageSize: 1,
      })
      .all();
    return Array.isArray(moderators) && moderators.length > 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[fixture] moderator authorization failed: ${detail}`);
    return false;
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
    /^https?:\/\/(?:www\.|go\.|m\.)?twitch\.tv\/(?:[^/?#\s]+\/)?clip\/[A-Za-z0-9][A-Za-z0-9_-]*(?:[/?#]|$)/i.test(
      value
    );
  const kick =
    /^https?:\/\/(?:www\.)?kick\.com\/[\w-]+(?:\/clips\/clip_[A-Za-z0-9-]+|\/?\?(?:[^#&\s]*&)*clip=clip_[A-Za-z0-9-]+)(?:[/?#]|$)/i.test(
      value
    );
  return twitch || kick;
}

function compactTitle(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isRedditPostId(value: string): boolean {
  return /^t3_[A-Za-z0-9]+$/.test(value);
}

function isRedditPermalink(value: string): boolean {
  return /^(?:https?:\/\/(?:www\.)?reddit\.com)?\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/[^\s]*)?$/i.test(
    value
  );
}

function parseFixtureRecord(value: string | undefined): FixtureRecord | undefined {
  if (!value) return undefined;
  try {
    const record = JSON.parse(value) as Partial<FixtureRecord>;
    if (
      record.version === 1 &&
      (record.status === 'pending' || record.status === 'created') &&
      typeof record.sourceId === 'string' &&
      typeof record.sourcePermalink === 'string' &&
      typeof record.targetKey === 'string' &&
      typeof record.targetSubreddit === 'string' &&
      typeof record.actor === 'string' &&
      typeof record.claimedAt === 'string' &&
      typeof record.claimToken === 'string'
    ) {
      return record as FixtureRecord;
    }
  } catch {
    // An old/corrupt key is treated as an occupied claim, not overwritten.
  }
  return undefined;
}

/**
 * Build a metadata record for the generated fixture. It is persisted in
 * global Redis so duplicate presses can be audited without a comment.
 */
export function fixtureRecord(
  source: FixtureSourcePost,
  target: FixtureTarget,
  actor: string,
  claimToken: string,
  post?: FixtureCreatedPost,
  claimedAt = new Date().toISOString()
): FixtureRecord {
  const now = new Date().toISOString();
  return {
    version: 1,
    status: post ? 'created' : 'pending',
    sourceId: source.id.trim(),
    sourcePermalink: source.permalink.trim(),
    targetKey: target.key,
    targetSubreddit: target.subreddit,
    actor,
    claimedAt,
    claimToken,
    ...(post
      ? {
          createdAt: now,
          fixturePostId: post.id,
          fixturePermalink: post.permalink,
        }
      : {}),
  };
}

/**
 * Build a bounded ordinary link-post payload.
 *
 * The source ID and permalink are carried in the bounded title for
 * traceability. The submitted `url` is left untouched for the detector.
 */
export function buildFixturePost(
  source: FixtureSourcePost,
  target: FixtureTarget
): FixturePost {
  if (!isFixtureTarget(target)) {
    throw new FixtureInputError('The fixture target is not an allowed test subreddit.');
  }
  const sourceId = source.id.trim();
  const sourcePermalink = source.permalink.trim();
  if (!isRedditPostId(sourceId) || !isRedditPermalink(sourcePermalink)) {
    throw new FixtureInputError('The source post has invalid Reddit traceability data.');
  }
  const sourceUrl = source.url.trim();
  if (!isClipUrl(sourceUrl)) {
    throw new FixtureInputError(
      'The source post does not contain a Twitch or Kick clip URL.'
    );
  }

  const trace = `source:${sourceId} ${sourcePermalink}`;
  const prefix = `${target.titlePrefix} `;
  const separator = ' — ';
  const available = 300 - prefix.length - separator.length - trace.length;
  if (available < 0) {
    throw new FixtureInputError('The source traceability data is too long.');
  }
  const sourceTitle = compactTitle(source.title);
  const titlePart = sourceTitle.slice(0, available).trim();
  const title = `${prefix}${titlePart}${separator}${trace}`;

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
 * Claim, submit, and persist metadata. Pending claims have a short lease so
 * a process dying between claim and submission does not permanently block a
 * later explicit retry.
 */
export async function createFixture(
  options: CreateFixtureOptions
): Promise<CreateFixtureResult> {
  const actor = requireFixtureActor(options.actor);
  const post = buildFixturePost(options.source, options.target);
  const key = fixtureDedupeKey(options.source.id.trim(), options.target);
  const claimToken = `${actor}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const pending = fixtureRecord(
    options.source,
    options.target,
    actor,
    claimToken
  );
  const serializedPending = JSON.stringify(pending);
  const claim = await options.dedupe.set(key, serializedPending, {
    nx: true,
    expiration: new Date(Date.now() + 10 * 60 * 1000),
  });
  // SET NX succeeds only with the exact Redis `OK` reply. Any other
  // response is ambiguous and must not cross the Reddit submission boundary.
  if (claim !== 'OK') {
    return {
      created: false,
      duplicate: true,
      record: parseFixtureRecord(await options.dedupe.get(key)),
    };
  }

  let created: FixtureCreatedPost;
  try {
    created = await options.reddit.submitPost(post);
  } catch (error) {
    try {
      // Do not delete a replacement claim if this request outlives its lease.
      if ((await options.dedupe.get(key)) === serializedPending) {
        await options.dedupe.del(key);
      }
    } catch (releaseError) {
      console.error('[fixture] failed to release dedupe claim', releaseError);
    }
    throw error;
  }

  const completed = fixtureRecord(
    options.source,
    options.target,
    actor,
    claimToken,
    created,
    pending.claimedAt
  );
  try {
    // This durable app metadata records source ID/permalink, actor, target,
    // and created post ID/permalink without changing the link-post URL.
    if ((await options.dedupe.get(key)) === serializedPending) {
      await options.dedupe.set(key, JSON.stringify(completed), { xx: true });
    } else {
      console.error('[fixture] claim changed before metadata was persisted');
    }
  } catch (recordError) {
    console.error('[fixture] created post metadata could not be persisted', recordError);
  }
  return { created: true, post: created, record: completed };
}
