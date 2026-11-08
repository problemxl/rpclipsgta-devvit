import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_MIRROR_ACTIVE_PAGE_KEY,
  HISTORY_MIRROR_LOCK_KEY,
  HISTORY_MIRROR_MAX_PAGE_BYTES,
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
  onGet?: (key: string) => Promise<void> | void;
  failActivePointerUpdate = false;

  async get(key: string): Promise<string | undefined> {
    const value = this.values.get(key);
    await this.onGet?.(key);
    return value;
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string | undefined> {
    if (this.failActivePointerUpdate && key === HISTORY_MIRROR_ACTIVE_PAGE_KEY) {
      throw new Error('active pointer unavailable');
    }
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

function deps(
  redis = new FakeRedis(),
  pages = new Map<string, string>(),
  overrides: Partial<Omit<HistoryMirrorDeps, 'redis'>> = {}
): TestMirrorDeps {
  const writes: Array<{ page: string; content: string }> = [];
  return {
    redis,
    getWikiPage: async (_subredditName, page) => pages.get(page),
    updateWikiPage: async (_subredditName, page, content) => {
      pages.set(page, content);
      writes.push({ page, content });
    },
    setWikiPageSettings: async () => undefined,
    sleep: async () => undefined,
    ...overrides,
    writes,
  };
}

afterEach(() => vi.restoreAllMocks());

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

  it('rotates before an append would exceed the 450 KiB UTF-8 budget', async () => {
    const pages = new Map<string, string>();
    const line = serializeMirrorLine('Target_User', record);
    const existing = 'x'.repeat(HISTORY_MIRROR_ROTATION_BYTES - new TextEncoder().encode(line).byteLength + 1);
    pages.set('escalation-log/2025-01', existing);
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
    expect(new TextEncoder().encode(pages.get('escalation-log/2025-01') ?? '').byteLength)
      .toBeLessThanOrEqual(HISTORY_MIRROR_MAX_PAGE_BYTES);
    expect(current.writes.every(({ content }) =>
      new TextEncoder().encode(content).byteLength <= HISTORY_MIRROR_MAX_PAGE_BYTES
    )).toBe(true);
  });

  it('measures multibyte usernames in UTF-8 and keeps the emitted page under the hard limit', async () => {
    const username = '😀'.repeat(100);
    const multibyteRecord = { ...record, id: 'multibyte-1' };
    const line = serializeMirrorLine(username, multibyteRecord);
    const pages = new Map<string, string>([
      ['escalation-log/2025-01', 'x'.repeat(HISTORY_MIRROR_ROTATION_BYTES - new TextEncoder().encode(line).byteLength + 1)],
    ]);
    const redis = new FakeRedis();
    redis.values.set(HISTORY_MIRROR_ACTIVE_PAGE_KEY, 'escalation-log/2025-01');
    const current = deps(redis, pages);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username,
      record: multibyteRecord,
    });

    expect(current.writes[0]?.page).toBe('escalation-log/2025-01-2');
    expect(current.writes.every(({ content }) =>
      new TextEncoder().encode(content).byteLength <= HISTORY_MIRROR_MAX_PAGE_BYTES
    )).toBe(true);
  });

  it('does not write an oversized single record', async () => {
    const current = deps();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'u'.repeat(HISTORY_MIRROR_MAX_PAGE_BYTES),
      record,
    });

    expect(current.writes).toEqual([]);
    expect(current.redis.values.has(HISTORY_MIRROR_ACTIVE_PAGE_KEY)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('exceeds wiki rotation budget'));
  });

  it('configures a new page before writing real content', async () => {
    const events: string[] = [];
    const current = deps(new FakeRedis(), new Map(), {
      setWikiPageSettings: async () => { events.push('settings'); },
      updateWikiPage: async (_subredditName, _page, content) => {
        events.push('write');
        current.writes.push({ page: 'escalation-log/2025-01', content });
      },
    });

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record,
    });

    expect(events).toEqual(['settings', 'write']);
  });

  it('does not let a stale writer overwrite a completed append after losing ownership', async () => {
    const pages = new Map<string, string>();
    const redis = new FakeRedis();
    let pageRead!: () => void;
    const pageReadGate = new Promise<void>((resolve) => { pageRead = resolve; });
    let pageReadStarted!: () => void;
    const pageReadStartedGate = new Promise<void>((resolve) => { pageReadStarted = resolve; });
    let firstRead = true;
    const writerA = deps(redis, pages, {
      tokenGenerator: () => 'writer-a',
      getWikiPage: async (_subredditName, page) => {
        const content = pages.get(page);
        if (firstRead) {
          firstRead = false;
          pageReadStarted();
          await pageReadGate;
        }
        return content;
      },
    });
    const writerB = deps(redis, pages, { tokenGenerator: () => 'writer-b' });

    const appendA = mirrorAppend(writerA, {
      subredditName: 'RPClipsGTA',
      username: 'writer-a',
      record: { ...record, id: 'record-a' },
    });
    await pageReadStartedGate;
    expect(redis.values.get(HISTORY_MIRROR_LOCK_KEY)).toContain('writer-a');

    // This simulates an operational takeover after a lease-expiry incident:
    // the expired lock is removed, then B acquires and completes its append
    // before A is allowed to resume.
    redis.values.delete(HISTORY_MIRROR_LOCK_KEY);
    const appendB = mirrorAppend(writerB, {
      subredditName: 'RPClipsGTA',
      username: 'writer-b',
      record: { ...record, id: 'record-b' },
    });
    await appendB;
    expect(writerB.writes).toHaveLength(1);
    pageRead();
    await appendA;

    expect(writerA.writes).toEqual([]);
    expect(writerB.writes[0]?.content).toContain('"id":"record-b"');
    expect(pages.get('escalation-log/2025-01')).toContain('"id":"record-b"');
    expect(pages.get('escalation-log/2025-01')).not.toContain('"id":"record-a"');
  });

  it('does not write a public page if privacy settings fail', async () => {
    const current = deps(new FakeRedis(), new Map(), {
      setWikiPageSettings: async () => { throw new Error('settings unavailable'); },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record,
    });

    expect(current.writes).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('settings unavailable'));
  });

  it('leaves the written row recoverable when the active pointer update fails', async () => {
    const redis = new FakeRedis();
    redis.failActivePointerUpdate = true;
    const pages = new Map<string, string>();
    const current = deps(redis, pages);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'Target_User',
      record,
    });

    expect(current.writes).toHaveLength(1);
    expect(pages.get('escalation-log/2025-01')).toContain(`\"id\":\"${record.id}\"`);
    expect(redis.values.has(HISTORY_MIRROR_ACTIVE_PAGE_KEY)).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('active pointer unavailable'));
  });

  it('does not rewrite closed pages across multiple rotations', async () => {
    const largeRecord = (id: string): ModActionRecord => ({
      ...record,
      id,
      targetThingId: `t3_${'x'.repeat(HISTORY_MIRROR_ROTATION_BYTES - 300)}`,
    });
    const current = deps();

    for (const id of ['large-a', 'large-b', 'large-c']) {
      await mirrorAppend(current, {
        subredditName: 'RPClipsGTA',
        username: 'Target_User',
        record: largeRecord(id),
      });
    }

    expect(current.writes.map(({ page }) => page)).toEqual([
      'escalation-log/2025-01',
      'escalation-log/2025-01-2',
      'escalation-log/2025-01-3',
    ]);
    expect(new Set(current.writes.map(({ page }) => page)).size).toBe(3);
    expect(current.writes.every(({ content }) =>
      new TextEncoder().encode(content).byteLength <= HISTORY_MIRROR_MAX_PAGE_BYTES
    )).toBe(true);
  });

  it('keeps late records on the active rotated page and starts a newer month page', async () => {
    const pages = new Map<string, string>([
      ['escalation-log/2025-01', 'closed page'],
    ]);
    const redis = new FakeRedis();
    redis.values.set(HISTORY_MIRROR_ACTIVE_PAGE_KEY, 'escalation-log/2025-01-2');
    const current = deps(redis, pages);

    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'late-user',
      record: { ...record, id: 'late-record', at: Date.UTC(2025, 0, 10) },
    });
    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'new-month-user',
      record: { ...record, id: 'new-month-record', at: Date.UTC(2025, 1, 1) },
    });
    await mirrorAppend(current, {
      subredditName: 'RPClipsGTA',
      username: 'late-again',
      record: { ...record, id: 'late-again', at: Date.UTC(2025, 0, 11) },
    });

    expect(current.writes.map(({ page }) => page)).toEqual([
      'escalation-log/2025-01-2',
      'escalation-log/2025-02',
      'escalation-log/2025-02',
    ]);
    expect(pages.get('escalation-log/2025-01')).toBe('closed page');
    expect(pages.get('escalation-log/2025-02')).toContain('late-again');
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
