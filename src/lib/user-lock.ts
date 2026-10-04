/** Shared per-user Redis lock for every action that reads or mutates history. */

import type { RedisLeaseStore } from './history.js';

/**
 * This lock intentionally has no Redis expiry. A Reddit API call can outlive
 * any practical lease, and allowing takeover while that call is still running
 * would let two requests mutate one user's history concurrently. Recovery is
 * an explicit moderator operation (see forceReleaseUserActionLock), not an
 * automatic expiry that can create a stale-owner race.
 */

export interface UserActionLock {
  readonly key: string;
  readonly token: string;
}

/** All history-changing actions for a user must use this exact key. */
export function userActionLockKey(username: string): string {
  return `punish:lock:${username.trim().toLowerCase()}`;
}

/** Acquire a per-user action lock, failing when another action owns it. */
export async function acquireUserActionLock(
  redis: RedisLeaseStore,
  username: string,
  owner: string,
  now: () => number = Date.now
): Promise<UserActionLock> {
  const key = userActionLockKey(username);
  const token = `${owner}:${now()}:${Math.random().toString(36).slice(2)}`;
  // NX is the atomic acquisition primitive. Do not attach an expiry: a
  // bounded lease can expire during a Reddit call and permit a takeover while
  // the original request is still able to append or perform external work.
  const result = await redis.set(key, token, { nx: true });
  // The installed Devvit client returns an empty string (not undefined) when
  // SET NX is rejected; only the Redis success reply means we own the lock.
  if (result !== 'OK') {
    throw new Error('punishment already in progress for this user');
  }
  return { key, token };
}

/**
 * Verify ownership immediately before a history mutation or Reddit call.
 * Recovery is intentionally observable: an in-flight request fails closed
 * rather than continuing after an operator has invalidated its lock.
 */
export async function assertUserActionLockHeld(
  redis: RedisLeaseStore,
  lock: UserActionLock
): Promise<void> {
  const current = await redis.get(lock.key);
  if (current !== lock.token) {
    throw new Error('punishment lock was lost before the action could continue');
  }
}

/**
 * Release only a lock still owned by this request.
 *
 * Devvit Redis has WATCH/MULTI/transaction commit, but no compare-and-delete
 * command or Lua API. WATCH protects the GET -> conditional DEL sequence: if
 * another writer changes the key after it is watched, the commit aborts and
 * this request cannot delete the new owner's token. A plain GET followed by
 * DEL is deliberately not used.
 */
export async function releaseUserActionLock(
  redis: RedisLeaseStore,
  lock: UserActionLock,
  logPrefix: string
): Promise<void> {
  try {
    const transaction = await redis.watch(lock.key);
    const current = await redis.get(lock.key);
    if (current !== lock.token) {
      await transaction.discard();
      return;
    }

    // WATCH is established before the GET above. Devvit's transaction
    // wrapper exposes the normal Redis optimistic-concurrency contract: any
    // change to the watched key causes the commit to abort.
    await transaction.multi();
    await transaction.del(lock.key);
    const commit = transaction as Record<string, () => Promise<unknown[] | undefined>>;
    const result = await commit['exec']();
    // A successful one-command transaction returns one reply. WATCH aborts
    // return no replies (the exact wrapper representation is runtime-specific).
    if (!result || result.length === 0) {
      console.warn(`[${logPrefix}] lock changed before release ${lock.key}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[${logPrefix}] failed to release punishment lock ${lock.key}: ${detail}`);
  }
}

/**
 * Explicit emergency recovery for a lock whose owner is known to be dead.
 * This is intentionally unconditional and must never be used automatically:
 * an operator must first verify that no request for the user is running.
 */
export async function forceReleaseUserActionLock(
  redis: Pick<RedisLeaseStore, 'del'>,
  username: string
): Promise<void> {
  await redis.del(userActionLockKey(username));
}
