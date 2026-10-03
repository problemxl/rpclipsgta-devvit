import { describe, expect, it, vi } from 'vitest';

import {
  runAutoEscalation,
  runAutoEscalationSafely,
  type AutoEscalateInput,
  type AutoRedisSetOptions,
  type RedisLike,
} from '../src/actions/autoescalate.js';
import type { EscalateResult } from '../src/lib/service.js';

const RESULT: EscalateResult = {
  action: 'warn',
  duration_days: 0,
  label: 'Warning',
  comment_id: 't1_warning',
  priors: 0,
  rule_name: 'Whitelisted domains',
  recorded: true,
};

function input(overrides: Partial<AutoEscalateInput> = {}): AutoEscalateInput {
  return {
    postId: 'abc123',
    authorName: 'poster',
    title: 'A good clip',
    url: 'https://clips.twitch.tv/ClipOne',
    body: '',
    isTextPost: false,
    ...overrides,
  };
}

class FakeRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  readonly calls: Array<{ key: string; value: string; options?: AutoRedisSetOptions }> = [];

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async set(
    key: string,
    value: string,
    options?: AutoRedisSetOptions
  ): Promise<string | undefined> {
    this.calls.push({ key, value, options });
    if (options?.nx && this.values.has(key)) return undefined;
    if (options?.xx && !this.values.has(key)) return undefined;
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return 'OK';
  }
}

function deps(redis = new FakeRedis(), overrides: Partial<Parameters<typeof runAutoEscalation>[1]> = {}) {
  const removed: string[] = [];
  const escalated: unknown[] = [];
  return {
    redis,
    removed,
    escalated,
    deps: {
      redis,
      removePost: async (id: string) => void removed.push(id),
      escalate: async (payload: unknown) => {
        escalated.push(payload);
        return RESULT;
      },
      isModerator: async () => false,
      now: () => 1_000_000,
      ...overrides,
    },
  };
}

describe('runAutoEscalation', () => {
  it('safe wrapper converts a rejecting settings getter into trigger-failed', async () => {
    const state = deps(undefined, {
      escalate: undefined,
      getEscalate: async () => {
        throw new Error('settings unavailable');
      },
    });
    await expect(
      runAutoEscalationSafely(input({ url: 'https://bad.example/clip' }), state.deps)
    ).resolves.toEqual({ status: 'trigger-failed', detail: 'settings unavailable' });
    expect(state.removed).toEqual(['t3_abc123']);
  });
  it('leaves a clean whitelisted link alone and claims its URL for 14 days', async () => {
    const state = deps();
    const outcome = await runAutoEscalation(input(), state.deps);

    expect(outcome).toEqual({ status: 'clean' });
    expect(state.removed).toEqual([]);
    expect(state.escalated).toEqual([]);
    expect(state.redis.values.get('autoescalate:url:https://clips.twitch.tv/ClipOne')).toBe(
      'abc123'
    );
    expect(state.redis.expirations.get('autoescalate:url:https://clips.twitch.tv/ClipOne')).toEqual(
      new Date(1_000_000 + 14 * 24 * 60 * 60 * 1000)
    );
  });

  it('removes and escalates a second submission of the same normalized URL', async () => {
    const state = deps();
    await runAutoEscalation(input(), state.deps);
    const second = await runAutoEscalation(
      input({ postId: 'second', url: 'https://WWW.CLIPS.TWITCH.TV/ClipOne/?utm_source=x#t' }),
      state.deps
    );

    expect(second.status).toBe('actioned');
    if (second.status === 'actioned') expect(second.violation.rule).toBe(6);
    expect(state.removed).toEqual(['t3_second']);
    expect(state.escalated).toHaveLength(1);
    expect(state.escalated[0]).toMatchObject({
      target_id: 't3_second',
      rule: 6,
      reason: 'Auto: duplicate of an earlier submission of this URL',
    });
  });

  it('skips empty authors, AutoModerator, and moderators', async () => {
    for (const authorName of ['', 'automOdErator']) {
      const state = deps();
      await expect(runAutoEscalation(input({ authorName }), state.deps)).resolves.toEqual({
        status: 'skipped-author',
      });
      expect(state.redis.values.size).toBe(1);
    }

    const state = deps(undefined, { isModerator: async () => true });
    await expect(runAutoEscalation(input(), state.deps)).resolves.toEqual({
      status: 'skipped-moderator',
    });
  });

  it('is idempotent before checking the author or content', async () => {
    const state = deps();
    const first = await runAutoEscalation(input(), state.deps);
    const second = await runAutoEscalation(
      input({ url: 'https://bad.example/another', authorName: '' }),
      state.deps
    );

    expect(first.status).toBe('clean');
    expect(second).toEqual({ status: 'already-processed' });
  });

  it('removes banned streamer submissions without calling escalation', async () => {
    const state = deps();
    const outcome = await runAutoEscalation(
      input({ title: 'Koil clip' }),
      state.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 12 } });
    expect(state.removed).toEqual(['t3_abc123']);
    expect(state.escalated).toEqual([]);
  });

  it('removes R12 with no service configured', async () => {
    const state = deps(undefined, { escalate: undefined });
    const outcome = await runAutoEscalation(input({ title: 'Koil clip' }), state.deps);
    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 12 } });
    expect(state.removed).toEqual(['t3_abc123']);
  });

  it('removes punish-class violations without service configuration and logs the manual fallback', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const state = deps(undefined, { escalate: undefined });
      const outcome = await runAutoEscalation(
        input({ url: 'https://bad.example/clip' }),
        state.deps
      );
      expect(outcome).toMatchObject({
        status: 'actioned-unescalated',
        reason: 'service-not-configured',
      });
      expect(state.removed).toEqual(['t3_abc123']);
      expect(state.escalated).toEqual([]);
      expect([...logSpy.mock.calls.flat(), ...errorSpy.mock.calls.flat()].join('\n')).toContain(
        'manual Escalate'
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('releases the seen claim when a pre-removal dependency fails', async () => {
    const state = deps(undefined, {
      isModerator: async () => {
        throw new Error('moderator lookup failed');
      },
    });
    await expect(
      runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps)
    ).resolves.toEqual({ status: 'failed', detail: 'moderator lookup failed' });
    expect(state.redis.values.has('autoescalate:seen:abc123')).toBe(false);
    expect(state.removed).toEqual([]);
    expect(state.escalated).toEqual([]);
  });

  it('does not claim URLs for removed content, so a later clean post stays clean', async () => {
    const state = deps();
    const removed = await runAutoEscalation(input({ title: 'Koil clip' }), state.deps);
    const clean = await runAutoEscalation(
      input({ postId: 'clean', title: 'A good clip' }),
      state.deps
    );
    expect(removed).toMatchObject({ status: 'actioned' });
    expect(clean).toEqual({ status: 'clean' });
  });

  it('does not claim VOD URLs for a later clean post', async () => {
    const state = deps();
    await runAutoEscalation(input({ url: 'https://twitch.tv/channel/videos/123' }), state.deps);
    const clean = await runAutoEscalation(
      input({ postId: 'clean', url: 'https://twitch.tv/x/clip/y' }),
      state.deps
    );
    expect(clean).toEqual({ status: 'clean' });
  });

  it('chooses rule 5 over a duplicate rule 6 violation', async () => {
    const state = deps();
    await runAutoEscalation(
      input({ url: 'https://streamable.com/abc', title: '[Name] valid' }),
      state.deps
    );
    const outcome = await runAutoEscalation(
      input({ postId: 'vod', url: 'https://streamable.com/abc', title: '😂' }),
      state.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 5 } });
    expect(state.escalated[0]).toMatchObject({ rule: 5 });
  });

  it('converts escalation errors to outcomes after successful removal and logs the manual fallback', async () => {
    let escalateCalls = 0;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const state = deps(undefined, {
        escalate: async () => {
          escalateCalls += 1;
          throw new Error('service unavailable');
        },
      });
      await expect(
        runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps)
      ).resolves.toEqual({ status: 'escalate-failed', detail: 'service unavailable' });
      expect(state.removed).toEqual(['t3_abc123']);
      expect(state.redis.values.has('autoescalate:seen:abc123')).toBe(true);
      expect(escalateCalls).toBe(1);
      expect([...logSpy.mock.calls.flat(), ...errorSpy.mock.calls.flat()].join('\n')).toContain(
        'manual Escalate'
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not escalate when removal fails and releases the seen claim', async () => {
    const state = deps(undefined, {
      removePost: async () => {
        throw new Error('permission denied');
      },
    });
    await expect(
      runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps)
    ).resolves.toEqual({ status: 'remove-failed', detail: 'permission denied' });
    expect(state.escalated).toEqual([]);
    expect(state.redis.values.has('autoescalate:seen:abc123')).toBe(false);
  });

  it('keeps the seen claim when escalation fails after removal', async () => {
    const state = deps(undefined, {
      escalate: async () => {
        throw new Error('service unavailable');
      },
    });
    await runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps);
    expect(state.redis.values.has('autoescalate:seen:abc123')).toBe(true);
  });
});
