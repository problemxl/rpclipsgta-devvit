import { describe, expect, it } from 'vitest';

import {
  runAutoEscalation,
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

  it('converts escalation errors to outcomes after successful removal', async () => {
    const state = deps(undefined, {
      escalate: async () => {
        throw new Error('service unavailable');
      },
    });
    await expect(
      runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps)
    ).resolves.toEqual({ status: 'escalate-failed', detail: 'service unavailable' });
    expect(state.removed).toEqual(['t3_abc123']);
  });

  it('does not escalate when removal fails and prefixes bare post IDs with t3_', async () => {
    const state = deps(undefined, {
      removePost: async () => {
        throw new Error('permission denied');
      },
    });
    await expect(
      runAutoEscalation(input({ url: 'https://bad.example/clip' }), state.deps)
    ).resolves.toEqual({ status: 'remove-failed', detail: 'permission denied' });
    expect(state.escalated).toEqual([]);
  });
});
