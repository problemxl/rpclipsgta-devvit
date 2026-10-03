import { describe, expect, it, vi } from 'vitest';

import {
  applyManualRuleRemoval,
  buildRemovalFailureToast,
  buildRemovalSuccessToast,
  runModRemoval,
  type AutoRedisSetOptions,
  type ModRemovalDeps,
  type ModRemovalInput,
  type RedisLike,
} from '../src/actions/autoescalate.js';
import type { EscalatePayload, EscalateResult } from '../src/actions/autoescalate.js';

const RESULT: EscalateResult = {
  action: 'warn',
  duration_days: 0,
  label: 'Warning',
  comment_id: 't1_warning',
  priors: 0,
  rule_name: 'Toxicity',
  recorded: true,
};

function input(overrides: Partial<ModRemovalInput> = {}): ModRemovalInput {
  return {
    postId: 'abc123',
    authorName: 'poster',
    modUser: 'acting-mod',
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

function state(
  overrides: Partial<ModRemovalDeps> = {},
  redis = new FakeRedis()
): {
  redis: FakeRedis;
  removed: string[];
  escalated: EscalatePayload[];
  deps: ModRemovalDeps;
} {
  const removed: string[] = [];
  const escalated: EscalatePayload[] = [];
  const deps: ModRemovalDeps = {
    redis,
    removePost: async (thingId) => {
      removed.push(thingId);
    },
    escalate: async (payload) => {
      escalated.push(payload);
      return RESULT;
    },
    now: () => 1_000_000,
    ...overrides,
  };
  return { redis, removed, escalated, deps };
}

describe('removal toast builders', () => {
  it('describes a removal that was escalated', () => {
    expect(
      buildRemovalSuccessToast(
        { status: 'actioned', violation: { rule: 2, reason: 'toxicity', action: 'remove-and-escalate' }, escalateResult: RESULT },
        'Toxicity'
      )
    ).toBe('Removed post (R2 — Toxicity) and escalated.');
  });

  it('mentions the manual Escalate option after an escalation failure', () => {
    expect(
      buildRemovalFailureToast({ status: 'escalate-failed', detail: 'service unavailable' })
    ).toBe('Escalation failed after removal: service unavailable. Use the manual Escalate option.');
  });
});

describe('runModRemoval', () => {
  it.each([
    ['R5', { url: 'https://bad.example/clip' }, 5],
    ['R12', { title: 'Koil clip' }, 12],
  ] as const)('removes %s without escalating', async (_label, overrides, rule) => {
    const current = state({}, new FakeRedis());

    const outcome = await runModRemoval(input(overrides), current.deps);

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule } });
    expect(current.removed).toEqual(['t3_abc123']);
    expect(current.escalated).toEqual([]);
  });

  it('removes an R6 duplicate without escalating', async () => {
    const current = state();
    const first = await runModRemoval(input(), current.deps);
    const duplicate = await runModRemoval(
      input({ postId: 'second', url: 'https://WWW.CLIPS.TWITCH.TV/ClipOne/?utm_source=x#time' }),
      current.deps
    );

    expect(first).toEqual({ status: 'clean' });
    expect(duplicate).toMatchObject({ status: 'actioned', violation: { rule: 6 } });
    expect(current.removed).toEqual(['t3_second']);
    expect(current.escalated).toEqual([]);
  });

  it('lets an R6 duplicate outrank R4 without escalating', async () => {
    const current = state();
    const urlKey = 'autoescalate:url:https://clips.twitch.tv/ClipOne';
    current.redis.values.set(urlKey, 'earlier-post');

    const outcome = await runModRemoval(
      input({ postId: 'duplicate-emote-title', title: '😂 !!!' }),
      current.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 6 } });
    expect(current.removed).toEqual(['t3_duplicate-emote-title']);
    expect(current.escalated).toEqual([]);
    expect(current.redis.calls.filter((call) => call.key === urlKey).map((call) => call.operation))
      .toEqual(['get']);
  });

  it('lets R5 win for an eligible unclaimed URL without claiming it', async () => {
    const current = state();
    const url = 'https://streamable.com/clip';
    const urlKey = `autoescalate:url:${url}`;

    const outcome = await runModRemoval(
      input({ postId: 'r5-post', url }),
      current.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 5 } });
    expect(current.removed).toEqual(['t3_r5-post']);
    expect(current.redis.values.has(urlKey)).toBe(false);
    expect(current.redis.calls.filter((call) => call.key === urlKey).map((call) => call.operation))
      .toEqual(['get']);
  });

  it('escalates an R4 violation with the acting moderator in the payload', async () => {
    const current = state();

    const outcome = await runModRemoval(
      input({ title: '😂 !!!', modUser: 'moderator42' }),
      current.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 4 } });
    expect(current.removed).toEqual(['t3_abc123']);
    expect(current.escalated).toEqual([
      {
        target_user: 'poster',
        target_id: 't3_abc123',
        rule: 4,
        reason: 'Auto: emote-only title',
        mod_user: 'moderator42',
      },
    ]);
  });

  it('checks a clean URL before claiming it and then stores the post id', async () => {
    const current = state();

    await expect(runModRemoval(input(), current.deps)).resolves.toEqual({ status: 'clean' });

    const urlKey = 'autoescalate:url:https://clips.twitch.tv/ClipOne';
    const urlOperations = current.redis.calls.filter((call) => call.key === urlKey);
    expect(urlOperations.map((call) => call.operation)).toEqual(['get', 'set']);
    expect(urlOperations[1]).toMatchObject({ operation: 'set', value: 'abc123' });
    expect(current.redis.values.get(urlKey)).toBe('abc123');
    expect(current.redis.expirations.get(urlKey)).toEqual(
      new Date(1_000_000 + 14 * 24 * 60 * 60 * 1000)
    );
    expect(current.redis.values.get('autoescalate:seen:abc123')).toBe('clean');
    expect(current.redis.expirations.get('autoescalate:seen:abc123')).toEqual(
      new Date(1_000_000 + 7 * 24 * 60 * 60 * 1000)
    );
  });

  it('does not claim a URL when content already violates a rule', async () => {
    const current = state();

    await runModRemoval(
      input({ postId: 'bad-domain', url: 'https://bad.example/clip' }),
      current.deps
    );
    await runModRemoval(
      input({ postId: 'banned-name', title: 'Koil highlight' }),
      current.deps
    );

    expect([...current.redis.values.keys()].filter((key) => key.startsWith('autoescalate:url:')))
      .toEqual([]);
    expect(
      current.redis.calls
        .filter((call) => call.key.startsWith('autoescalate:url:'))
        .map((call) => call.operation)
    ).toEqual(['get']);
  });

  it('is idempotent for the same post', async () => {
    const current = state();
    const first = await runModRemoval(
      input({ url: 'https://bad.example/clip' }),
      current.deps
    );
    const second = await runModRemoval(
      input({ url: 'https://bad.example/different' }),
      current.deps
    );

    expect(first).toMatchObject({ status: 'actioned', violation: { rule: 5 } });
    expect(second).toEqual({ status: 'already-processed' });
    expect(current.removed).toEqual(['t3_abc123']);
  });

  it('releases the seen claim when removal fails and does not escalate', async () => {
    const current = state({
      removePost: async () => {
        throw new Error('permission denied');
      },
    });

    await expect(
      runModRemoval(input({ title: '😂 !!!' }), current.deps)
    ).resolves.toEqual({ status: 'remove-failed', detail: 'permission denied' });
    expect(current.redis.values.has('autoescalate:seen:abc123')).toBe(false);
    expect(current.removed).toEqual([]);
    expect(current.escalated).toEqual([]);
  });

  it('releases the seen claim when a dependency fails before removal', async () => {
    const redis = new FakeRedis();
    vi.spyOn(redis, 'get').mockRejectedValue(new Error('redis unavailable'));
    const current = state({}, redis);

    await expect(runModRemoval(input(), current.deps)).resolves.toEqual({
      status: 'failed',
      detail: 'redis unavailable',
    });
    expect(current.redis.values.has('autoescalate:seen:abc123')).toBe(false);
    expect(current.removed).toEqual([]);
    expect(current.escalated).toEqual([]);
  });

  it('keeps the seen claim and reports a manual fallback when escalation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const current = state({
        escalate: async () => {
          throw new Error('service unavailable');
        },
      });

      await expect(
        runModRemoval(input({ title: '😂 !!!' }), current.deps)
      ).resolves.toEqual({ status: 'escalate-failed', detail: 'service unavailable' });
      expect(current.removed).toEqual(['t3_abc123']);
      expect(current.redis.values.get('autoescalate:seen:abc123')).toBe('1');
      expect(errorSpy.mock.calls.flat().join('\n')).toContain('manual Escalate');
    } finally {
      errorSpy.mockRestore();
    }
  });

});

describe('applyManualRuleRemoval', () => {
  it('applies manual rule 2 with the supplied reason and mod_user', async () => {
    const current = state();

    const outcome = await applyManualRuleRemoval(
      input({ postId: 'manual-two', authorName: 'target-user', modUser: 'mod-user' }),
      2,
      'Repeated abusive comments',
      current.deps
    );

    expect(outcome).toMatchObject({ status: 'actioned', violation: { rule: 2 } });
    expect(current.removed).toEqual(['t3_manual-two']);
    expect(current.escalated).toEqual([
      {
        target_user: 'target-user',
        target_id: 't3_manual-two',
        rule: 2,
        reason: 'Repeated abusive comments',
        mod_user: 'mod-user',
      },
    ]);
  });

  it('applies manual rule 5 as remove-only and does not claim a URL', async () => {
    const current = state();

    const outcome = await applyManualRuleRemoval(
      input({ postId: 'manual-five' }),
      5,
      'Unapproved external domain',
      current.deps
    );

    expect(outcome).toMatchObject({
      status: 'actioned',
      violation: { rule: 5, reason: 'Unapproved external domain', action: 'remove' },
    });
    expect(current.removed).toEqual(['t3_manual-five']);
    expect(current.escalated).toEqual([]);
    expect([...current.redis.values.keys()].some((key) => key.startsWith('autoescalate:url:')))
      .toBe(false);
  });

  it('consumes the clean automatic claim when the moderator selects a manual rule', async () => {
    const current = state();
    const post = input({ postId: 'clean-then-manual' });

    await expect(runModRemoval(post, current.deps)).resolves.toEqual({ status: 'clean' });
    await expect(
      applyManualRuleRemoval(
        { postId: post.postId, authorName: post.authorName, modUser: post.modUser },
        5,
        'Moderator review found a domain issue',
        current.deps
      )
    ).resolves.toMatchObject({ status: 'actioned', violation: { rule: 5 } });
    expect(current.removed).toEqual(['t3_clean-then-manual']);
    expect(current.redis.values.get('autoescalate:seen:clean-then-manual')).toBe('1');
  });

  it('atomically consumes a clean automatic claim only once', async () => {
    const redis = new FakeRedis();
    redis.values.set('autoescalate:seen:form-once', 'clean');
    const current = state({}, redis);
    const post = { postId: 'form-once', authorName: 'poster', modUser: 'mod-user' };

    await expect(applyManualRuleRemoval(post, 5, 'First action', current.deps)).resolves.toMatchObject({
      status: 'actioned',
    });
    await expect(applyManualRuleRemoval(post, 5, 'Second action', current.deps)).resolves.toEqual({
      status: 'already-processed',
    });
    expect(current.removed).toEqual(['t3_form-once']);
    expect(current.redis.values.get('autoescalate:seen:form-once')).toBe('1');
  });

  it('rejects a form submission whose seen claim is already consumed', async () => {
    const redis = new FakeRedis();
    redis.values.set('autoescalate:seen:already-consumed', '1');
    const current = state({}, redis);

    await expect(
      applyManualRuleRemoval(
        { postId: 'already-consumed', authorName: 'poster', modUser: 'mod-user' },
        5,
        'Second action',
        current.deps
      )
    ).resolves.toEqual({ status: 'already-processed' });
    expect(current.removed).toEqual([]);
    expect(current.escalated).toEqual([]);
  });

  it('is idempotent after a manual removal', async () => {
    const current = state();
    const post = { postId: 'manual-once', authorName: 'poster', modUser: 'mod-user' };

    await expect(applyManualRuleRemoval(post, 5, 'First action', current.deps)).resolves.toMatchObject({
      status: 'actioned',
    });
    await expect(applyManualRuleRemoval(post, 5, 'Second action', current.deps)).resolves.toEqual({
      status: 'already-processed',
    });
    expect(current.removed).toEqual(['t3_manual-once']);
  });
});
