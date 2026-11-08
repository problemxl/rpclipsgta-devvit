import { describe, expect, it, vi } from 'vitest';

import {
  HISTORY_MIRROR_ACTIVE_PAGE_KEY,
  HISTORY_MIRROR_LOCK_KEY,
  HISTORY_MIRROR_ROTATION_BYTES,
  mirrorAppend,
  serializeMirrorLine,
  type HistoryMirrorDeps,
} from '../src/lib/history-mirror.js';
import type {
  ModActionRecord,
  RedisLeaseStore,
  RedisLeaseTransaction,
  RedisSetOptions,
  RedisZMember,
} from '../src/lib/history.js';

class FakeRedis implements RedisLeaseStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | undefined> {
    if (options?.nx && this.values.has(key)) return undefined;
    if (options?.xx && !this.values.has(key)) return undefined;
    this.values.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async watch(...keys: string[]): Promise<RedisLeaseTransaction> {
    const snapshot = new Map(keys.map((key) => [key, this.values.get(key)]));
    const redis = this;
    let queuedDelete: string[] = [];
    let multiStarted = false;
    const transaction: RedisLeaseTransaction = {
      async multi() { multiStarted = true; },
      async del(...names: string[]) {
        queuedDelete = names;
        return transaction;
      },
      async zRem(_key: string, _members: string[]) { return transaction; },
      async zAdd(_key: string, ..._members: RedisZMember[]) { return transaction; },
      async exec() {
        if (!multiStarted) throw new Error('MULTI required');
        if (keys.some((key) => redis.values.get(key) !== snapshot.get(key))) return [];
        for (const key of queuedDelete) await redis.del(key);
        return queuedDelete.map(() => 1);
      },
      async discard() { queuedDelete = []; },
    };
    return transaction;
  }
}

const record: ModActionRecord = {
  id: '1700000000000-1',
  at: Date.UTC(2025, 0, 3),
  rule: 2,
  action: 'warn',
  label: 'Warning',
  modUser: 'Moderator',
  targetThingId: 't3_post',
};

type TestMirrorDeps = Omit<HistoryMirrorDeps, 'redis' | 'updateWikiPage'> & {
  redis: FakeRedis;
  updateWikiPage: HistoryMirrorDeps['updateWikiPage'];
  writes: Array<{ page: string; content: string }>;
};

function deps(redis = new FakeRedis(), pages = new Map<string, string>()): TestMirrorDeps {
  const writes: Array<{ page: string; content: string }> = [];
  return {
    redis,
    getWikiPage: async (_subredditName, page) => pages.get(page),
    updateWikiPage: async (_subredditName, page, content) => {
      pages.set(page, content);
      writes.push({ page, content });
    },
    sleep: async () => undefined,
    writes,
  };
}

describe('history wiki mirror', () => {
  it('appends one normalized-username JSONL row', async () => {
    const current = deps();

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: ' Target_User ',
      record,
    });

    const line = serializeMirrorLine('Target_User', record);
    expect(current.writes).toEqual([{ page: 'escalation-log/2025-01', content: line }]);
    expect(JSON.parse(line)).toEqual({ username: 'target_user', ...record });
  });

  it('rotates before an append would exceed the 450 KiB budget', async () => {
    const pages = new Map<string, string>();
    const line = serializeMirrorLine('Target_User', record);
    pages.set('escalation-log/2025-01', 'x'.repeat(HISTORY_MIRROR_ROTATION_BYTES - line.length + 1));
    const redis = new FakeRedis();
    redis.values.set(HISTORY_MIRROR_ACTIVE_PAGE_KEY, 'escalation-log/2025-01');
    const current = deps(redis, pages);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record,
    });

    expect(current.writes).toEqual([{ page: 'escalation-log/2025-01-2', content: line }]);
    expect(redis.values.get(HISTORY_MIRROR_ACTIVE_PAGE_KEY)).toBe('escalation-log/2025-01-2');
    expect(pages.get('escalation-log/2025-01')).toHaveLength(
      HISTORY_MIRROR_ROTATION_BYTES - line.length + 1
    );
  });

  it('refuses pending rows without acquiring the wiki lock', async () => {
    const current = deps();
    const pending = { ...record, state: 'pending' as const };

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record: pending,
    });

    expect(current.writes).toEqual([]);
    expect(current.redis.values.has(HISTORY_MIRROR_LOCK_KEY)).toBe(false);
  });

  it('swallows wiki write failures and logs them', async () => {
    const current = deps();
    current.updateWikiPage = async () => {
      throw new Error('wiki unavailable');
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record,
    })).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('wiki unavailable'));
    expect(current.redis.values.has(HISTORY_MIRROR_LOCK_KEY)).toBe(false);
    error.mockRestore();
  });

  it('fails safely under lock contention without losing the first append', async () => {
    const current = deps();
    current.redis.values.set(HISTORY_MIRROR_LOCK_KEY, 'another-writer');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Second_User',
      record,
    });

    expect(current.writes).toEqual([]);
    expect(current.redis.values.get(HISTORY_MIRROR_LOCK_KEY)).toBe('another-writer');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not acquire wiki append lock'));
    error.mockRestore();
  });
});
