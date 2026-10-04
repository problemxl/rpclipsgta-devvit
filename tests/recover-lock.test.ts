import { describe, expect, it, vi } from 'vitest';

import {
  buildLockRecoveryToast,
  recoverUserActionLock,
} from '../src/actions/recover-lock.js';
import { userActionLockKey } from '../src/lib/user-lock.js';

class FakeRedis {
  readonly values = new Map<string, string>();
  delCalls: string[] = [];
  failDelete = false;

  async del(key: string): Promise<void> {
    this.delCalls.push(key);
    if (this.failDelete) throw new Error('redis unavailable');
    this.values.delete(key);
  }
}

function input(overrides: Partial<Parameters<typeof recoverUserActionLock>[1]> = {}) {
  return {
    subredditName: 'S17Cjn21GT',
    actor: 'TestModerator',
    username: 'Ladder_User',
    confirm: true,
    ...overrides,
  };
}

describe('recoverUserActionLock', () => {
  it('requires moderator authorization before deleting the lock', async () => {
    const redis = new FakeRedis();
    redis.values.set(userActionLockKey('ladder_user'), 'owner');
    const authorizeActor = vi.fn(async () => false);

    await expect(
      recoverUserActionLock({ redis, authorizeActor }, input())
    ).resolves.toEqual({ status: 'denied', detail: 'acting user is not a moderator' });
    expect(authorizeActor).toHaveBeenCalledWith('S17Cjn21GT', 'TestModerator');
    expect(redis.delCalls).toEqual([]);
  });

  it('requires explicit confirmation and never silently recovers a lock', async () => {
    const redis = new FakeRedis();
    redis.values.set(userActionLockKey('ladder_user'), 'owner');

    await expect(
      recoverUserActionLock({ redis, authorizeActor: async () => true }, input({ confirm: false }))
    ).resolves.toEqual({
      status: 'invalid',
      detail: 'confirm that no action for this user is still running',
    });
    expect(redis.delCalls).toEqual([]);
  });

  it('deletes only the normalized user lock after authorized confirmation', async () => {
    const redis = new FakeRedis();
    redis.values.set(userActionLockKey('ladder_user'), 'dead-owner');

    await expect(
      recoverUserActionLock({ redis, authorizeActor: async () => true }, input())
    ).resolves.toEqual({ status: 'recovered', username: 'ladder_user' });
    expect(redis.delCalls).toEqual([userActionLockKey('ladder_user')]);
    expect(redis.values.has(userActionLockKey('ladder_user'))).toBe(false);
  });

  it('reports delete failures without claiming recovery', async () => {
    const redis = new FakeRedis();
    redis.failDelete = true;

    await expect(
      recoverUserActionLock({ redis, authorizeActor: async () => true }, input())
    ).resolves.toMatchObject({ status: 'failed', detail: 'lock may still be held: redis unavailable' });
  });
});

describe('buildLockRecoveryToast', () => {
  it('warns the operator that recovery is an emergency action', () => {
    expect(
      buildLockRecoveryToast({ status: 'recovered', username: 'ladder_user' })
    ).toBe('Recovered the action lock for u/ladder_user; verify no action is still running');
  });
});
