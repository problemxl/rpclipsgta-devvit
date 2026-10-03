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
}

/** The string Redis operations used by the history store. */
export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: { readonly expiration?: Date }
  ): Promise<string | undefined>;
  del?(key: string): Promise<unknown>;
}

export const HISTORY_TTL_DAYS = 400;
export const HISTORY_MAX_RECORDS = 50;

export function historyKey(username: string): string {
  return `modactions:user:${username.toLowerCase()}`;
}

function parseHistory(value: string | undefined): ModActionRecord[] {
  if (value === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ModActionRecord[]) : [];
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
        await redis.set(key, JSON.stringify(recent), {
          expiration: new Date(Date.now() + HISTORY_TTL_DAYS * 24 * 60 * 60 * 1000),
        });
        return true;
      } catch {
        return false;
      }
    },
  };
}
