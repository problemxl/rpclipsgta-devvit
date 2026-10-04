/** Shared per-user Redis lock for every action that reads or mutates history. */

import type { RedisStringLike } from './history.js';

/** The lock is a lease so a crashed request cannot block a user forever. */
export const USER_ACTION_LOCK_TTL_MS = 30 * 1000;

export interface UserActionLock {
  readonly key: string;
  readonly token: string;
}

/** All history-changing actions for a user must use this exact key. */
export function userActionLockKey(username: string): string {
  return `punish:lock:${username.trim().toLowerCase()}`;
}

/** Acquire a per-user action lease, failing when another action owns it. */
export async function acquireUserActionLock(
  redis: RedisStringLike,
  username: string,
  owner: string,
  now: () => number = Date.now
): Promise<UserActionLock> {
  const key = userActionLockKey(username);
  const token = `${owner}:${now()}:${Math.random().toString(36).slice(2)}`;
  const result = await redis.set(key, token, {
    nx: true,
    expiration: new Date(Date.now() + USER_ACTION_LOCK_TTL_MS),
  });
  if (typeof result !== 'string') {
    throw new Error('punishment already in progress for this user');
  }
  return { key, token };
}

/** Release only a lock still owned by this request. */
export async function releaseUserActionLock(
  redis: RedisStringLike,
  lock: UserActionLock,
  logPrefix: string
): Promise<void> {
  try {
    const current = await redis.get(lock.key);
    if (current === lock.token) await redis.del(lock.key);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[${logPrefix}] failed to release punishment lock ${lock.key}: ${detail}`);
  }
}
