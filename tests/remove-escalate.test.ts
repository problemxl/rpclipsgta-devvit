import { describe, expect, it, vi } from 'vitest';

import {
  buildRemoveEscalateAlreadyProcessedToast,
  buildRemoveEscalateFailureToast,
  buildRemoveEscalateSuccessToast,
  runRemoveAndEscalate,
  runRemoveAndEscalateSafely,
  type AutoRedisSetOptions,
  type RemoveEscalateDeps,
  type RemoveEscalateInput,
  type RedisStringLike,
} from '../src/actions/autoescalate.js';
import type { PunishInput, PunishResult } from '../src/actions/punish.js';
import { RULES } from '../src/lib/rules.js';

const TOXICITY = RULES[1];
const WARN: PunishResult = {
  action: 'warn',
  durationDays: 0,
  label: 'Warning',
  commentId: 't1_warning',
  priors: 0,
  ruleName: 'Toxicity',
  recorded: true,
  finalized: true,
};
const BAN: PunishResult = {
  action: 'ban',
  durationDays: 3,
  label: '3 day ban',
  commentId: '',
  priors: 1,
  ruleName: 'Toxicity',
  recorded: true,
  finalized: true,
};

function input(overrides: Partial<RemoveEscalateInput> = {}): RemoveEscalateInput {
  return {
    thingId: 't3_abc123',
    authorName: 'poster',
    subredditName: 'RPClipsGTA',
    rule: 2,
    reason: 'toxic comment',
    modUser: 'acting-mod',
    ...overrides,
  };
}

class FakeRedis implements RedisStringLike {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  readonly calls: Array<{
    operation: 'get' | 'set' | 'del';
    key: string;
    value?: string;
    options?: AutoRedisSetOptions;
  }> = [];

  async get(key: string): Promise<string | undefined> {
    this.calls.push({ operation: 'get', key });
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.calls.push({ operation: 'del', key });
    this.values.delete(key);
  }

  async set(
    key: string,
    value: string,
    options?: AutoRedisSetOptions
  ): Promise<string | undefined> {
    this.calls.push({ operation: 'set', key, value, options });
    if (options?.nx && this.values.has(key)) return undefined;
    if (options?.xx && !this.values.has(key)) return undefined;
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return 'OK';
  }
}

class RejectingSetRedis extends FakeRedis {
  override async set(
    key: string,
    value: string,
    options?: AutoRedisSetOptions
  ): Promise<string | undefined> {
    this.calls.push({ operation: 'set', key, value, options });
    throw new Error('redis unavailable');
  }
}

function state(
  overrides: Partial<RemoveEscalateDeps> = {},
  redis = new FakeRedis()
): {
  redis: FakeRedis;
  removed: string[];
  punished: PunishInput[];
  deps: RemoveEscalateDeps;
} {
  const removed: string[] = [];
  const punished: PunishInput[] = [];
  const deps: RemoveEscalateDeps = {
    redis,
    removeThing: async (thingId) => {
      removed.push(thingId);
    },
    punish: async (punishInput) => {
      punished.push(punishInput);
      return WARN;
    },
    now: () => 1_000_000,
    ...overrides,
  };
  return { redis, removed, punished, deps };
}

const SEEN_KEY = 'removeescalate:seen:t3_abc123';

describe('remove & escalate toast builders', () => {
  it('describes a removal with a warning', () => {
    expect(
      buildRemoveEscalateSuccessToast({ result: WARN, targetUser: 'poster', rule: TOXICITY })
    ).toBe('Removed & warned u/poster (R2 — Toxicity)');
  });

  it('describes a removal with a ban', () => {
    expect(
      buildRemoveEscalateSuccessToast({ result: BAN, targetUser: 'poster', rule: TOXICITY })
    ).toBe('Removed & banned u/poster — 3 day ban');
  });

  it('marks actions whose history was not recorded', () => {
    expect(
      buildRemoveEscalateSuccessToast({
        result: { ...WARN, recorded: false, finalized: true },
        targetUser: 'poster',
        rule: TOXICITY,
      })
    ).toBe('Removed & warned u/poster (R2 — Toxicity) (not recorded)');
  });

  it('marks Reddit success with an unfinalized pending record prominently', () => {
    expect(buildRemoveEscalateSuccessToast({
      result: { ...WARN, finalized: false },
      targetUser: 'poster',
      rule: TOXICITY,
    })).toContain('[finalized:false]');
    expect(buildRemoveEscalateSuccessToast({
      result: { ...WARN, finalized: false },
      targetUser: 'poster',
      rule: TOXICITY,
    })).toContain('Do not retry');
  });

  it('reports already-processed presses', () => {
    expect(buildRemoveEscalateAlreadyProcessedToast()).toBe('Already processed by this action.');
  });

  it('points escalation failures at the Escalate menu', () => {
    expect(
      buildRemoveEscalateFailureToast({ status: 'escalate-failed', detail: 'service unavailable' })
    ).toBe(
      'Removed, but escalation failed: service unavailable. Use the Escalate menu to warn or ban the author.'
    );
  });

  it('keeps other failure details short', () => {
    expect(
      buildRemoveEscalateFailureToast({ status: 'remove-failed', detail: 'permission denied' })
    ).toBe('Remove & escalate failed: permission denied');
    expect(
      buildRemoveEscalateFailureToast({ status: 'invalid', detail: 'unknown rule: 99' })
    ).toBe('Remove & escalate failed: unknown rule: 99');
  });
});

describe('runRemoveAndEscalate', () => {
  it('removes once and punishes with the selected rule, reason, and mod', async () => {
    const current = state();

    const outcome = await runRemoveAndEscalate(input(), current.deps);

    expect(outcome).toEqual({ status: 'actioned', punishResult: WARN });
    expect(current.removed).toEqual(['t3_abc123']);
    expect(current.punished).toEqual([
      {
        targetUser: 'poster',
        targetThingId: 't3_abc123',
        subredditName: 'RPClipsGTA',
        rule: 2,
        reason: 'toxic comment',
        modUser: 'acting-mod',
      },
    ]);
    expect(current.redis.values.get(SEEN_KEY)).toBe('1');
    expect(current.redis.expirations.get(SEEN_KEY)).toEqual(
      new Date(1_000_000 + 7 * 24 * 60 * 60 * 1000)
    );
  });

  it('surfaces a ban through the ladder label', async () => {
    const current = state({ punish: async () => BAN });

    const outcome = await runRemoveAndEscalate(input(), current.deps);

    expect(outcome).toEqual({ status: 'actioned', punishResult: BAN });
    expect(
      buildRemoveEscalateSuccessToast({ result: BAN, targetUser: 'poster', rule: TOXICITY })
    ).toBe('Removed & banned u/poster — 3 day ban');
  });

  it('carries a t1_ comment id through removal, punishment, and the seen key', async () => {
    const current = state();

    await runRemoveAndEscalate(input({ thingId: 't1_xyz789' }), current.deps);

    expect(current.removed).toEqual(['t1_xyz789']);
    expect(current.punished[0]?.targetThingId).toBe('t1_xyz789');
    expect(current.redis.values.get('removeescalate:seen:t1_xyz789')).toBe('1');
  });

  it('keeps the seen claim when punish fails and the thing stays removed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const current = state({
        punish: async () => {
          throw new Error('service unavailable');
        },
      });

      const outcome = await runRemoveAndEscalate(input(), current.deps);

      expect(outcome).toEqual({ status: 'escalate-failed', detail: 'service unavailable' });
      expect(current.removed).toEqual(['t3_abc123']);
      expect(current.redis.values.get(SEEN_KEY)).toBe('1');
      expect(
        buildRemoveEscalateFailureToast({ status: 'escalate-failed', detail: 'service unavailable' })
      ).toContain('Escalate menu');
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('Escalate menu');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('releases the seen claim and never punishes when removal fails', async () => {
    const current = state({
      removeThing: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(runRemoveAndEscalate(input(), current.deps)).resolves.toEqual({
      status: 'remove-failed',
      detail: 'permission denied',
    });
    expect(current.redis.values.has(SEEN_KEY)).toBe(false);
    expect(current.removed).toEqual([]);
    expect(current.punished).toEqual([]);
  });

  it('is idempotent for the same thing', async () => {
    const current = state();

    const first = await runRemoveAndEscalate(input(), current.deps);
    const second = await runRemoveAndEscalate(input({ rule: 4 }), current.deps);

    expect(first).toEqual({ status: 'actioned', punishResult: WARN });
    expect(second).toEqual({ status: 'already-processed' });
    expect(current.removed).toEqual(['t3_abc123']);
    expect(current.punished).toHaveLength(1);
  });

  it.each([
    ['an unknown rule', { rule: 99 }, 'unknown rule: 99'],
    ['an unprefixed thing id', { thingId: 'abc123' }, 'thing id must be t3_/t1_ prefixed'],
    ['an empty author', { authorName: '  ' }, 'empty author name'],
    ['an empty mod user', { modUser: '' }, 'empty mod user'],
    ['an empty subreddit', { subredditName: '' }, 'empty subreddit name'],
  ] as const)('rejects %s without touching redis', async (_label, overrides, detail) => {
    const current = state();

    await expect(runRemoveAndEscalate(input(overrides), current.deps)).resolves.toEqual({
      status: 'invalid',
      detail,
    });
    expect(current.removed).toEqual([]);
    expect(current.punished).toEqual([]);
    expect(current.redis.calls).toEqual([]);
  });

  it('returns failed — and never throws — when the seen claim SET rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const current = state({}, new RejectingSetRedis());

      await expect(runRemoveAndEscalate(input(), current.deps)).resolves.toEqual({
        status: 'failed',
        detail: 'redis unavailable',
      });
      expect(current.redis.calls.map((call) => call.operation)).toEqual(['set']);
      expect(current.removed).toEqual([]);
      expect(current.punished).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('runRemoveAndEscalateSafely', () => {
  it('pins trigger-failed when deps explode before the orchestrator try block', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const current = state();
      // A hostile getter makes the `deps.now` access itself throw — outside
      // runRemoveAndEscalate's own try — exactly the boundary the safe
      // wrapper exists to cover.
      const hostileDeps: RemoveEscalateDeps = {
        redis: current.redis,
        removeThing: current.deps.removeThing,
        punish: current.deps.punish,
        get now(): () => number {
          throw new Error('clock exploded');
        },
      };

      await expect(runRemoveAndEscalateSafely(input(), hostileDeps)).resolves.toEqual({
        status: 'trigger-failed',
        detail: 'clock exploded',
      });
      expect(current.removed).toEqual([]);
      expect(current.punished).toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
