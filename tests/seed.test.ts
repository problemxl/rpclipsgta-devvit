import { describe, expect, it, vi } from 'vitest';

import { effectivePriors, pickRung } from '../src/lib/ladder.js';
import { userActionLockKey } from '../src/lib/user-lock.js';
import { punish, punishLockKey } from '../src/actions/punish.js';
import type {
  HistoryStore,
  ModActionRecord,
  RedisSetOptions,
  RedisStringLike,
} from '../src/lib/history.js';
import {
  buildSeedToast,
  isSeedAllowedSubreddit,
  normalizeSeedUsername,
  runSeedSafely,
  seedHistory,
  SEED_ALLOWED_SUBREDDITS,
  type SeedDeps,
  type SeedInput,
  type SeedOperation,
} from '../src/actions/seed.js';

class FakeLockRedis implements RedisStringLike {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: RedisSetOptions
  ): Promise<string | undefined> {
    if (options?.nx && this.values.has(key)) return undefined;
    if (options?.xx && !this.values.has(key)) return undefined;
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const NOW = 1_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Capturing HistoryStore double: records every append (with the exact record
 * payload) and every clear, with injectable failure modes.
 */
class FakeHistory implements HistoryStore {
  readonly appends: Array<{ username: string; record: Omit<ModActionRecord, 'id'> }> = [];
  readonly cleared: string[] = [];
  /** Fail (ok:false) once this many appends have been attempted; Infinity = never. */
  failAppendAfter = Number.POSITIVE_INFINITY;
  /** Fail (ok:false) once this many appends have SUCCEEDED; Infinity = never. */
  failAppendAfterLanded = Number.POSITIVE_INFINITY;
  clearResult = true;
  throwOnEveryCall = false;

  async append(
    username: string,
    record: Omit<ModActionRecord, 'id'>
  ): Promise<{ ok: boolean; record: ModActionRecord }> {
    if (this.throwOnEveryCall) throw new Error('append exploded');
    const stored: ModActionRecord = { ...record, id: `row-${this.appends.length + 1}` };
    if (this.appends.length >= this.failAppendAfter) return { ok: false, record: stored };
    if (this.appends.length >= this.failAppendAfterLanded) return { ok: false, record: stored };
    this.appends.push({ username, record });
    return { ok: true, record: stored };
  }

  async summary(username: string): Promise<{ total: number; latestAt: number | undefined }> {
    if (this.throwOnEveryCall) throw new Error('summary exploded');
    const rows = this.appends.filter((row) => row.username === username);
    return { total: rows.length, latestAt: undefined };
  }

  async load(username: string): Promise<ModActionRecord[]> {
    if (this.throwOnEveryCall) throw new Error('load exploded');
    return this.appends
      .filter((row) => row.username === username)
      .map((row, index) => ({ ...row.record, id: `row-${index + 1}` }));
  }

  async remove(): Promise<boolean> {
    if (this.throwOnEveryCall) throw new Error('remove exploded');
    return false;
  }

  async clear(username: string): Promise<boolean> {
    if (this.throwOnEveryCall) throw new Error('clear exploded');
    this.cleared.push(username);
    return this.clearResult;
  }
}

function deps(
  history = new FakeHistory(),
  redis = new FakeLockRedis(),
  authorizeActor: SeedDeps['authorizeActor'] = vi.fn(async () => true)
): { history: FakeHistory; redis: FakeLockRedis } & SeedDeps {
  return { history, redis, authorizeActor, now: () => NOW };
}

function input(overrides: Partial<SeedInput> = {}): SeedInput {
  return {
    subredditName: 'S17Cjn21GT',
    username: 'ladder_user',
    actor: 'TestModerator',
    operation: 'seed',
    priors: 3,
    latestAgeDays: 5,
    ...overrides,
  };
}

describe('isSeedAllowedSubreddit', () => {
  it('allows exactly the dev and QA subreddits, case-insensitively both ways', () => {
    expect(SEED_ALLOWED_SUBREDDITS).toEqual(['S17Cjn21GT', 'rpclipsgta_mod_dev']);
    expect(isSeedAllowedSubreddit('S17Cjn21GT')).toBe(true);
    expect(isSeedAllowedSubreddit('s17cjn21gt')).toBe(true); // input lowercased
    expect(isSeedAllowedSubreddit('S17CJN21GT')).toBe(true); // input uppercased
    expect(isSeedAllowedSubreddit('rpclipsgta_mod_dev')).toBe(true);
    expect(isSeedAllowedSubreddit('RPClipsGTA_MOD_DEV')).toBe(true);
    expect(isSeedAllowedSubreddit('  RpClipsGta_Mod_Dev  ')).toBe(true);
  });

  it('denies the production subreddit and everything else', () => {
    expect(isSeedAllowedSubreddit('RPClipsGTA')).toBe(false);
    expect(isSeedAllowedSubreddit('rpclipsgta')).toBe(false);
    expect(isSeedAllowedSubreddit('rpclipsgta_test')).toBe(false);
    expect(isSeedAllowedSubreddit('')).toBe(false);
    expect(isSeedAllowedSubreddit(undefined)).toBe(false);
  });
});

describe('normalizeSeedUsername', () => {
  it('strips one leading u/ (any case), trims, and lowercases', () => {
    expect(normalizeSeedUsername('u/Ladder_User')).toBe('ladder_user');
    expect(normalizeSeedUsername('U/Ladder_User')).toBe('ladder_user');
    expect(normalizeSeedUsername('  SomeUser  ')).toBe('someuser');
    expect(normalizeSeedUsername('u/')).toBe('');
    expect(normalizeSeedUsername('   ')).toBe('');
  });
});

describe('seedHistory — allowlist guard', () => {
  it('denies the production subreddit before authorization or any history call and logs loudly', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const current = deps();
    try {
      await expect(seedHistory(current, input({ subredditName: 'RPClipsGTA' }))).resolves.toEqual({
        status: 'denied',
      });
      // Case variants of the prod name are denied too.
      await expect(
        seedHistory(current, input({ subredditName: 'rpclipsgta', operation: 'clear' }))
      ).resolves.toEqual({ status: 'denied' });
      // Refusal happens FIRST: no authorization, rows written, or clear.
      expect(current.authorizeActor).not.toHaveBeenCalled();
      expect(current.history.appends).toEqual([]);
      expect(current.history.cleared).toEqual([]);
      expect(String(error.mock.calls[0]?.[0])).toContain('[seed] DENIED subreddit');
    } finally {
      error.mockRestore();
    }
  });

  it('denies a non-moderator in an allowed subreddit before history access', async () => {
    const current = deps(new FakeHistory(), new FakeLockRedis(), async () => false);
    await expect(seedHistory(current, input())).resolves.toMatchObject({
      status: 'denied',
      detail: 'acting user is not a moderator',
    });
    expect(current.history.appends).toEqual([]);
    expect(current.history.cleared).toEqual([]);
  });

  it('accepts dev/QA subreddit names in any casing after moderator authorization', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ subredditName: 'S17CJN21GT' }))
    ).resolves.toMatchObject({ status: 'seeded' });
    await expect(
      seedHistory(current, input({ subredditName: 'rpclipsgta_mod_dev' }))
    ).resolves.toMatchObject({ status: 'seeded' });
  });
});

describe('seedHistory — validation', () => {
  it('rejects an unknown operation without clearing or seeding', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ operation: 'delete' as SeedOperation }))
    ).resolves.toMatchObject({ status: 'invalid' });
    expect(current.history.appends).toEqual([]);
    expect(current.history.cleared).toEqual([]);
  });

  it('rejects usernames that are not valid Reddit usernames', async () => {
    const current = deps();
    await expect(seedHistory(current, input({ username: 'x' }))).resolves.toMatchObject({
      status: 'invalid',
    });
    await expect(seedHistory(current, input({ username: 'name with spaces' }))).resolves.toMatchObject({
      status: 'invalid',
    });
    expect(current.history.appends).toEqual([]);
  });

  it('rejects malformed actor and username values without touching history', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ actor: undefined as unknown as string }))
    ).resolves.toMatchObject({ status: 'denied' });
    await expect(
      seedHistory(current, input({ username: undefined as unknown as string }))
    ).resolves.toMatchObject({ status: 'invalid' });
    expect(current.history.appends).toEqual([]);
    expect(current.history.cleared).toEqual([]);
  });

  it('rejects an empty username after normalization', async () => {
    const current = deps();
    await expect(seedHistory(current, input({ username: 'u/' }))).resolves.toEqual({
      status: 'invalid',
      detail: 'username is required',
    });
    await expect(seedHistory(current, input({ username: '   ' }))).resolves.toMatchObject({
      status: 'invalid',
    });
    expect(current.history.appends).toEqual([]);
    expect(current.history.cleared).toEqual([]);
  });

  it.each([0, 21, 1.5, NaN, undefined])('rejects priors %s as invalid', async (priors) => {
    const current = deps();
    const outcome = await seedHistory(current, input({ priors: priors as number | undefined }));
    expect(outcome).toMatchObject({ status: 'invalid' });
    expect('detail' in outcome && outcome.detail).toContain('priors');
    expect(current.history.appends).toEqual([]);
  });

  it.each([-1, 3651, 2.5, NaN, undefined])(
    'rejects latestAgeDays %s as invalid',
    async (latestAgeDays) => {
      const current = deps();
      const outcome = await seedHistory(
        current,
        input({ latestAgeDays: latestAgeDays as number | undefined })
      );
      expect(outcome).toMatchObject({ status: 'invalid' });
      expect('detail' in outcome && outcome.detail).toContain('latestAgeDays');
      expect(current.history.appends).toEqual([]);
    }
  );

  it('accepts the inclusive bounds 1/20 priors and 0/3650 days', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ priors: 1, latestAgeDays: 0 }))
    ).resolves.toMatchObject({ status: 'seeded' });
    await expect(
      seedHistory(current, input({ priors: 20, latestAgeDays: 3650 }))
    ).resolves.toMatchObject({ status: 'seeded' });
  });
});

describe('seedHistory — seeding', () => {
  it('writes N one-day-spaced rows oldest-first with the newest exactly latestAgeDays old', async () => {
    const current = deps();
    const outcome = await seedHistory(current, input({ priors: 3, latestAgeDays: 2 }));

    expect(outcome).toEqual({
      status: 'seeded',
      username: 'ladder_user',
      priors: 3,
      latestAgeDays: 2,
    });
    expect(current.history.cleared).toEqual([]); // seeding never clears anything
    expect(current.history.appends).toHaveLength(3);

    const ats = current.history.appends.map((row) => row.record.at);
    expect(ats).toEqual([NOW - 4 * DAY, NOW - 3 * DAY, NOW - 2 * DAY]); // ascending, 1-day spacing
    expect(ats[2]).toBe(NOW - 2 * DAY); // newest exactly latestAgeDays old

    for (const { username, record } of current.history.appends) {
      expect(username).toBe('ladder_user');
      expect(record).toMatchObject({
        rule: 11,
        action: 'warn',
        label: 'Warning',
        modUser: 'seed-tool',
        targetThingId: 't3_seeded',
      });
    }
  });

  it('seeds under the normalized username for u/-prefixed mixed-case input', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ username: 'u/Ladder_User', priors: 1, latestAgeDays: 0 }))
    ).resolves.toMatchObject({ status: 'seeded', username: 'ladder_user' });
    expect(current.history.appends[0]?.username).toBe('ladder_user');
  });

  it('places the user on the matching ladder rung and lets decay work', async () => {
    const current = deps();
    await seedHistory(current, input({ priors: 1, latestAgeDays: 0 }));
    // One fresh prior ⇒ next violation is a 3 day ban.
    expect(pickRung(1, NOW, NOW).label).toBe('3 day ban');

    // The same single prior, 90 days old, has decayed back to a warning.
    expect(effectivePriors(1, NOW - 90 * DAY, NOW)).toBe(0);

    await seedHistory(current, input({ priors: 5, latestAgeDays: 0 }));
    expect(pickRung(5, NOW, NOW).label).toBe('Permanent ban');
  });

  it('reports failed with the landed count when an append fails mid-way, without auto-clearing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const current = deps();
    current.history.failAppendAfterLanded = 2;
    try {
      await expect(seedHistory(current, input({ priors: 4 }))).resolves.toEqual({
        status: 'failed',
        detail: 'only 2 of 4 rows landed; clear u/ladder_user and retry',
      });
      // Exactly the failed count was attempted-and-kept; the operator clears.
      expect(current.history.appends).toHaveLength(2);
      expect(current.history.cleared).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});

describe('seedHistory — clearing', () => {
  it('clears the normalized username and reports the cleared outcome', async () => {
    const current = deps();
    await expect(
      seedHistory(current, input({ username: 'u/OldUser', operation: 'clear' }))
    ).resolves.toEqual({ status: 'cleared', username: 'olduser' });
    expect(current.history.cleared).toEqual(['olduser']);
    expect(current.history.appends).toEqual([]); // clear never writes rows
  });

  it('ignores priors/latestAgeDays on clear', async () => {
    const current = deps();
    await expect(
      seedHistory(
        current,
        input({ operation: 'clear', priors: undefined, latestAgeDays: undefined })
      )
    ).resolves.toEqual({ status: 'cleared', username: 'ladder_user' });
  });

  it('reports failed without claiming success when the clear fails', async () => {
    const current = deps();
    current.history.clearResult = false;
    await expect(seedHistory(current, input({ operation: 'clear' }))).resolves.toMatchObject({
      status: 'failed',
    });
    expect(current.history.cleared).toEqual(['ladder_user']); // attempted
  });
});

describe('seedHistory — never throws', () => {
  it('degrades a throwing history to a failed outcome for both operations', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const current = deps();
    current.history.throwOnEveryCall = true;
    try {
      await expect(seedHistory(current, input({ operation: 'seed' }))).resolves.toMatchObject({
        status: 'failed',
      });
      await expect(seedHistory(current, input({ operation: 'clear' }))).resolves.toMatchObject({
        status: 'failed',
      });
      expect(error).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });

  it('includes the landed count when an append throws mid-way', async () => {
    const current = deps();
    let calls = 0;
    current.history.append = async (username, record) => {
      calls += 1;
      if (calls === 3) throw new Error('redis append exploded');
      const stored: ModActionRecord = { ...record, id: `row-${calls}` };
      current.history.appends.push({ username, record });
      return { ok: true, record: stored };
    };
    await expect(seedHistory(current, input({ priors: 4 }))).resolves.toEqual({
      status: 'failed',
      detail: 'only 2 of 4 rows landed; redis append exploded',
    });
    expect(current.history.appends).toHaveLength(2);
  });

  it('degrades a throwing clock to a failed outcome', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        seedHistory({
          history: new FakeHistory(),
          redis: new FakeLockRedis(),
          authorizeActor: async () => true,
          now: () => {
            throw new Error('clock broke');
          },
        }, input())
      ).resolves.toMatchObject({ status: 'failed' });
    } finally {
      error.mockRestore();
    }
  });

  it('uses the exact lock key shared with punish and serializes seed operations', async () => {
    expect(userActionLockKey('LADDER_USER')).toBe(punishLockKey('ladder_user'));


    const redis = new FakeLockRedis();
    const firstHistory = new FakeHistory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    firstHistory.append = async (username, record) => {
      await gate;
      const stored: ModActionRecord = { ...record, id: 'row-1' };
      firstHistory.appends.push({ username, record });
      return { ok: true, record: stored };
    };

    const first = seedHistory(deps(firstHistory, redis), input({ priors: 1 }));
    await vi.waitFor(() => expect(redis.values.size).toBe(1));

    const secondHistory = new FakeHistory();
    await expect(
      seedHistory(deps(secondHistory, redis), input({ username: 'LADDER_USER', priors: 1 }))
    ).resolves.toMatchObject({ status: 'failed' });
    expect(secondHistory.appends).toEqual([]);

    release();
    await expect(first).resolves.toMatchObject({ status: 'seeded' });
  });

  it('blocks punish while seed owns the shared user lock', async () => {
    const redis = new FakeLockRedis();
    const history = new FakeHistory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    history.append = async (username, record) => {
      await gate;
      const stored: ModActionRecord = { ...record, id: 'row-1' };
      history.appends.push({ username, record });
      return { ok: true, record: stored };
    };

    const seeding = seedHistory(deps(history, redis), input({ priors: 1 }));
    await vi.waitFor(() => expect(redis.values.size).toBe(1));
    const submitComment = vi.fn(async () => 't1_warning');
    await expect(
      punish(
        {
          history,
          redis,
          submitComment,
          banUser: async () => undefined,
        },
        {
          targetUser: 'LADDER_USER',
          targetThingId: 't3_post',
          subredditName: 'S17Cjn21GT',
          rule: 11,
          reason: '',
          modUser: 'TestModerator',
        }
      )
    ).rejects.toThrow('punishment already in progress');
    expect(submitComment).not.toHaveBeenCalled();
    release();
    await expect(seeding).resolves.toMatchObject({ status: 'seeded' });
  });

  it('blocks clear while punish owns the shared user lock', async () => {
    const redis = new FakeLockRedis();
    const history = new FakeHistory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const punishing = punish(
      {
        history,
        redis,
        submitComment: async () => {
          await gate;
          return 't1_warning';
        },
        banUser: async () => undefined,
      },
      {
        targetUser: 'LADDER_USER',
        targetThingId: 't3_post',
        subredditName: 'S17Cjn21GT',
        rule: 11,
        reason: '',
        modUser: 'TestModerator',
      }
    );
    await vi.waitFor(() => expect(redis.values.size).toBe(1));
    await expect(
      seedHistory(deps(new FakeHistory(), redis), input({ operation: 'clear' }))
    ).resolves.toMatchObject({ status: 'failed' });
    release();
    await expect(punishing).resolves.toMatchObject({ action: 'warn' });
  });

  it('runSeedSafely never rejects even if seedHistory itself throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        runSeedSafely(
          {
            history: {
              append: () => Promise.reject(new Error('impossible')),
              summary: () => Promise.reject(new Error('impossible')),
              load: () => Promise.reject(new Error('impossible')),
              remove: () => Promise.reject(new Error('impossible')),
              clear: () => Promise.reject(new Error('impossible')),
            },
            redis: new FakeLockRedis(),
            authorizeActor: async () => true,
          },
          input({ operation: 'clear' })
        )
      ).resolves.toMatchObject({ status: 'failed' });
    } finally {
      error.mockRestore();
    }
  });
});

describe('buildSeedToast', () => {
  it('describes seeded priors with the username and newest age', () => {
    expect(
      buildSeedToast({ status: 'seeded', username: 'ladder_user', priors: 3, latestAgeDays: 5 })
    ).toBe('Seeded 3 priors for u/ladder_user (latest 5 days ago)');
  });

  it('describes a cleared user', () => {
    expect(buildSeedToast({ status: 'cleared', username: 'ladder_user' })).toBe(
      'Cleared history for u/ladder_user'
    );
  });

  it('points out the dev/QA restriction on denial', () => {
    expect(buildSeedToast({ status: 'denied' })).toBe(
      'Test tool is only available in the dev/QA subreddits.'
    );
    expect(buildSeedToast({ status: 'denied', detail: 'acting user is not a moderator' })).toBe(
      'Seed denied: acting user is not a moderator'
    );
  });

  it('keeps invalid, failed, and trigger-failed texts short with the detail', () => {
    expect(buildSeedToast({ status: 'invalid', detail: 'username is required' })).toBe(
      'Invalid seed input: username is required'
    );
    expect(buildSeedToast({ status: 'failed', detail: 'redis refused the clear' })).toBe(
      'Seed failed: redis refused the clear'
    );
    expect(buildSeedToast({ status: 'trigger-failed', detail: 'boom' })).toBe(
      'Seed test history failed: boom'
    );
  });
});
