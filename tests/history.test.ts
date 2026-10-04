import { describe, expect, it, vi } from 'vitest';

import { effectivePriors } from '../src/lib/ladder.js';
import {
  createHistoryStore,
  historyKey,
  type ModActionRecord,
  type RedisLike,
} from '../src/lib/history.js';

/**
 * Sorted-set redis double with real ZADD add-vs-update semantics: members are
 * unique per key, kept score-ascending (ties lexicographic, like redis), and
 * re-adding a member updates its score instead of duplicating it.
 */
class FakeZSetRedis implements RedisLike {
  readonly sets = new Map<string, Map<string, number>>();
  readonly calls: string[] = [];
  fail = false;
  /** When set, ZADD resolves with this value without mutating (simulates a rejected write). */
  zAddResult: number | undefined;

  private zset(key: string): Map<string, number> {
    let zset = this.sets.get(key);
    if (!zset) {
      zset = new Map<string, number>();
      this.sets.set(key, zset);
    }
    return zset;
  }

  /** Seed a raw member directly, valid or corrupt, for load/summary tests. */
  seed(key: string, member: string, score: number): void {
    this.zset(key).set(member, score);
  }

  rows(key: string): Map<string, number> {
    return this.zset(key);
  }

  async zAdd(
    key: string,
    ...members: { member: string; score: number }[]
  ): Promise<number> {
    this.calls.push('zAdd');
    if (this.fail) throw new Error('redis down');
    if (this.zAddResult !== undefined) return this.zAddResult;
    const zset = this.zset(key);
    let added = 0;
    for (const { member, score } of members) {
      if (!zset.has(member)) added += 1;
      zset.set(member, score); // update-vs-add: existing members are overwritten
    }
    return added;
  }

  async zRange(
    key: string,
    start: number,
    stop: number
  ): Promise<{ member: string; score: number }[]> {
    this.calls.push('zRange');
    if (this.fail) throw new Error('redis down');
    const ordered = [...this.zset(key).entries()].sort(
      ([aMember, aScore], [bMember, bScore]) => aScore - bScore || (aMember < bMember ? -1 : aMember > bMember ? 1 : 0)
    );
    const from = Math.max(0, start < 0 ? ordered.length + start : start);
    const to = stop < 0 ? ordered.length + stop : stop;
    return ordered.slice(from, to + 1).map(([member, score]) => ({ member, score }));
  }

  async zRem(key: string, members: string[]): Promise<number> {
    this.calls.push('zRem');
    if (this.fail) throw new Error('redis down');
    const zset = this.zset(key);
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) removed += 1;
    }
    return removed;
  }

  async zCard(key: string): Promise<number> {
    this.calls.push('zCard');
    if (this.fail) throw new Error('redis down');
    return this.zset(key).size;
  }

  async del(key: string): Promise<number> {
    this.calls.push('del');
    if (this.fail) throw new Error('redis down');
    const removed = this.zset(key).size;
    this.sets.delete(key);
    return removed;
  }
}

function record(at: number): Omit<ModActionRecord, 'id'> {
  return { at, rule: 2, action: 'ban', label: '3 day ban', modUser: 'mod', targetThingId: 't3_x' };
}

describe('history store', () => {
  it('uses a lowercased per-user key and stores one row per infraction', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const appended = await history.append('SomeUser', record(1));
    expect(appended.ok).toBe(true);
    expect(historyKey('someuser')).toBe('modactions:z:user:someuser');

    const rows = redis.rows('modactions:z:user:someuser');
    expect(rows.size).toBe(1);
    expect(appended.record.id).toMatch(/^1-[0-9a-f]{12}$/); // `${at}-${uuid hex slice}` shape
    expect(rows.get(JSON.stringify({ ...record(1), id: appended.record.id }))).toBe(1); // score = at
    await expect(history.load('SOMEUSER')).resolves.toEqual([
      { ...record(1), id: appended.record.id },
    ]);
  });

  it('appends atomically with a single ZADD and no read-modify-write', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(1));
    // Exactly one command was issued: no GET/ZRANGE read before the write, so
    // concurrent appends can never lose each other's rows.
    expect(redis.calls).toEqual(['zAdd']);
  });

  it('mints unique ids so identical same-ms records never overwrite each other', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(7));
    await history.append('user', record(7)); // byte-identical record payload

    const summary = await history.summary('user');
    expect(summary.total).toBe(2);
    const loaded = await history.load('user');
    expect(loaded).toHaveLength(2);
    expect(loaded.every((row) => row.at === 7)).toBe(true);
    expect(new Set(loaded.map((row) => row.id)).size).toBe(2);
  });

  it('clamps a future-dated score so a corrupt member cannot freeze decay', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    // A score ~10 decay periods ahead would otherwise pin latestAt in the
    // future, keeping quiet time at zero and freezing decay for years.
    const farFuture = Date.now() + 10 * 90 * 24 * 60 * 60 * 1000;
    redis.seed(historyKey('user'), 'corrupt-future-member', farFuture);

    const summary = await history.summary('user');
    expect(summary.total).toBe(1);
    // Clamped to now + 60s (60s clock-skew allowance) instead of the corrupt
    // far-future score.
    expect(summary.latestAt).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(summary.latestAt).toBeGreaterThan(Date.now());
    // With the clamp, decay engages normally: one full 90-day quiet stretch
    // after the clamped latest action removes the row's whole contribution.
    const afterNinetyDays = (summary.latestAt ?? 0) + 90 * 24 * 60 * 60 * 1000 + 1;
    expect(effectivePriors(summary.total, summary.latestAt, afterNinetyDays)).toBe(0);
  });

  it('summarizes an empty history as zero rows without a latest action', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await expect(history.summary('missing')).resolves.toEqual({ total: 0, latestAt: undefined });
  });

  it('summarizes by counting rows and reading the newest score, parsing nothing', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(100));
    await history.append('user', record(300));
    await history.append('user', record(200));
    await expect(history.summary('user')).resolves.toEqual({ total: 3, latestAt: 300 });
    // The summary must stay O(1)-ish: ZCARD plus the single last row.
    expect(redis.calls.filter((op) => op === 'zRange')).toHaveLength(1);
  });

  it('counts corrupt members in total while the summary never throws on them', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(100));
    // ZCARD counts raw members, so a corrupt payload still counts toward the
    // total; latestAt is the raw newest score and never involves parsing.
    redis.seed(historyKey('user'), '{not json', 500);
    await expect(history.summary('user')).resolves.toEqual({ total: 2, latestAt: 500 });
  });

  it('returns an empty history for missing keys and redis failures', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await expect(history.load('missing')).resolves.toEqual([]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      redis.fail = true;
      await expect(history.load('failure')).resolves.toEqual([]);
      // The degraded [] is documented, but the redis failure must be logged.
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '[history] load modactions:z:user:failure failed: redis down'
      );
    } finally {
      error.mockRestore();
    }
  });

  it('drops corrupt members on load and keeps the valid ones', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const valid = { ...record(123), id: 'keep-1' };
    const key = historyKey('user');
    redis.seed(key, JSON.stringify(valid), 123);
    redis.seed(key, '{not json', 200);
    redis.seed(key, JSON.stringify({ ...record(300) }), 300); // no id → dropped
    redis.seed(key, JSON.stringify(null), 400);
    await expect(history.load('user')).resolves.toEqual([valid]);
  });

  it('requires a string id when validating members on load', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const key = historyKey('user');
    const valid = { ...record(5), id: 'seed-5' };
    redis.seed(key, JSON.stringify(valid), 5);
    redis.seed(key, JSON.stringify({ ...record(6) }), 6); // missing id
    redis.seed(key, JSON.stringify({ ...record(7), id: 9 }), 7); // non-string id
    await expect(history.load('user')).resolves.toEqual([valid]);
  });

  it('returns records oldest-first by score regardless of append order', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(30));
    await history.append('user', record(10));
    await history.append('user', record(20));
    const loaded = await history.load('user');
    expect(loaded.map((row) => row.at)).toEqual([10, 20, 30]);
  });

  it('reports ok:false and stores nothing when ZADD resolves 0', async () => {
    const redis = new FakeZSetRedis();
    redis.zAddResult = 0; // simulates a write that did not land as a new row
    const history = createHistoryStore(redis);
    const appended = await history.append('user', record(1));
    expect(appended.ok).toBe(false);
    expect(appended.record.id).toMatch(/^1-[0-9a-f]{12}$/); // identity returned regardless
    expect(await history.load('user')).toEqual([]);
  });

  it('reports ok:false when ZADD throws', async () => {
    const redis = new FakeZSetRedis();
    redis.fail = true;
    const history = createHistoryStore(redis);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const appended = await history.append('user', record(1));
      expect(appended.ok).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '[history] append modactions:z:user:user failed: redis down'
      );
      await expect(history.load('user')).resolves.toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('removes exactly the row with the matching id and nothing else', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const first = (await history.append('user', record(1))).record;
    const second = (await history.append('user', record(2))).record;
    const third = (await history.append('user', record(3))).record;

    await expect(history.remove('user', second.id)).resolves.toBe(true);
    await expect(history.load('user')).resolves.toEqual([first, third]);
    await expect(history.summary('user')).resolves.toEqual({ total: 2, latestAt: 3 });
  });

  it('removes by id, not by fields, when an older row has identical fields', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const stale: ModActionRecord = { ...record(7), id: 'stale' };
    redis.seed(historyKey('user'), JSON.stringify(stale), 7);
    const appended = (await history.append('user', record(7))).record; // same fields, new id

    await expect(history.remove('user', appended.id)).resolves.toBe(true);
    await expect(history.load('user')).resolves.toEqual([stale]);
  });

  it('skips unparseable members while searching for the id to remove', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const appended = (await history.append('user', record(1))).record;
    redis.seed(historyKey('user'), 'garbage', 99);

    await expect(history.remove('user', appended.id)).resolves.toBe(true);
    const rows = [...redis.rows(historyKey('user')).keys()];
    expect(rows).toEqual(['garbage']); // only the corrupt member remains
  });

  it('logs a debug line on a remove miss while still reporting success', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const appended = (await history.append('user', record(1))).record;
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      // A miss is a documented no-op success, but it must stay visible so
      // compensation anomalies can be diagnosed.
      await expect(history.remove('user', 'no-such-id')).resolves.toBe(true);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain('[history] remove miss for user');
      await expect(history.load('user')).resolves.toEqual([
        { ...record(1), id: appended.id },
      ]);
    } finally {
      debug.mockRestore();
    }
  });

  it('reports remove failure only when redis itself fails', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(1));
    redis.fail = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(history.remove('user', 'any')).resolves.toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '[history] remove modactions:z:user:user failed: redis down'
      );
    } finally {
      error.mockRestore();
    }
  });

  it('degrades a failing summary to a fresh user and logs the failure', async () => {
    const redis = new FakeZSetRedis();
    redis.fail = true;
    const history = createHistoryStore(redis);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(history.summary('user')).resolves.toEqual({ total: 0, latestAt: undefined });
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '[history] summary modactions:z:user:user failed: redis down'
      );
    } finally {
      error.mockRestore();
    }
  });

  it('keeps the entire lifetime history — no record cap', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    for (let at = 0; at < 200; at += 1) await history.append('user', record(at));

    const summary = await history.summary('user');
    expect(summary.total).toBe(200);
    expect(summary.latestAt).toBe(199);
    const loaded = await history.load('user');
    expect(loaded).toHaveLength(200);
    expect(loaded[0].at).toBe(0);
    expect(loaded.at(-1)?.at).toBe(199);
  });

  it('never sets an expiry — retention is unlimited by design', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    const appended = (await history.append('user', record(1))).record;
    await history.summary('user');
    await history.load('user');
    await history.remove('user', appended.id);
    // The structural client subset exposes no expire/TTL command at all, and
    // the store only ever issues sorted-set commands.
    expect('expire' in redis).toBe(false);
    expect(new Set(redis.calls)).toEqual(new Set(['zAdd', 'zCard', 'zRange', 'zRem']));
  });

  it('clears an existing history with one DEL and leaves no rows', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(1));
    await history.append('user', record(2));

    await expect(history.clear('user')).resolves.toBe(true);
    expect(redis.calls).toEqual(['zAdd', 'zAdd', 'del']); // exactly one DEL
    expect(await history.load('user')).toEqual([]);
    expect(await history.summary('user')).toEqual({ total: 0, latestAt: undefined });
  });

  it('reports success when clearing a user with no history', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);

    await expect(history.clear('missing')).resolves.toBe(true);
    expect(redis.calls).toEqual(['del']);
  });

  it('reports failure and logs when redis fails during clear', async () => {
    const redis = new FakeZSetRedis();
    const history = createHistoryStore(redis);
    await history.append('user', record(1));
    redis.fail = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(history.clear('user')).resolves.toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]?.[0])).toContain(
        '[history] clear modactions:z:user:user failed: redis down'
      );
      // A failed DEL means the key must be untouched once redis recovers.
      redis.fail = false;
      expect(await history.load('user')).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });
});
