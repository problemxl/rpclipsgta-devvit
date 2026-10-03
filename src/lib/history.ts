/** Redis-backed history for actions executed by this app. */

export interface ModActionRecord {
  /**
   * Unique row identity, minted by append(). Uniqueness is what keeps
   * identical records in the same millisecond from overwriting each other.
   */
  readonly id: string;
  readonly at: number;
  readonly rule: number;
  readonly action: 'warn' | 'ban';
  readonly label: string;
  readonly modUser: string;
  readonly targetThingId: string;
}

/** Row count plus the newest action time, without parsing any member payload. */
export interface HistorySummary {
  readonly total: number;
  readonly latestAt: number | undefined;
}

/** The stored record (including its generated id) and whether the write landed. */
export interface AppendOutcome {
  readonly ok: boolean;
  readonly record: ModActionRecord;
}

export interface HistoryStore {
  /**
   * Add one row to the sorted set. The id is assigned here, so the returned
   * record is the identity to use for later compensation removals.
   */
  append(username: string, record: Omit<ModActionRecord, 'id'>): Promise<AppendOutcome>;
  /** O(1)-ish ZCARD plus the newest row's score; rung selection needs no more. */
  summary(username: string): Promise<HistorySummary>;
  /** All retained records, oldest first. Corrupt members are dropped silently. */
  load(username: string): Promise<ModActionRecord[]>;
  /** Remove one row by id during execution-failure compensation. */
  remove(username: string, id: string): Promise<boolean>;
}

/** One sorted-set member, mirroring @devvit/redis ZMember. */
export interface RedisZMember {
  readonly member: string;
  readonly score: number;
}

/**
 * Options for ZRANGE, mirroring the installed @devvit/redis ZRangeOptions
 * (rank/score/lex selection with optional reverse and limit). Note the real
 * client requires `by` whenever options are supplied; this store only uses
 * the plain rank form without options.
 */
export interface RedisZRangeOptions {
  readonly reverse?: boolean;
  readonly by: 'score' | 'lex' | 'rank';
  readonly limit?: { readonly offset: number; readonly count: number };
}

/**
 * The structural Redis subset the history store actually uses: sorted-set
 * commands only, with signatures matching the installed @devvit/redis client.
 * Appends are a single atomic ZADD — there is no read-modify-write and
 * therefore no lost-update window between concurrent actions.
 */
export interface RedisLike {
  zAdd(key: string, ...members: RedisZMember[]): Promise<number>;
  zRange(
    key: string,
    start: number,
    stop: number,
    options?: RedisZRangeOptions
  ): Promise<RedisZMember[]>;
  zRem(key: string, members: string[]): Promise<number>;
  zCard(key: string): Promise<number>;
}

/** Options for Redis SET, mirroring the installed @devvit/redis SetOptions. */
export interface RedisSetOptions {
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly expiration?: Date;
}

/**
 * The string-command subset shared by the punish lock and the removal flow.
 * SET resolves to a string on success and to undefined when NX/XX fails.
 */
export interface RedisStringLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
}

export function historyKey(username: string): string {
  return `modactions:user:${username.toLowerCase()}`;
}

function isModActionRecord(value: unknown): value is ModActionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<ModActionRecord>;
  return (
    typeof record.id === 'string' &&
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

/**
 * Row ids must be unique even for identical records in the same millisecond:
 * ZADD overwrites an existing member (updating its score), so a shared id
 * would silently collapse two distinct infractions into one row.
 */
function newRecordId(at: number): string {
  return `${at}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Construct a Redis-backed action history stored as one sorted set per user:
 * every infraction is a member (the record JSON, including its unique id)
 * scored by its epoch-ms timestamp.
 *
 * Owner decision: the ENTIRE history is retained — there is no record cap and
 * no TTL, and none may be reintroduced. Lifetime retention never over-punishes
 * because the ladder decays one effective prior per full 90-day quiet stretch
 * since the latest action (src/lib/ladder.ts), so old rows preserve the audit
 * trail without changing the rung a long-quiet user receives.
 */
export function createHistoryStore(redis: RedisLike): HistoryStore {
  return {
    async append(username, record) {
      // Mint the id here so the persisted member and the returned record are
      // the same source of truth for compensation identity.
      const stored: ModActionRecord = { ...record, id: newRecordId(record.at) };
      try {
        // One atomic ZADD; a 0 means the write did not land as a new row.
        const added = await redis.zAdd(historyKey(username), {
          member: JSON.stringify(stored),
          score: stored.at,
        });
        return { ok: added > 0, record: stored };
      } catch {
        return { ok: false, record: stored };
      }
    },

    async summary(username) {
      try {
        const key = historyKey(username);
        // ZCARD counts raw members, corrupt payloads included.
        const total = await redis.zCard(key);
        // Rank -1 is the highest-score member. The score is structural, so no
        // member payload is parsed and corrupt rows cannot break the summary.
        const [latest] = await redis.zRange(key, -1, -1);
        return { total, latestAt: latest?.score };
      } catch {
        return { total: 0, latestAt: undefined };
      }
    },

    async load(username) {
      try {
        // ZRANGE over the whole set is score-ascending: oldest first, with no
        // post-sorting needed and the full lifetime history returned.
        const rows = await redis.zRange(historyKey(username), 0, -1);
        const records: ModActionRecord[] = [];
        for (const row of rows) {
          try {
            const parsed: unknown = JSON.parse(row.member);
            if (isModActionRecord(parsed)) records.push(parsed);
          } catch {
            // A corrupt member is dropped silently, never thrown.
          }
        }
        return records;
      } catch {
        return [];
      }
    },

    async remove(username, id) {
      try {
        const key = historyKey(username);
        const rows = await redis.zRange(key, 0, -1);
        for (const row of rows) {
          try {
            const parsed: unknown = JSON.parse(row.member);
            if (isModActionRecord(parsed) && parsed.id === id) {
              // Remove the exact member string; nothing else is touched.
              await redis.zRem(key, [row.member]);
              return true;
            }
          } catch {
            // Unparseable members can never match an id; skip them.
          }
        }
        // Compensation anomalies (record already gone or never persisted)
        // stay visible; a miss remains a documented no-op success.
        console.debug(`[history] remove miss for ${username}: no record with id=${id}`);
        return true;
      } catch {
        return false;
      }
    },
  };
}
