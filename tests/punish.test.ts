import { describe, expect, it, vi } from 'vitest';

import { punish, punishLockKey, buildWarningComment, type PunishDeps } from '../src/actions/punish.js';
import type {
  HistoryStore,
  ModActionRecord,
  RedisLike,
  RedisSetOptions,
} from '../src/lib/history.js';

const NOW = 1_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;

/** In-memory HistoryStore with compensation support and inspectable records. */
function memoryHistory(initial: ModActionRecord[] = []): HistoryStore & {
  records: ModActionRecord[];
} {
  const records = [...initial];
  const sameRecord = (left: ModActionRecord, right: ModActionRecord): boolean =>
    left.at === right.at &&
    left.rule === right.rule &&
    left.action === right.action &&
    left.label === right.label &&
    left.modUser === right.modUser &&
    left.targetThingId === right.targetThingId;
  return {
    records,
    load: async () => [...records],
    append: async (_username, record) => {
      records.push(record);
      return true;
    },
    remove: async (_username, record) => {
      const index = records.findIndex((candidate) => sameRecord(candidate, record));
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
  };
}

/** Structural Redis double with real NX/XX semantics and call recording. */
class FakeRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; value: string; options?: RedisSetOptions }> = [];
  readonly delCalls: string[] = [];

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
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

  lockCalls(): Array<{ key: string; value: string; options?: RedisSetOptions }> {
    return this.setCalls.filter((call) => call.key.startsWith('punish:lock:'));
  }
}

function deps(overrides: Partial<PunishDeps> = {}, initial: ModActionRecord[] = []): PunishDeps {
  return {
    history: memoryHistory(initial),
    redis: new FakeRedis(),
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

function inputRecord(at: number): ModActionRecord {
  return { at, rule: 1, action: 'warn', label: 'Warning', modUser: 'old', targetThingId: 't3_old' };
}

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
    const current = deps({}, [{ ...inputRecord(1), at: NOW - 1 }]);
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
    const current = deps({}, Array.from({ length: 5 }, (_, index) => inputRecord(NOW - index - 1)));
    await punish(current, input);
    expect(current.banUser).toHaveBeenCalledWith(expect.not.objectContaining({ durationDays: expect.anything() }));
  });

  it('escalates two, three, and four priors to 7, 14, and 30 day bans', async () => {
    for (const [priors, durationDays] of [[2, 7], [3, 14], [4, 30]] as const) {
      const current = deps({}, Array.from({ length: priors }, (_, index) => inputRecord(NOW - index - 1)));
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

  it('still sees a ~400-day-old prior inside the 540-day retention window', async () => {
    // Five priors whose newest is 400 days old: 4 decayed levels leave one
    // effective prior, so the user receives a 3 day ban — not a warning.
    const priors = Array.from({ length: 5 }, (_, index) => inputRecord(NOW - 400 * DAY - index));
    const current = deps({}, priors);
    await expect(punish(current, input)).resolves.toMatchObject({
      action: 'ban',
      durationDays: 3,
      priors: 1,
    });
    expect(current.banUser).toHaveBeenCalled();
    expect(current.submitComment).not.toHaveBeenCalled();
  });

  it('decays a seven-month-old prior back to a warning', async () => {
    const current = deps({}, [{ ...inputRecord(NOW - 7 * MONTH) }]);
    await expect(punish(current, input)).resolves.toMatchObject({ action: 'warn', priors: 0 });
    expect(current.submitComment).toHaveBeenCalled();
  });

  it('continues after a history append failure', async () => {
    const current = deps({ history: { load: async () => [], append: async () => false } });
    await expect(punish(current, input)).resolves.toMatchObject({ recorded: false, action: 'warn' });
    expect(current.submitComment).toHaveBeenCalled();
  });

  it('propagates comment execution failures', async () => {
    const current = deps({ submitComment: vi.fn(async () => { throw new Error('comment failed'); }) });
    await expect(punish(current, input)).rejects.toThrow('comment failed');
  });

  it('refuses a ban before banUser when the subreddit name is empty', async () => {
    const history = memoryHistory([{ ...inputRecord(NOW - 1) }]);
    const current = deps({ history });
    await expect(punish(current, { ...input, subredditName: '' })).rejects.toThrow(
      'cannot apply a ban without a subreddit name'
    );
    expect(current.banUser).not.toHaveBeenCalled();
    expect(current.submitComment).not.toHaveBeenCalled();
    expect(history.records).toEqual([{ ...inputRecord(NOW - 1) }]); // nothing appended
  });
});

describe('punish lock', () => {
  it('serializes concurrent punishments and releases the lock afterwards', async () => {
    const redis = new FakeRedis();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const history = memoryHistory();
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
    expect(history.records).toHaveLength(2);
  });

  it('throws in progress without any writes when the lock is already held', async () => {
    const redis = new FakeRedis();
    redis.values.set(punishLockKey('Target'), '1');
    const history = memoryHistory();
    const append = vi.spyOn(history, 'append');
    const current = deps({ redis, history });

    await expect(punish(current, input)).rejects.toThrow('punishment already in progress');
    expect(current.submitComment).not.toHaveBeenCalled();
    expect(current.banUser).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    expect(history.records).toEqual([]);
    expect(redis.delCalls).toEqual([]); // never releases a lock it did not acquire
  });

  it('acquires a lowercased lock with a ~30s TTL and releases it on success', async () => {
    const redis = new FakeRedis();
    const current = deps({ redis });

    await punish(current, input);

    const lockCalls = redis.lockCalls();
    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0]).toMatchObject({ key: 'punish:lock:target', value: '1' });
    expect(lockCalls[0].options?.nx).toBe(true);
    const ttlMs = lockCalls[0].options?.expiration?.getTime();
    expect(ttlMs).toBeGreaterThan(Date.now() + 25 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(Date.now() + 30 * 1000);
    expect(redis.delCalls).toEqual(['punish:lock:target']);
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
  it('removes the pending record on execution failure so the next punish sees no prior', async () => {
    const prior = inputRecord(NOW - DAY);
    const history = memoryHistory([prior]);
    const failing = deps({
      history,
      banUser: vi.fn(async () => {
        throw new Error('ban failed');
      }),
    });

    // One prior ⇒ 3 day ban rung; the pending record is written first, then
    // compensated when the ban fails.
    await expect(punish(failing, input)).rejects.toThrow('ban failed');
    expect(history.records).toEqual([prior]);

    const retry = deps({ history });
    await expect(punish(retry, input)).resolves.toMatchObject({
      action: 'ban',
      durationDays: 3,
      priors: 1,
    });
  });

  it('persists no record when banUser fails', async () => {
    const priors = [inputRecord(NOW - 1), inputRecord(NOW - 2)];
    const history = memoryHistory(priors);
    const current = deps({
      history,
      banUser: vi.fn(async () => {
        throw new Error('ban refused');
      }),
    });

    await expect(punish(current, input)).rejects.toThrow('ban refused');
    expect(history.records).toEqual(priors);
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
