/** Best-effort Reddit wiki backup for finalized escalation history rows. */

import {
  type ModActionRecord,
  type RedisLeaseStore,
  type RedisSetOptions,
} from './history.js';
import { releaseUserActionLock, type UserActionLock } from './user-lock.js';

/** Reddit's hard wiki-page content limit, measured in UTF-8 bytes. */
export const HISTORY_MIRROR_MAX_PAGE_BYTES = 524_288;
/** Keep a comfortable margin below Reddit's hard wiki-page limit. */
export const HISTORY_MIRROR_ROTATION_BYTES = 450 * 1024;
export const HISTORY_MIRROR_PAGE_PREFIX = 'escalation-log';
export const HISTORY_MIRROR_ACTIVE_PAGE_KEY = 'modactions:wiki:escalation-log:active';
export const HISTORY_MIRROR_LOCK_KEY = 'modactions:wiki:escalation-log:lock';

const LOCK_ATTEMPTS = 10;
const LOCK_RETRY_MS = 25;
const PAGE_NAME_PATTERN = new RegExp(`^${HISTORY_MIRROR_PAGE_PREFIX}/(\\d{4}-\\d{2})(?:-(\\d+))?$`);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export interface HistoryMirrorDeps {
  readonly redis: RedisLeaseStore;
  readonly getWikiPage: (subredditName: string, page: string) => Promise<string | undefined>;
  readonly updateWikiPage: (
    subredditName: string,
    page: string,
    content: string
  ) => Promise<void>;
  /** Set the page to unlisted and moderator-only before writing its content. */
  readonly setWikiPageSettings: (subredditName: string, page: string) => Promise<void>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Injectable only so lock-ownership races can be deterministic in tests. */
  readonly tokenGenerator?: () => string;
}

export interface MirrorAppendInput {
  readonly subredditName: string;
  readonly username: string;
  readonly record: ModActionRecord;
}

interface MirrorLock extends UserActionLock {}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function monthPageName(at: number): string {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${HISTORY_MIRROR_PAGE_PREFIX}/${year}-${month}`;
}

function pageMonth(page: string): string | undefined {
  const match = page.match(PAGE_NAME_PATTERN);
  return match?.[1];
}

function nextRotatedPage(page: string): string {
  const match = page.match(PAGE_NAME_PATTERN);
  if (!match) return `${HISTORY_MIRROR_PAGE_PREFIX}/archive-2`;
  const nextIndex = (match[2] ? Number(match[2]) : 1) + 1;
  return `${HISTORY_MIRROR_PAGE_PREFIX}/${match[1]}-${nextIndex}`;
}

/**
 * JSONL keeps every record on one parseable line while avoiding delimiter
 * escaping rules. The username is a top-level field so consumers can group
 * rows without knowing the Redis key layout.
 */
export function serializeMirrorLine(username: string, record: ModActionRecord): string {
  return `${JSON.stringify({ username: normalizeUsername(username), ...record })}\n`;
}

async function acquireMirrorLock(
  deps: HistoryMirrorDeps,
  now: () => number
): Promise<MirrorLock | undefined> {
  const token = `history-mirror:${now()}:${(deps.tokenGenerator ?? (() => crypto.randomUUID()))()}`;
  // This lock intentionally has no expiry. A wiki read or write can outlive
  // any practical lease, and expiry would let a stale writer overwrite a
  // newer append. Ownership is checked again immediately before every wiki or
  // pointer mutation, and releaseUserActionLock compare-deletes the token.
  const options: RedisSetOptions = { nx: true };
  const sleep = deps.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const result = await deps.redis.set(HISTORY_MIRROR_LOCK_KEY, token, options);
    if (result === 'OK') return { key: HISTORY_MIRROR_LOCK_KEY, token };
    if (attempt + 1 < LOCK_ATTEMPTS) await sleep(LOCK_RETRY_MS);
  }
  return undefined;
}

async function assertMirrorLockHeld(
  deps: HistoryMirrorDeps,
  lock: MirrorLock
): Promise<void> {
  const current = await deps.redis.get(lock.key);
  if (current !== lock.token) {
    throw new Error('wiki append lock was lost before the next mutation');
  }
}

function activePageFor(active: string | undefined, recordAt: number): string {
  const requestedPage = monthPageName(recordAt);
  const requestedMonth = pageMonth(requestedPage);
  const activeMonth = active ? pageMonth(active) : undefined;
  if (!active || !requestedMonth || !activeMonth) return requestedPage;
  // A late reconciliation must never reopen an older month or rotated page;
  // append it to the current active page. Newer action months start a new page.
  if (requestedMonth < activeMonth) return active;
  if (requestedMonth > activeMonth) return requestedPage;
  return active;
}

/**
 * Append one finalized action to the moderator-only wiki mirror. This is
 * intentionally best effort: Redis history remains authoritative and every
 * error is logged rather than returned to the moderation flow.
 */
export async function mirrorAppend(
  deps: HistoryMirrorDeps,
  input: MirrorAppendInput
): Promise<void> {
  if (input.record.state === 'pending') {
    console.error(`[history-mirror] refused pending record ${input.record.id}`);
    return;
  }

  const now = deps.now ?? Date.now;
  let lock: MirrorLock | undefined;
  try {
    lock = await acquireMirrorLock(deps, now);
    if (!lock) {
      console.error('[history-mirror] could not acquire wiki append lock; backup skipped');
      return;
    }

    const active = await deps.redis.get(HISTORY_MIRROR_ACTIVE_PAGE_KEY);
    await assertMirrorLockHeld(deps, lock);
    let page = activePageFor(active, input.record.at);
    const line = serializeMirrorLine(input.username, input.record);
    let existing = await deps.getWikiPage(input.subredditName, page);
    await assertMirrorLockHeld(deps, lock);
    let content = existing ?? '';
    let lineToAppend = content !== '' && !content.endsWith('\n') ? `\n${line}` : line;
    while (utf8Bytes(content + lineToAppend) > HISTORY_MIRROR_ROTATION_BYTES) {
      page = nextRotatedPage(page);
      existing = await deps.getWikiPage(input.subredditName, page);
      await assertMirrorLockHeld(deps, lock);
      content = existing ?? '';
      lineToAppend = content !== '' && !content.endsWith('\n') ? `\n${line}` : line;
      if (content === '' && utf8Bytes(lineToAppend) > HISTORY_MIRROR_ROTATION_BYTES) {
        throw new Error(`serialized record exceeds wiki rotation budget for ${page}`);
      }
    }

    const next = content + lineToAppend;
    if (utf8Bytes(next) > HISTORY_MIRROR_MAX_PAGE_BYTES) {
      throw new Error(`serialized record exceeds wiki page limit for ${page}`);
    }

    // updateWikiPage creates a missing page, so configure it first. If the
    // settings call fails, no real content is written to a public page.
    await assertMirrorLockHeld(deps, lock);
    await deps.setWikiPageSettings(input.subredditName, page);
    await assertMirrorLockHeld(deps, lock);
    await deps.updateWikiPage(input.subredditName, page, next);
    await assertMirrorLockHeld(deps, lock);
    await deps.redis.set(HISTORY_MIRROR_ACTIVE_PAGE_KEY, page);
  } catch (error) {
    console.error(`[history-mirror] append failed: ${detailOf(error)}`);
  } finally {
    if (lock) await releaseUserActionLock(deps.redis, lock, 'history-mirror');
  }
}
