/** Dev/QA-only, operator-directed reconciliation of one pending Reddit action. */

import type { HistoryStore, ModActionRecord, RedisLeaseStore } from '../lib/history.js';
import { DEV_QA_SUBREDDITS, isDevQaSubreddit } from '../lib/dev-qa.js';
import {
  acquireUserActionLock,
  assertUserActionLockHeld,
  releaseUserActionLock,
} from '../lib/user-lock.js';
import { mirrorAppend, type HistoryMirrorDeps } from '../lib/history-mirror.js';

export type PendingResolution = 'inspect' | 'applied' | 'not-applied';

export function parsePendingResolution(
  values: readonly string[] | undefined
): PendingResolution | undefined {
  if (!values || values.length !== 1) return undefined;
  return values[0] === 'inspect' || values[0] === 'applied' || values[0] === 'not-applied'
    ? values[0]
    : undefined;
}

export interface ReconcilePendingDeps {
  readonly history: HistoryStore;
  readonly redis: RedisLeaseStore;
  /** Current moderator membership; this action never calls Reddit to mutate. */
  readonly authorizeActor: (subredditName: string, actor: string) => Promise<boolean>;
  readonly now?: () => number;
  /** Best-effort Reddit wiki backup; Redis history remains authoritative. */
  readonly historyMirror?: HistoryMirrorDeps;
}

export interface ReconcilePendingInput {
  readonly subredditName: string;
  readonly actor: string;
  readonly username: string;
  readonly recordId: string;
  readonly resolution: PendingResolution;
  /** Required for either mutation; deliberately not needed for inspection. */
  readonly confirmExternalOutcome?: boolean;
}

type PendingIdentity = Pick<
  ModActionRecord,
  'id' | 'at' | 'action' | 'label' | 'modUser' | 'targetThingId' | 'rule'
>;

export type ReconcilePendingOutcome =
  | { readonly status: 'denied'; readonly detail?: string }
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'inspected'; readonly username: string; readonly record: PendingIdentity }
  | {
      readonly status: 'reconciled';
      readonly username: string;
      readonly recordId: string;
      readonly resolution: Exclude<PendingResolution, 'inspect'>;
    };

export type ReconcilePendingSafeOutcome =
  | ReconcilePendingOutcome
  | { readonly status: 'trigger-failed'; readonly detail: string };

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function audit(outcome: ReconcilePendingOutcome): ReconcilePendingOutcome {
  const username = 'username' in outcome ? ` u/${outcome.username}` : '';
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  console.log(`[reconcile] ${outcome.status}${username}${detail}`);
  return outcome;
}

function normalizeUsername(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/^u\//i, '').trim().toLowerCase() : '';
}

function validUsername(username: string): boolean {
  return /^[a-z0-9_-]{3,20}$/i.test(username);
}

function validRecordId(recordId: string): boolean {
  // IDs are generated as `${epoch}-${hex}`. Keep the input exact so an
  // operator cannot accidentally select a different sorted-set member.
  return /^\d{1,20}-[0-9a-f]{12}$/.test(recordId);
}

function identity(record: ModActionRecord): PendingIdentity {
  return {
    id: record.id,
    at: record.at,
    action: record.action,
    label: record.label,
    modUser: record.modUser,
    targetThingId: record.targetThingId,
    rule: record.rule,
  };
}

function findExactlyPending(rows: ModActionRecord[], recordId: string): ModActionRecord | undefined {
  const matches = rows.filter((row) => row.id === recordId);
  return matches.length === 1 && matches[0]?.state === 'pending' ? matches[0] : undefined;
}

function hasExactPendingId(rows: ModActionRecord[], recordId: string): boolean {
  return rows.filter((row) => row.id === recordId && row.state === 'pending').length === 1;
}

/**
 * Inspect or reconcile one exact pending row in an allowlisted dev/QA
 * installation. The moderator must inspect Reddit's modlog and target state
 * outside this action and choose only a definite applied/not-applied result.
 * Unknown outcomes have no mutation path.
 */
export async function reconcilePending(
  deps: ReconcilePendingDeps,
  input: ReconcilePendingInput
): Promise<ReconcilePendingOutcome> {
  // Environment guard is intentionally first: a replay in production must not
  // authorize, normalize, acquire a lock, or read history.
  if (!isDevQaSubreddit(input.subredditName)) {
    console.error(
      `[reconcile] DENIED subreddit '${input.subredditName}' — dev/QA only ` +
        `(${DEV_QA_SUBREDDITS.join(', ')}); no state was inspected or changed`
    );
    return audit({ status: 'denied' });
  }

  try {
    const actor = typeof input.actor === 'string' ? input.actor.trim() : '';
    if (!actor) return audit({ status: 'denied', detail: 'acting moderator is required' });
    try {
      if (!(await deps.authorizeActor(input.subredditName.trim(), actor))) {
        return audit({ status: 'denied', detail: 'acting user is not a moderator' });
      }
    } catch (error) {
      console.error(`[reconcile] moderator authorization failed: ${detailOf(error)}`);
      return audit({ status: 'denied', detail: 'moderator authorization could not be verified' });
    }

    const username = normalizeUsername(input.username);
    if (!validUsername(username)) {
      return audit({ status: 'invalid', detail: 'username must be a valid Reddit username' });
    }
    const recordId = typeof input.recordId === 'string' ? input.recordId.trim() : '';
    if (!validRecordId(recordId)) {
      return audit({ status: 'invalid', detail: 'recordId must be the exact pending record id' });
    }
    if (input.resolution !== 'inspect' && input.resolution !== 'applied' && input.resolution !== 'not-applied') {
      return audit({ status: 'invalid', detail: 'resolution must be inspect, applied, or not-applied' });
    }
    if (input.resolution !== 'inspect' && input.confirmExternalOutcome !== true) {
      return audit({
        status: 'invalid',
        detail: 'confirm that Reddit was inspected and the outcome is definite',
      });
    }

    let lock;
    try {
      lock = await acquireUserActionLock(deps.redis, username, actor, deps.now ?? Date.now);
    } catch (error) {
      const detail = detailOf(error);
      return audit({ status: 'failed', detail: `could not acquire reconciliation lock: ${detail}` });
    }
    try {
      await assertUserActionLockHeld(deps.redis, lock);
      const loaded = await deps.history.loadStrict(username);
      if (!loaded.ok) {
        return audit({ status: 'failed', detail: 'could not verify action history; no change made' });
      }
      const pending = findExactlyPending(loaded.rows, recordId);
      if (!pending) {
        return audit({
          status: 'failed',
          detail: `exact pending record ${recordId} was not found or is ambiguous; no change made`,
        });
      }
      if (input.resolution === 'inspect') {
        return audit({ status: 'inspected', username, record: identity(pending) });
      }

      await assertUserActionLockHeld(deps.redis, lock);
      const owner = { redis: deps.redis, key: lock.key, token: lock.token };
      const changed = input.resolution === 'applied'
        ? await deps.history.markApplied(username, recordId, owner)
        : await deps.history.removeOwned(username, recordId, owner);

      // Verify the exact post-state while still holding the same lock. This
      // also handles a transaction that committed but whose EXEC reply was
      // lost/malformed: the mutation method returns false, but a verified
      // desired post-state is still safe to report as reconciled.
      await assertUserActionLockHeld(deps.redis, lock);
      const verified = await deps.history.loadStrict(username);
      if (!verified.ok) {
        return audit({ status: 'failed', detail: 'post-state could not be verified; inspect before any retry' });
      }
      const remaining = verified.rows.filter((row) => row.id === recordId);
      const correct = input.resolution === 'applied'
        ? remaining.length === 1 && remaining[0]?.state === undefined
        : remaining.length === 0;
      if (input.resolution === 'not-applied' && hasExactPendingId(verified.rows, recordId)) {
        return audit({ status: 'failed', detail: 'pending row remains after removal; no retry is safe' });
      }
      if (!correct) {
        return audit({
          status: 'failed',
          detail: changed
            ? 'post-state did not match the requested reconciliation'
            : 'history transaction was not confirmed; no safe success reported',
        });
      }

      if (input.resolution === 'applied' && deps.historyMirror) {
        const { state: _pendingState, ...finalizedRecord } = pending;
        try {
          await mirrorAppend(deps.historyMirror, {
            subredditName: input.subredditName,
            username,
            record: finalizedRecord,
          });
        } catch (error) {
          console.error(`[reconcile] escalation wiki mirror failed: ${detailOf(error)}`);
        }
      }

      return audit({ status: 'reconciled', username, recordId, resolution: input.resolution });
    } finally {
      await releaseUserActionLock(deps.redis, lock, 'reconcile');
    }
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[reconcile] unexpected failure: ${detail}`);
    return audit({ status: 'failed', detail });
  }
}

/** Never-throw form boundary. */
export async function runReconcilePendingSafely(
  deps: ReconcilePendingDeps,
  input: ReconcilePendingInput
): Promise<ReconcilePendingSafeOutcome> {
  try {
    return await reconcilePending(deps, input);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[reconcile] action failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}

export function buildReconcilePendingToast(outcome: ReconcilePendingSafeOutcome): string {
  switch (outcome.status) {
    case 'denied':
      return outcome.detail ? `Reconciliation denied: ${outcome.detail}` : 'Reconciliation is only available in dev/QA.';
    case 'invalid':
      return `Invalid reconciliation: ${outcome.detail}`;
    case 'failed':
      return `Reconciliation failed: ${outcome.detail}`;
    case 'inspected':
      return `Pending ${outcome.record.id}: ${outcome.record.action} ${outcome.record.label} for u/${outcome.username}. Inspect Reddit before choosing a definite outcome.`;
    case 'reconciled':
      return `Reconciled ${outcome.recordId} as ${outcome.resolution} for u/${outcome.username}. Do not retry unless history now permits it.`;
    case 'trigger-failed':
      return `Reconciliation failed: ${outcome.detail}`;
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return '';
    }
  }
}
