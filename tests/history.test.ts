import { describe, expect, it } from 'vitest';

import {
  createHistoryStore,
  historyKey,
  type RedisLike,
  type ModActionRecord,
} from '../src/lib/history.js';

class MemoryRedis implements RedisLike {
  readonly values = new Map<string, string>();
  readonly expirations = new Map<string, Date>();
  fail = false;

  async get(key: string): Promise<string | undefined> {
    if (this.fail) throw new Error('redis down');
    return this.values.get(key);
  }

  async set(key: string, value: string, options?: { expiration?: Date }): Promise<string> {
    if (this.fail) throw new Error('redis down');
    this.values.set(key, value);
    if (options?.expiration) this.expirations.set(key, options.expiration);
    return 'OK';
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

  it('keeps only the 50 most recent records and refreshes the 400-day TTL', async () => {
    const redis = new MemoryRedis();
    const history = createHistoryStore(redis);
    for (let at = 0; at < 55; at += 1) await history.append('user', record(at));
    const records = await history.load('user');
    expect(records).toHaveLength(50);
    expect(records[0].at).toBe(5);
    expect(records.at(-1)?.at).toBe(54);
    expect(redis.expirations.get(historyKey('user'))).toBeInstanceOf(Date);
  });

  it('reports false when Redis append fails', async () => {
    const redis = new MemoryRedis();
    redis.fail = true;
    await expect(createHistoryStore(redis).append('user', record(1))).resolves.toBe(false);
  });
});
