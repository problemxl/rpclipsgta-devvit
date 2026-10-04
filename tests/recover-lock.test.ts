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

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.delCalls.push(key);
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

  it('fails closed and does not mutate a lock even after confirmation', async () => {
    const redis = new FakeRedis();
    redis.values.set(userActionLockKey('ladder_user'), 'dead-owner');

    await expect(
      recoverUserActionLock({ redis, authorizeActor: async () => true }, input())
    ).resolves.toEqual({
      status: 'disabled',
      detail: 'in-app recovery is disabled; follow the manual quiescence procedure in the runbook',
    });
    expect(redis.values.get(userActionLockKey('ladder_user'))).toBe('dead-owner');
  });
});

describe('buildLockRecoveryToast', () => {
  it('warns the operator that in-app recovery is disabled', () => {
    expect(
      buildLockRecoveryToast({
        status: 'disabled',
        detail: 'follow the manual quiescence procedure',
      })
    ).toBe('Lock recovery disabled: follow the manual quiescence procedure');
  });
});
