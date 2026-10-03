import { describe, expect, it, vi } from 'vitest';

import {
  createHistoryStore,
  historyKey,
  HISTORY_TTL_DAYS,
  type RedisLike,
  type ModActionRecord,
} from '../src/lib/history.js';

const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  fail = false;
  /** Overrides the SET resolution; undefined simulates a rejected write. */
  setResult: string | undefined = 'OK';

  async get(key: string): Promise<string | undefined> {
    if (this.fail) throw new Error('redis down');
    return this.values.get(key);
  }

  async set(
    key: string,
    value: string,
    options?: { expiration?: Date }
  ): Promise<string | undefined> {
    if (this.fail) throw new Error('redis down');
    if (this.setResult === undefined) return undefined;
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return this.setResult;
  }

  async del(key: string): Promise<void> {
    if (this.fail) throw new Error('redis down');
    this.values.delete(key);
    this.expirations.delete(key);
  }
}

function record(at: number): ModActionRecord {
  return { at, rule: 2, action: 'ban', label: '3 day ban', modUser: 'mod', targetThingId: 't3_x' };
}

describe('history store', () => {
  it('uses a lowercased per-user key', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    await history.append('SomeUser', record(1));
    expect(historyKey('someuser')).toBe('modactions:user:someuser');
    await expect(history.load('SOMEUSER')).resolves.toEqual([record(1)]);
  });

  it('returns an empty history for missing and malformed values', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    await expect(history.load('missing')).resolves.toEqual([]);
    redis.values.set(historyKey('bad'), '{not json');
    await expect(history.load('bad')).resolves.toEqual([]);
    redis.fail = true;
    await expect(history.load('failure')).resolves.toEqual([]);
  });

  it('keeps only the 50 most recent records and refreshes the 540-day TTL', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    for (let at = 0; at < 55; at += 1) await history.append('user', record(at));
    const records = await history.load('user');
    expect(records).toHaveLength(50);
    expect(records[0].at).toBe(5);
    expect(records.at(-1)?.at).toBe(54);
    const expiration = redis.expirations.get(historyKey('user'));
    expect(expiration?.getTime()).toBeGreaterThan(Date.now() + (HISTORY_TTL_DAYS - 1) * DAY_MS);
    expect(expiration?.getTime()).toBeLessThanOrEqual(Date.now() + HISTORY_TTL_DAYS * DAY_MS);
  });

  it('reports false when Redis append fails', async () => {
    const redis = new MemoryRedis();
    redis.fail = true;
    await expect(createHistoryStore(redis).append('user', record(1))).resolves.toBe(false);
  });

  it('reports false when SET resolves undefined', async () => {
    const redis = new MemoryRedis();
    redis.setResult = undefined;
    const history = createHistoryStore(redis);
    await expect(history.append('user', record(1))).resolves.toBe(false);
    await expect(history.load('user')).resolves.toEqual([]);
  });

  it('drops non-object and primitive array elements on load', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    redis.values.set(historyKey('junk'), JSON.stringify([null, 1, 'nope', true]));
    await expect(history.load('junk')).resolves.toEqual([]);
  });

  it('drops records with invalid fields on load', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    const invalid = [
      {}, // missing everything
      { at: 'yesterday', rule: 2, action: 'ban', label: 'b', modUser: 'm', targetThingId: 't3_x' }, // non-number at
      { at: Number.NaN, rule: 2, action: 'ban', label: 'b', modUser: 'm', targetThingId: 't3_x' }, // non-finite at
      { at: 1, rule: 13, action: 'ban', label: 'b', modUser: 'm', targetThingId: 't3_x' }, // rule out of range
      { at: 1, rule: 2.5, action: 'ban', label: 'b', modUser: 'm', targetThingId: 't3_x' }, // non-integer rule
      { at: 1, rule: 2, action: 'mute', label: 'b', modUser: 'm', targetThingId: 't3_x' }, // unknown action
      { at: 1, rule: 2, action: 'ban', label: 7, modUser: 'm', targetThingId: 't3_x' }, // non-string label
      { at: 1, rule: 2, action: 'ban', label: 'b', modUser: null, targetThingId: 't3_x' }, // non-string modUser
      { at: 1, rule: 2, action: 'ban', label: 'b', modUser: 'm', targetThingId: 42 }, // non-string target
    ];
    redis.values.set(historyKey('invalid'), JSON.stringify(invalid));
    await expect(history.load('invalid')).resolves.toEqual([]);
  });

  it('keeps only the valid records of a mixed array on load', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    const valid = record(123);
    const mixed = [null, valid, { at: 1 }, { ...valid, rule: 0 }];
    redis.values.set(historyKey('mixed'), JSON.stringify(mixed));
    await expect(history.load('mixed')).resolves.toEqual([valid]);
  });

  it('removes one matching record and reports misses', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    const first = record(1);
    const second = record(2);
    await history.append('user', first);
    await history.append('user', second);

    await expect(history.remove!('user', record(999))).resolves.toBe(true); // miss is a no-op success
    await expect(history.load('user')).resolves.toEqual([first, second]);

    await expect(history.remove!('user', { ...first })).resolves.toBe(true);
    await expect(history.load('user')).resolves.toEqual([second]);
  });

  it('logs a debug line on a remove miss while still reporting success', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      // A miss is a documented no-op success, but it must stay visible so
      // compensation anomalies can be diagnosed.
      await expect(history.remove!('user', record(999))).resolves.toBe(true);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(String(debug.mock.calls[0]?.[0])).toContain('[history] remove miss for user');
    } finally {
      debug.mockRestore();
    }
  });
});
