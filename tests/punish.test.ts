import { describe, expect, it, vi } from 'vitest';

import { punish, punishLockKey, buildWarningComment, type PunishDeps } from '../src/actions/punish.js';
import {
  acquireUserActionLock,
  releaseUserActionLock,
} from '../src/lib/user-lock.js';
import {
  createHistoryStore,
  historyKey,
  type ModActionRecord,
  type RedisLeaseTransaction,
  type RedisLike,
  type RedisSetOptions,
  type RedisStringLike,
} from '../src/lib/history.js';

const NOW = 1_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

/** String commands for the lock plus sorted sets for history, like context.redis. */
type FakeRedisShape = RedisStringLike & RedisLike & {
  watch(...keys: string[]): Promise<RedisLeaseTransaction>;
};

/** Structural Redis double: real NX/XX strings, a real sorted set, call recording. */
class FakeRedis implements FakeRedisShape {
  readonly values = new Map<string, string>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly setCalls: Array<{ key: string; value: string; options?: RedisSetOptions }> = [];
  readonly delCalls: string[] = [];
  discardCalls = 0;
  failMulti = false;
  failExec = false;
  failDiscard = false;
  onGet?: (key: string) => void;
  /** Overrides the ZADD resolution; 0 simulates a write that did not land. */
  zAddResult: number | undefined;

  async get(key: string): Promise<string | undefined> {
    const value = this.values.get(key);
    this.onGet?.(key);
    return value;
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions
  ): Promise<string | undefined> {
    this.setCalls.push({ key, value, options });
    if (options?.nx && this.values.has(key)) return undefined;
    if (options?.xx && !this.values.has(key)) return undefined;
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<void> {
    this.delCalls.push(key);
    this.values.delete(key);
  }

  async watch(...keys: string[]): Promise<RedisLeaseTransaction> {
    const snapshot = new Map(keys.map((key) => [key, this.values.get(key)]));
    const redis = this;
    let deletion: string[] = [];
    let zrem: Array<{ key: string; members: string[] }> = [];
    let zadd: Array<{ key: string; members: { member: string; score: number }[] }> = [];
    let multiStarted = false;
    const transaction: RedisLeaseTransaction = {
      async multi() {
        if (redis.failMulti) throw new Error('multi failed');
        multiStarted = true;
      },
      async del(...names: string[]) {
        deletion = names;
        return transaction;
      },
      async zRem(key: string, members: string[]) {
        zrem.push({ key, members });
        return transaction;
      },
      async zAdd(key: string, ...members: { member: string; score: number }[]) {
        zadd.push({ key, members });
        return transaction;
      },
      async exec() {
        if (redis.failExec) throw new Error('exec failed');
        if (!multiStarted) throw new Error('multi required');
        for (const key of keys) {
          if (redis.values.get(key) !== snapshot.get(key)) return [];
        }
        for (const key of deletion) await redis.del(key);
        for (const operation of zrem) await redis.zRem(operation.key, operation.members);
        for (const operation of zadd) await redis.zAdd(operation.key, ...operation.members);
        return [...deletion, ...zrem, ...zadd].map(() => 'OK');
      },
      async discard() {
        redis.discardCalls += 1;
        if (redis.failDiscard) throw new Error('discard failed');
        deletion = [];
      },
    };
    return transaction;
  }

  async zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number> {
    if (this.zAddResult !== undefined) return this.zAddResult;
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this.zsets.set(key, zset);
    }
    let added = 0;
    for (const { member, score } of members) {
      if (!zset.has(member)) added += 1;
      zset.set(member, score);
    }
    return added;
  }

  async zRange(
    key: string,
    start: number,
    stop: number
  ): Promise<{ member: string; score: number }[]> {
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    // Score-ascending, ties lexicographic — like redis.
    const ordered = [...zset.entries()].sort(
      ([aMember, aScore], [bMember, bScore]) =>
        aScore - bScore || (aMember < bMember ? -1 : aMember > bMember ? 1 : 0)
    );
    const from = Math.max(0, start < 0 ? ordered.length + start : start);
    const to = stop < 0 ? ordered.length + stop : stop;
    return ordered.slice(from, to + 1).map(([member, score]) => ({ member, score }));
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) removed += 1;
    }
    return removed;
  }

  async zCard(key: string): Promise<number> {
    return this.zsets.get(key)?.size ?? 0;
  }

  /** Seed one prior infraction row at a chosen timestamp; returns the record. */
  seedPrior(username: string, at: number, index = 0): ModActionRecord {
    const row: ModActionRecord = {
      id: `seed-${at}-${index}`,
      at,
      rule: 1,
      action: 'warn',
      label: 'Warning',
      modUser: 'old',
      targetThingId: 't3_old',
    };
    this.zAdd(historyKey(username), { member: JSON.stringify(row), score: at });
    return row;
  }

  lockCalls(): Array<{ key: string; value: string; options?: RedisSetOptions }> {
    return this.setCalls.filter((call) => call.key.startsWith('punish:lock:'));
  }
}

function deps(overrides: Partial<PunishDeps> = {}, redis = new FakeRedis()): PunishDeps {
  return {
    history: createHistoryStore(redis),
    redis,
    submitComment: vi.fn(async () => 't1_warning'),
    banUser: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  };
}

const input = {
  targetUser: 'Target', targetThingId: 't3_post', subredditName: 'RPClipsGTA',
  rule: 2, reason: 'toxic chat', modUser: 'Mod',
};

describe('punish', () => {
  it('warns a fresh user, submits expected text, and records the action', async () => {
    const current = deps();
    const result = await punish(current, input);
    expect(result).toMatchObject({ action: 'warn', label: 'Warning', priors: 0, recorded: true });
    expect(current.submitComment).toHaveBeenCalledWith(expect.objectContaining({
      replyTargetThingId: 't3_post',
      text: expect.stringContaining('R2 — Toxicity'),
    }));
    expect(current.banUser).not.toHaveBeenCalled();
  });

  it('bans after one recent prior with a three-day duration', async () => {
    const redis = new FakeRedis();
    redis.seedPrior('Target', NOW - 1);
    const current = deps({}, redis);
    await punish(current, input);
    expect(current.banUser).toHaveBeenCalledWith(expect.objectContaining({
      durationDays: 3,
      subredditName: 'RPClipsGTA',
      reason: 'R2 — Toxicity',
      note: '[devvit] by Mod',
      message: expect.stringContaining('3 day ban'),
    }));
    expect(current.submitComment).not.toHaveBeenCalled();
  });

  it('omits duration for a permanent ban', async () => {
    const redis = new FakeRedis();
    for (let index = 0; index < 5; index += 1) redis.seedPrior('Target', NOW - index - 1, index);
    const current = deps({}, redis);
    await punish(current, input);
    expect(current.banUser).toHaveBeenCalledWith(expect.not.objectContaining({ durationDays: expect.anything() }));
  });

  it('escalates two, three, and four priors to 7, 14, and 30 day bans', async () => {
    for (const [priors, durationDays] of [[2, 7], [3, 14], [4, 30]] as const) {
      const redis = new FakeRedis();
      for (let index = 0; index < priors; index += 1) redis.seedPrior('Target', NOW - index - 1, index);
      const current = deps({}, redis);
      await expect(punish(current, input)).resolves.toMatchObject({
        action: 'ban',
        durationDays,
        label: `${durationDays} day ban`,
        priors,
      });
      expect(current.banUser).toHaveBeenCalledWith(expect.objectContaining({ durationDays }));
      expect(current.submitComment).not.toHaveBeenCalled();
    }
  });

  it('replies to a t1 comment target when warning', async () => {
    const current = deps();
    await punish(current, { ...input, targetThingId: 't1_comment123' });
    expect(current.submitComment).toHaveBeenCalledWith(
      expect.objectContaining({ replyTargetThingId: 't1_comment123' })
    );
  });

  it('keeps full lifetime history but warns again when every prior has decayed', async () => {
    // Three priors whose newest is five years old: all rows are retained
    // forever, but ~20 decayed levels floor the effective count at zero.
    const redis = new FakeRedis();
    for (let index = 0; index < 3; index += 1) redis.seedPrior('Target', NOW - 5 * 365 * DAY - index, index);
    const current = deps({}, redis);
    await expect(punish(current, input)).resolves.toMatchObject({
      action: 'warn',
      label: 'Warning',
      priors: 0,
    });
    expect(current.submitComment).toHaveBeenCalled();
    expect(current.banUser).not.toHaveBeenCalled();
    expect(await current.history.load('Target')).toHaveLength(4); // 3 kept + this one
    expect((await current.history.load('Target')).at(-1)?.state).toBeUndefined();
  });

  it('still sees a 400-day-old prior through full retention', async () => {
    // Five priors whose newest is 400 days old: four decayed levels leave one
    // effective prior, so the user receives a 3 day ban — not a warning.
    const redis = new FakeRedis();
    for (let index = 0; index < 5; index += 1) redis.seedPrior('Target', NOW - 400 * DAY - index, index);
    const current = deps({}, redis);
    await expect(punish(current, input)).resolves.toMatchObject({
      action: 'ban',
      durationDays: 3,
      priors: 1,
    });
    expect(current.banUser).toHaveBeenCalled();
    expect(current.submitComment).not.toHaveBeenCalled();
  });

  it('decays a seven-month-old prior back to a warning', async () => {
    const redis = new FakeRedis();
    redis.seedPrior('Target', NOW - 7 * MONTH);
    const current = deps({}, redis);
    await expect(punish(current, input)).resolves.toMatchObject({ action: 'warn', priors: 0 });
    expect(current.submitComment).toHaveBeenCalled();
  });

  it('fails closed when strict history cannot be read', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    vi.spyOn(history, 'summaryStrict').mockResolvedValue({ ok: false });
    const submitComment = vi.fn(async () => 'unreachable');
    const current = deps({ redis, history, submitComment });

    await expect(punish(current, input)).rejects.toThrow(
      'could not read action history; no Reddit action was attempted'
    );
    expect(submitComment).not.toHaveBeenCalled();
    expect(await history.load('Target')).toEqual([]);
  });

  it('blocks retry while an unresolved pending action exists', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    await history.append('Target', {
      at: NOW,
      rule: 2,
      action: 'warn',
      label: 'Warning',
      modUser: 'Mod',
      targetThingId: 't3_post',
      state: 'pending',
    });
    const submitComment = vi.fn(async () => 'unreachable');
    await expect(punish(deps({ redis, history, submitComment }), input)).rejects.toThrow(
      'unresolved outcome; reconcile it before retrying'
    );
    expect(submitComment).not.toHaveBeenCalled();
  });

  it('continues without a record when ZADD resolves 0', async () => {
    const redis = new FakeRedis();
    redis.zAddResult = 0;
    const current = deps({}, redis);
    await expect(punish(current, input)).resolves.toMatchObject({ recorded: false, action: 'warn' });
    expect(current.submitComment).toHaveBeenCalled();
    expect(await current.history.load('Target')).toEqual([]);
  });

  it('continues without a record when the history append throws', async () => {
    const failingHistory = {
      summary: async () => ({ total: 0, latestAt: undefined as number | undefined }),
      summaryStrict: async () => ({
        ok: true as const,
        summary: { total: 0, latestAt: undefined as number | undefined },
      }),
      append: async () => {
        throw new Error('append failed');
      },
      load: async () => [] as ModActionRecord[],
      loadStrict: async () => ({ ok: true as const, rows: [] as ModActionRecord[] }),
      remove: async () => false,
      removeOwned: async () => false,
      markApplied: async () => true,
      clear: async () => false,
    };
    const current = deps({ history: failingHistory });
    await expect(punish(current, input)).resolves.toMatchObject({ recorded: false, action: 'warn' });
    expect(current.submitComment).toHaveBeenCalled();
  });

  it('propagates comment execution failures', async () => {
    const current = deps({ submitComment: vi.fn(async () => { throw new Error('comment failed'); }) });
    await expect(punish(current, input)).rejects.toThrow('comment failed');
  });

  it('refuses a ban before banUser when the subreddit name is empty', async () => {
    const redis = new FakeRedis();
    redis.seedPrior('Target', NOW - 1);
    const current = deps({}, redis);
    await expect(punish(current, { ...input, subredditName: '' })).rejects.toThrow(
      'cannot apply a ban without a subreddit name'
    );
    expect(current.banUser).not.toHaveBeenCalled();
    expect(current.submitComment).not.toHaveBeenCalled();
    expect(await current.history.load('Target')).toHaveLength(1); // nothing appended
  });
});

describe('punish lock', () => {
  it('serializes concurrent punishments and releases the lock afterwards', async () => {
    const redis = new FakeRedis();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const history = createHistoryStore(redis);
    const current = deps({
      redis,
      history,
      submitComment: async () => {
        await gate;
        return 't1_warning';
      },
    });

    const first = punish(current, input);
    await vi.waitFor(() => expect(redis.values.has(punishLockKey('Target'))).toBe(true));

    // The second punish cannot acquire the per-user lock while the first holds it.
    await expect(punish(current, input)).rejects.toThrow('punishment already in progress');

    release();
    await expect(first).resolves.toMatchObject({ action: 'warn', recorded: true });
    expect(redis.values.has(punishLockKey('Target'))).toBe(false);

    // A follow-up punishment acquires the released lock and sees the new prior.
    await expect(punish(current, input)).resolves.toMatchObject({
      action: 'ban',
      durationDays: 3,
      priors: 1,
    });
    expect(await history.load('Target')).toHaveLength(2);
  });

  it('throws in progress without any writes when the lock is already held', async () => {
    const redis = new FakeRedis();
    redis.values.set(punishLockKey('Target'), '1');
    const history = createHistoryStore(redis);
    const append = vi.spyOn(history, 'append');
    const current = deps({ redis, history });

    await expect(punish(current, input)).rejects.toThrow('punishment already in progress');
    expect(current.submitComment).not.toHaveBeenCalled();
    expect(current.banUser).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(await history.load('Target')).toEqual([]);
    expect(redis.delCalls).toEqual([]); // never releases a lock it did not acquire
  });

  it('acquires a lowercased non-expiring lock with an owner token value, and releases it on success', async () => {
    const redis = new FakeRedis();
    const current = deps({ redis });

    await punish(current, input);

    const lockCalls = redis.lockCalls();
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0]).toMatchObject({ key: 'punish:lock:target' });
    // The value is a per-call owner token (mod user, timestamp, random suffix),
    // not a constant — release only deletes when the stored value matches it.
    expect(lockCalls[0].value).toMatch(/^Mod:\d+:[a-z0-9]+$/);
    expect(lockCalls[0].options?.nx).toBe(true);
    expect(lockCalls[0].options?.expiration).toBeUndefined();
    expect(redis.delCalls).toEqual(['punish:lock:target']);
  });

  it('releases by comparing the stored value against its own owner token', async () => {
    const redis = new FakeRedis();
    const current = deps({ redis });

    await expect(punish(current, input)).resolves.toMatchObject({ action: 'warn', commentId: 't1_warning' });

    // The lock held this call's token and the release deleted exactly that key.
    expect(redis.lockCalls()[0].value).toMatch(/^Mod:/);
    expect(redis.values.has(punishLockKey('Target'))).toBe(false);
    expect(redis.delCalls).toEqual(['punish:lock:target']);
  });

  it('fails closed when explicit recovery changes ownership before the Reddit call', async () => {
    const redis = new FakeRedis();
    const lockKey = punishLockKey('Target');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const submitComment = vi.fn(async () => {
      await gate;
      return 't1_warning';
    });
    const current = deps({
      redis,
      submitComment,
    });

    const pending = punish(current, input);
    await vi.waitFor(() => expect(redis.values.has(lockKey)).toBe(true));

    // Explicit recovery changes the owner before the Reddit call. The stale
    // request must not execute or mutate history after losing its lock.
    redis.values.set(lockKey, 'Other:999:secondcaller');

    release();
    await expect(pending).rejects.toThrow('punishment lock was lost');
    expect(submitComment).not.toHaveBeenCalled();
    expect(redis.values.get(lockKey)).toBe('Other:999:secondcaller');
  });

  it('does not delete a replacement owner when takeover happens between GET and EXEC', async () => {
    const redis = new FakeRedis();
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);
    let replaced = false;
    redis.onGet = (key) => {
      if (!replaced && key === lock.key) {
        replaced = true;
        redis.values.set(key, 'Other:999:replacement');
      }
    };

    await releaseUserActionLock(redis, lock, 'test');

    expect(redis.values.get(lock.key)).toBe('Other:999:replacement');
    expect(redis.delCalls).toEqual([]);
  });

  it('best-effort discards a watched transaction when MULTI fails', async () => {
    const redis = new FakeRedis();
    redis.failMulti = true;
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);

    await releaseUserActionLock(redis, lock, 'test');

    expect(redis.discardCalls).toBe(1);
    expect(redis.values.get(lock.key)).toBe(lock.token);
  });

  it('best-effort discards when EXEC fails', async () => {
    const redis = new FakeRedis();
    redis.failExec = true;
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);

    await expect(releaseUserActionLock(redis, lock, 'test')).resolves.toBeUndefined();

    expect(redis.discardCalls).toBe(1);
    expect(redis.values.get(lock.key)).toBe(lock.token);
  });

  it('does not mask a completed action when the conditional release transaction fails', async () => {
    class FailingReleaseRedis extends FakeRedis {
      override async watch(...keys: string[]): Promise<RedisLeaseTransaction> {
        if (keys.some((key) => key.startsWith('punish:lock:'))) {
          throw new Error('redis down on watch');
        }
        return super.watch(...keys);
      }
    }

    const redis = new FailingReleaseRedis();
    const current = deps({ redis });
    await expect(punish(current, input)).resolves.toMatchObject({ action: 'warn' });
  });

  it('releases the lock when execution fails', async () => {
    const redis = new FakeRedis();
    const current = deps({
      redis,
      submitComment: vi.fn(async () => {
        throw new Error('comment failed');
      }),
    });

    await expect(punish(current, input)).rejects.toThrow('comment failed');
    expect(redis.delCalls).toEqual(['punish:lock:target']);
  });
});

describe('punish compensation', () => {
  it('removes a pending row only while the owner token is still held', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    const pending = (await history.append('Target', {
      at: NOW,
      rule: 2,
      action: 'warn',
      label: 'Warning',
      modUser: 'Mod',
      targetThingId: 't3_post',
      state: 'pending',
    })).record;
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);

    await expect(history.removeOwned('Target', pending.id, {
      redis,
      key: lock.key,
      token: lock.token,
    })).resolves.toBe(true);
    expect(await history.load('Target')).toEqual([]);
    expect(redis.discardCalls).toBe(0);
    await releaseUserActionLock(redis, lock, 'test');
  });

  it('does not remove a pending row when ownership changes after WATCH and GET', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    const pending = (await history.append('Target', {
      at: NOW,
      rule: 2,
      action: 'warn',
      label: 'Warning',
      modUser: 'Mod',
      targetThingId: 't3_post',
      state: 'pending',
    })).record;
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);
    let replaced = false;
    redis.onGet = (key) => {
      if (!replaced && key === lock.key) {
        replaced = true;
        redis.values.set(key, 'Other:999:replacement');
      }
    };

    await expect(history.removeOwned('Target', pending.id, {
      redis,
      key: lock.key,
      token: lock.token,
    })).resolves.toBe(false);
    expect(await history.load('Target')).toEqual([pending]);
    expect(redis.values.get(lock.key)).toBe('Other:999:replacement');
    expect(redis.discardCalls).toBe(0);
  });

  it('retains a pending row when ownership is lost before fenced compensation', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    const pending = (await history.append('Target', {
      at: NOW,
      rule: 2,
      action: 'warn',
      label: 'Warning',
      modUser: 'Mod',
      targetThingId: 't3_post',
      state: 'pending',
    })).record;
    const lock = await acquireUserActionLock(redis, 'Target', 'Mod', () => NOW);
    redis.values.set(lock.key, 'Other:999:replacement');

    await expect(history.removeOwned('Target', pending.id, {
      redis,
      key: lock.key,
      token: lock.token,
    })).resolves.toBe(false);
    expect(await history.load('Target')).toEqual([pending]);
    expect(redis.discardCalls).toBe(1);
  });

  it('does not remove a pending row after ownership is lost before the Reddit call', async () => {
    const redis = new FakeRedis();
    const history = createHistoryStore(redis);
    const current = deps({
      redis,
      history,
      submitComment: vi.fn(async () => 'unreachable'),
    });
    const originalGet = redis.get.bind(redis);
    let gets = 0;
    redis.get = async (key: string) => {
      gets += 1;
      const value = await originalGet(key);
      // Replace the owner immediately after the final pre-call assertion.
      if (key === punishLockKey('Target') && gets === 2) {
        redis.values.set(key, 'Other:999:replacement');
      }
      return value;
    };

    await expect(punish(current, input)).rejects.toThrow('punishment lock was lost');
    expect(current.submitComment).not.toHaveBeenCalled();
    expect(await history.load('Target')).toHaveLength(1);
    expect(redis.values.get(punishLockKey('Target'))).toBe('Other:999:replacement');
  });

  it('blocks a retry after an ambiguous Reddit failure', async () => {
    const redis = new FakeRedis();
    redis.seedPrior('Target', NOW - 1);
    const history = createHistoryStore(redis);
    const first = deps({
      redis,
      history,
      banUser: vi.fn(async () => { throw new Error('timeout'); }),
    });
    await expect(punish(first, input)).rejects.toThrow('timeout');

    const retrySubmit = vi.fn(async () => 'should-not-run');
    await expect(punish(deps({ redis, history, submitComment: retrySubmit }), input)).rejects.toThrow(
      'unresolved outcome; reconcile it before retrying'
    );
    expect(retrySubmit).not.toHaveBeenCalled();
  });

  it('retains a pending row when Reddit failure has an unknown external outcome', async () => {
    const redis = new FakeRedis();
    const prior = redis.seedPrior('Target', NOW - DAY);
    const history = createHistoryStore(redis);
    const failing = deps({
      redis,
      history,
      banUser: vi.fn(async () => {
        throw new Error('ban failed');
      }),
    });

    // One prior ⇒ 3 day ban rung. Once the Reddit request starts, a failure
    // is ambiguous, so the pending row remains for manual reconciliation.
    await expect(punish(failing, input)).rejects.toThrow('ban failed');
    expect(await history.load('Target')).toHaveLength(2);
    expect(await history.load('Target')).toEqual(
      expect.arrayContaining([prior, expect.objectContaining({ action: 'ban', label: '3 day ban' })])
    );
  });

  it('retains the pending row rather than mutating an identical older row', async () => {
    const redis = new FakeRedis();
    // Same at/rule/action/label/modUser/target as the pending row will get;
    // only the id differs. Field-matching compensation would remove it.
    const stale: ModActionRecord = {
      id: 'stale', at: NOW, rule: 2, action: 'warn', label: 'Warning',
      modUser: 'Mod', targetThingId: 't3_post',
    };
    redis.zAdd(historyKey('Target'), { member: JSON.stringify(stale), score: NOW });
    const history = createHistoryStore(redis);
    const current = deps({
      redis,
      history,
      banUser: vi.fn(async () => {
        throw new Error('ban failed');
      }),
    });

    await expect(punish(current, input)).rejects.toThrow('ban failed');
    const rows = await current.history.load('Target');
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(['stale']));
    expect(rows).toHaveLength(2);
  });

  it('persists no record when banUser fails', async () => {
    const redis = new FakeRedis();
    const priors = [redis.seedPrior('Target', NOW - 1, 0), redis.seedPrior('Target', NOW - 2, 1)];
    const history = createHistoryStore(redis);
    const current = deps({
      redis,
      history,
      banUser: vi.fn(async () => {
        throw new Error('ban refused');
      }),
    });

    await expect(punish(current, input)).rejects.toThrow('ban refused');
    const rows = await history.load('Target');
    // Both original rows and the ambiguous pending marker remain.
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(priors.map((prior) => prior.id))
    );
  });
});

describe('buildWarningComment', () => {
  it('includes reason, rules link, and next-rung wording', () => {
    const text = buildWarningComment({ targetUser: 'u', rule: 2, ruleName: 'Toxicity', reason: 'be kind', rung: 'Warning' });
    expect(text).toContain('be kind');
    expect(text).toContain('https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/');
    expect(text).toContain('next violation may result in a **3 day ban**');
  });

  it('handles an empty reason and the permanent next-rung boundary', () => {
    const text = buildWarningComment({ targetUser: 'u', rule: 2, ruleName: 'Toxicity', reason: '', rung: 'Permanent ban' });
    expect(text).not.toContain('**Reason:**');
    expect(text).toContain('**Permanent ban**');
  });
});
