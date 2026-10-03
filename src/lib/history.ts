/** Redis-backed history for actions executed by this app. */

export interface ModActionRecord {
  readonly at: number;
  readonly rule: number;
  readonly action: 'warn' | 'ban';
  readonly label: string;
  readonly modUser: string;
  readonly targetThingId: string;
}

export interface HistoryStore {
  load(username: string): Promise<ModActionRecord[]>;
  append(username: string, record: ModActionRecord): Promise<boolean>;
  /** Remove one matching record during execution-failure compensation. */
  remove?(username: string, record: ModActionRecord): Promise<boolean>;
}

/** Options for Redis SET, mirroring the installed @devvit/redis SetOptions. */
export interface RedisSetOptions {
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly expiration?: Date;
}

/**
 * The small structural Redis subset shared by the history store, the punish
 * lock, and the removal flow. It matches the installed @devvit/redis client:
 * SET resolves to a string on success and to undefined when NX/XX fails.
 */
export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
}

/** Five effective levels × 90 days, plus a 90-day retention buffer. */
export const HISTORY_TTL_DAYS = 540;
export const HISTORY_MAX_RECORDS = 50;

export function historyKey(username: string): string {
  return `modactions:user:${username.toLowerCase()}`;
}

function isModActionRecord(value: unknown): value is ModActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ModActionRecord>;
  return (
    typeof record.at === 'number' &&
    Number.isFinite(record.at) &&
    (record.action === 'warn' || record.action === 'ban') &&
    typeof record.rule === 'number' &&
    Number.isInteger(record.rule) &&
    record.rule >= 1 &&
    record.rule <= 12 &&
    typeof record.label === 'string' &&
    typeof record.modUser === 'string' &&
    typeof record.targetThingId === 'string'
  );
}

function parseHistory(value: string | undefined): ModActionRecord[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isModActionRecord) : [];
  } catch {
    return [];
  }
}

/**
 * Construct a Redis-backed action history. JSON strings are used deliberately:
 * the Devvit Redis client supports strings, hashes, lists, and sorted sets, but
 * a bounded JSON array keeps the record shape and ordering together.
 */
export function createHistoryStore(redis: RedisLike): HistoryStore {
  return {
    async load(username: string): Promise<ModActionRecord[]> {
      try {
        return parseHistory(await redis.get(historyKey(username)));
      } catch {
        return [];
      }
    },

    async append(username: string, record: ModActionRecord): Promise<boolean> {
      try {
        const key = historyKey(username);
        const records = parseHistory(await redis.get(key));
        records.push(record);
        const recent = records.slice(-HISTORY_MAX_RECORDS);
        const result = await redis.set(key, JSON.stringify(recent), {
          expiration: new Date(Date.now() + HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000),
        });
        return typeof result === 'string';
      } catch {
        return false;
      }
    },

    async remove(username: string, record: ModActionRecord): Promise<boolean> {
      try {
        const key = historyKey(username);
        const records = parseHistory(await redis.get(key));
        const index = records.findIndex((candidate) => candidate === record || isSameRecord(candidate, record));
        if (index < 0) return true;
        records.splice(index, 1);
        const result = await redis.set(key, JSON.stringify(records.slice(-HISTORY_MAX_RECORDS)), {
          expiration: new Date(Date.now() + HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000),
        });
        return typeof result === 'string';
      } catch {
        return false;
      }
    },
  };
}

function isSameRecord(left: ModActionRecord, right: ModActionRecord): boolean {
  return (
    left.at === right.at &&
    left.rule === right.rule &&
    left.action === right.action &&
    left.label === right.label &&
    left.modUser === right.modUser &&
    left.targetThingId === right.targetThingId
  );
}
