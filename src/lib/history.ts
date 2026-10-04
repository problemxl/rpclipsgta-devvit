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
  /** Pending rows represent an action whose Reddit outcome is unresolved. */
  readonly state?: 'pending';
}

/** Row count plus the newest action time, without parsing any member payload. */
export interface HistorySummary {
  readonly total: number;
  readonly latestAt: number | undefined;
}

/** Ownership proof used by the only history compensation path. */
export interface HistoryMutationOwner {
  readonly redis: RedisLeaseStore;
  readonly key: string;
  readonly token: string;
}

/** A strict read used by destructive test tooling that must fail closed. */
export type StrictHistorySummary =
  | { readonly ok: true; readonly summary: HistorySummary }
  | { readonly ok: false };

/** Strict full-history read used by exact seed verification and retry blocking. */
export type StrictHistoryRows =
  | { readonly ok: true; readonly rows: ModActionRecord[] }
  | { readonly ok: false };

/** The stored record (including its generated id) and whether the write landed. */
export interface AppendOutcome {
  readonly ok: boolean;
  readonly record: ModActionRecord;
}

/**
 * Failure policy: ordinary reads/writes log and return degraded results for
 * non-destructive callers. Punishment uses summaryStrict() and fails closed;
 * owned compensation returns false unless ownership and the transaction are
 * both proven.
 */
export interface HistoryStore {
  /**
   * Add one row to the sorted set. The id is assigned here, so the returned
   * record is the identity to use for later compensation removals.
   */
  append(username: string, record: Omit<ModActionRecord, 'id'>): Promise<AppendOutcome>;
  /**
   * O(1)-ish ZCARD plus the newest row's score, clamped to now + 60s so a
   * future-dated corrupt member can never freeze decay; rung selection needs
   * no more.
   */
  summary(username: string): Promise<HistorySummary>;
  /**
   * Read a summary without converting Redis failures into an empty history.
   * Callers that make exact or destructive decisions must use this method.
   */
  summaryStrict(username: string): Promise<StrictHistorySummary>;
  /** All retained records, oldest first. Corrupt members are dropped silently. */
  load(username: string): Promise<ModActionRecord[]>;
  /** Read every member strictly; corruption or Redis failure returns ok:false. */
  loadStrict(username: string): Promise<StrictHistoryRows>;
  /** Remove one row by id for explicitly owned maintenance. */
  remove(username: string, id: string): Promise<boolean>;
  /** Remove a pending row only while the owner token remains held. */
  removeOwned(
    username: string,
    id: string,
    owner: HistoryMutationOwner
  ): Promise<boolean>;
  /** Mark a pending row applied only while the owner token remains held. */
  markApplied(
    username: string,
    id: string,
    owner: HistoryMutationOwner
  ): Promise<boolean>;
  /**
   * Delete the user's ENTIRE history (dev/QA seed tooling). A missing key is
   * still a success — the post-state is "no history" either way.
   */
  clear(username: string): Promise<boolean>;
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
 * commands plus the DEL used by clear(), with signatures matching the
 * installed @devvit/redis client. Appends are a single atomic ZADD — there is
 * no read-modify-write and therefore no lost-update window between concurrent
 * actions.
 */
export interface RedisLike {
  zAdd(key: string, ...members: RedisZMember[]): Promise<number>;
  del(key: string): Promise<unknown>;
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
 * The installed Devvit client returns `OK` on success and an empty string
 * when NX/XX rejects the write.
 */
export interface RedisStringLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: RedisSetOptions): Promise<string | undefined>;
  del(key: string): Promise<unknown>;
}

/** The transaction subset used for compare-and-delete lock operations. */
export type RedisLeaseTransaction = {
  multi(): Promise<void>;
  del(...keys: string[]): Promise<RedisLeaseTransaction>;
  zRem(key: string, members: string[]): Promise<RedisLeaseTransaction>;
  zAdd(key: string, ...members: RedisZMember[]): Promise<RedisLeaseTransaction>;
  discard(): Promise<void>;
} & Record<'exec', () => Promise<unknown[] | undefined>>;

/** RedisStringLike plus the installed Devvit WATCH transaction API. */
export interface RedisLeaseStore extends RedisStringLike {
  watch(...keys: string[]): Promise<RedisLeaseTransaction>;
}

/**
 * The per-user sorted-set key. The `z:` segment versions the layout: the
 * original implementation stored a JSON array STRING under
 * `modactions:user:{username}`, and reusing that key with sorted-set commands
 * would fail with WRONGTYPE. The old key is simply orphaned; no migration is
 * attempted.
 */
export function historyKey(username: string): string {
  return `modactions:z:user:${username.toLowerCase()}`;
}

/** Best-effort message extraction for degraded-mode error logging. */
function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    typeof record.targetThingId === 'string' &&
    (record.state === undefined || record.state === 'pending')
  );
}

/**
 * Row ids must be unique even for identical records in the same millisecond:
 * ZADD overwrites an existing member (updating its score), so a shared id
 * would silently collapse two distinct infractions into one row.
 *
 * `crypto.randomUUID()` (standard in Node 16.7+ and modern runtimes; a global
 * here) is used purely for uniqueness, not security — unlike `Math.random()
 * .toString(36)`, it can never yield an empty suffix (Math.random() === 0).
 */
function newRecordId(at: number): string {
  return `${at}-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
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
  async function readSummary(
    username: string,
    clampFuture = true
  ): Promise<HistorySummary> {
    const key = historyKey(username);
    // ZCARD counts raw members, corrupt payloads included.
    const total = await redis.zCard(key);
    // Rank -1 is the highest-score member. The score is structural, so no
    // member payload is parsed and corrupt rows cannot break the summary.
    const [latest] = await redis.zRange(key, -1, -1);
    // Freeze guard: a corrupt member with a future epoch-ms score would
    // otherwise pin latestAt in the future indefinitely, keeping the
    // ladder's quiet time at zero and freezing decay for as long as the
    // score lies ahead. Clamp to now + 60s.
    const latestAt = latest
      ? clampFuture
        ? Math.min(latest.score, Date.now() + 60_000)
        : latest.score
      : undefined;
    return { total, latestAt };
  }

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
      } catch (error) {
        // Degradation: the action still proceeds without a history row
        // (ok:false), but the failed write must show up in the logs.
        console.error(`[history] append ${historyKey(username)} failed: ${failureDetail(error)}`);
        return { ok: false, record: stored };
      }
    },

    async summary(username) {
      const key = historyKey(username);
      try {
        return await readSummary(username);
      } catch (error) {
        // Non-strict summary is retained for callers that explicitly accept
        // degraded reads. Punishment and exact tooling use strict methods.
        console.error(`[history] summary ${key} failed: ${failureDetail(error)}`);
        return { total: 0, latestAt: undefined };
      }
    },

    async summaryStrict(username) {
      const key = historyKey(username);
      try {
        // Exact tooling uses the stored score so a deterministic injected
        // clock can verify the requested age without a host-clock clamp.
        return { ok: true, summary: await readSummary(username, false) };
      } catch (error) {
        console.error(`[history] strict summary ${key} failed: ${failureDetail(error)}`);
        return { ok: false };
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
      } catch (error) {
        // Degradation: an unreadable history is treated as empty, but the
        // failure must show up in the logs.
        console.error(`[history] load ${historyKey(username)} failed: ${failureDetail(error)}`);
        return [];
      }
    },

    async loadStrict(username) {
      try {
        const rows = await redis.zRange(historyKey(username), 0, -1);
        const records: ModActionRecord[] = [];
        for (const row of rows) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(row.member);
          } catch {
            console.error(`[history] strict load ${historyKey(username)} found invalid JSON`);
            return { ok: false };
          }
          if (!isModActionRecord(parsed) || parsed.at !== row.score) {
            console.error(`[history] strict load ${historyKey(username)} found an invalid member`);
            return { ok: false };
          }
          records.push(parsed);
        }
        return { ok: true, rows: records };
      } catch (error) {
        console.error(`[history] strict load ${historyKey(username)} failed: ${failureDetail(error)}`);
        return { ok: false };
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
              await redis.zRem(key, [row.member]);
              return true;
            }
          } catch {
            // Unparseable members can never match an id; skip them.
          }
        }
        console.debug(`[history] remove miss for ${username}: no record with id=${id}`);
        return true;
      } catch (error) {
        console.error(`[history] remove ${historyKey(username)} failed: ${failureDetail(error)}`);
        return false;
      }
    },

    async markApplied(username, id, owner) {
      try {
        const key = historyKey(username);
        const transaction = await owner.redis.watch(owner.key, key);
        let committed = false;
        try {
          const rows = await redis.zRange(key, 0, -1);
          const match = rows.find((row) => {
            try {
              const parsed: unknown = JSON.parse(row.member);
              return isModActionRecord(parsed) && parsed.id === id && parsed.state === 'pending';
            } catch {
              return false;
            }
          });
          if (!match) {
            await transaction.discard();
            committed = true;
            return false;
          }
          const current = await owner.redis.get(owner.key);
          if (current !== owner.token) return false;
          await transaction.multi();
          const parsed = JSON.parse(match.member) as ModActionRecord;
          const { state: _pending, ...applied } = parsed;
          void _pending;
          const serialized = JSON.stringify(applied);
          await transaction.zRem(key, [match.member]);
          await transaction.zAdd(key, { member: serialized, score: match.score });
          const commit = transaction as RedisLeaseTransaction & Record<'exec', () => Promise<unknown[] | undefined>>;
          const result = await commit['exec']();
          committed = true;
          return Boolean(result && result.length > 0);
        } finally {
          if (!committed) {
            try { await transaction.discard(); } catch (error) {
              console.error(`[history] mark-applied discard failed: ${failureDetail(error)}`);
            }
          }
        }
      } catch (error) {
        console.error(`[history] mark applied ${historyKey(username)} failed: ${failureDetail(error)}`);
        return false;
      }
    },

    async removeOwned(username, id, owner) {
      try {
        const key = historyKey(username);
        const transaction = await owner.redis.watch(owner.key, key);
        let committed = false;
        try {
          const rows = await redis.zRange(key, 0, -1);
          const match = rows.find((row) => {
            try {
              const parsed: unknown = JSON.parse(row.member);
              return isModActionRecord(parsed) && parsed.id === id;
            } catch {
              return false;
            }
          });
          if (!match) {
            console.debug(`[history] owned remove miss for ${username}: no record with id=${id}`);
            await transaction.discard();
            committed = true;
            return true;
          }
          const current = await owner.redis.get(owner.key);
          if (current !== owner.token) {
            return false;
          }
          await transaction.multi();
          await transaction.zRem(key, [match.member]);
          const commit = transaction as RedisLeaseTransaction & Record<'exec', () => Promise<unknown[] | undefined>>;
          const result = await commit['exec']();
          committed = true;
          // Empty/undefined EXEC means WATCH aborted and no history changed.
          return Boolean(result && result.length > 0);
        } finally {
          if (!committed) {
            try {
              await transaction.discard();
            } catch (discardError) {
              console.error(`[history] owned remove discard failed: ${failureDetail(discardError)}`);
            }
          }
        }
      } catch (error) {
        console.error(`[history] owned remove ${historyKey(username)} failed: ${failureDetail(error)}`);
        return false;
      }
    },

    async clear(username) {
      try {
        // DEL of a missing key resolves normally and deletes nothing; both
        // paths leave the user with no history, so both report success.
        await redis.del(historyKey(username));
        return true;
      } catch (error) {
        // Degradation: the seed caller treats false as "history may still
        // exist", but the failure must show up in the logs.
        console.error(`[history] clear ${historyKey(username)} failed: ${failureDetail(error)}`);
        return false;
      }
    },
  };
}
