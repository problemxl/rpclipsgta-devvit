import { effectivePriors, LADDER, pickRung, type LadderRung } from '../lib/ladder.js';
import { ruleByNumber } from '../lib/rules.js';
import type { HistoryStore, ModActionRecord, RedisLeaseStore } from '../lib/history.js';
import {
  acquireUserActionLock,
  assertUserActionLockHeld,
  releaseUserActionLock,
  userActionLockKey,
} from '../lib/user-lock.js';

const RULES_WIKI = 'https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/';
const MODMAIL_APPEAL =
  'If you would like to appeal, please contact the moderators via modmail.';

export interface PunishDeps {
  readonly history: HistoryStore;
  /** Shared Redis string + WATCH transaction API used to serialize the punishment flow. */
  readonly redis: RedisLeaseStore;
  readonly submitComment: (options: {
    text: string;
    replyTargetThingId: string;
  }) => Promise<string>;
  readonly banUser: (options: {
    username: string;
    subredditName: string;
    durationDays?: number;
    message: string;
    reason: string;
    note?: string;
  }) => Promise<void>;
  readonly now?: () => number;
}

export interface PunishInput {
  readonly targetUser: string;
  readonly targetThingId: string;
  readonly subredditName: string;
  readonly rule: number;
  readonly reason: string;
  readonly modUser: string;
}

export interface PunishResult {
  readonly action: 'warn' | 'ban';
  readonly durationDays: number;
  readonly label: string;
  readonly commentId: string;
  readonly priors: number;
  readonly ruleName: string;
  readonly recorded: boolean;
  /** True only when a stored pending marker was finalized after Reddit success. */
  readonly finalized: boolean;
  /** Exact row id to give the dev/QA reconciliation operator when needed. */
  readonly pendingRecordId?: string;
}

export interface WarningCommentInput {
  readonly targetUser: string;
  readonly rule: number;
  readonly ruleName: string;
  readonly reason: string;
  readonly rung: Pick<LadderRung, 'label'> | string;
}

function rungLabel(rung: WarningCommentInput['rung']): string {
  return typeof rung === 'string' ? rung : rung.label;
}

/** Build the next-rung text used in a first-offense warning comment. */
function nextRungLabel(rung: LadderRung): string {
  const index = LADDER.indexOf(rung);
  return LADDER[Math.min(index + 1, LADDER.length - 1)].label;
}

/**
 * Build a courteous markdown warning. Reddit's comment API does not expose a
 * distinction option here, so the app uses clear moderator-style markdown.
 */
export function buildWarningComment(input: WarningCommentInput): string {
  const reasonLine = input.reason.trim()
    ? `\n\n**Reason:** ${input.reason.trim()}`
    : '';
  const currentLabel = rungLabel(input.rung);
  const rung = LADDER.find((candidate) => candidate.label === currentLabel) ?? LADDER[0];
  const nextLabel = nextRungLabel(rung);

  return [
    `Hi u/${input.targetUser},`,
    '',
    `This is a moderator **warning** for breaking **R${input.rule} — ${input.ruleName}**.${reasonLine}`,
    '',
    `Please review the [subreddit rules](${RULES_WIKI}) and keep future contributions within them.`,
    `The current action is **${currentLabel}**. A next violation may result in a **${nextLabel}**.`,
    '',
    MODMAIL_APPEAL,
    '',
    'Thank you.',
  ].join('\n');
}

function banMessage(input: PunishInput, rung: LadderRung, ruleName: string): string {
  const reasonLine = input.reason.trim() ? `\n\nReason: ${input.reason.trim()}` : '';
  return [
    `You have been given a ${rung.label} from r/${input.subredditName} for **R${input.rule} — ${ruleName}**.${reasonLine}`,
    '',
    `Please review the [subreddit rules](${RULES_WIKI}).`,
    MODMAIL_APPEAL,
  ].join('\n');
}

/** Redis key used to serialize every action for one normalized username. */
export const punishLockKey = userActionLockKey;

/** The pending row shape handed to append(), which mints the unique id. */
function pendingRecordFor(input: PunishInput, at: number, rung: LadderRung): Omit<ModActionRecord, 'id'> {
  return {
    at,
    rule: input.rule,
    action: rung.action,
    label: rung.label,
    modUser: input.modUser,
    targetThingId: input.targetThingId,
    state: 'pending',
  };
}

/**
 * Execute the ladder under a per-user lock and record before Reddit execution.
 *
 * The history row is a pending action marker. Once a Reddit request has been
 * started, an exception or timeout has an ambiguous external outcome; the row
 * is retained and reconciliation is manual. Removing it would make an
 * already-applied warning/ban look like it never happened and could cause an
 * unsafe automatic retry.
 */
export async function punish(
  deps: PunishDeps,
  input: PunishInput
): Promise<PunishResult> {
  const rule = ruleByNumber(input.rule);
  if (!rule) throw new Error(`Unknown rule: ${input.rule}`);

  // This is the same lock key and lease used by seed/clear. A seed can never
  // interleave with a punishment's summary/append/execution sequence.
  const now = deps.now ?? Date.now;
  const lock = await acquireUserActionLock(deps.redis, input.targetUser, input.modUser, now);

  try {
    // Refuse to continue if an explicit operational recovery changed
    // ownership before a history mutation. Redis read failures are fail-closed
    // here: unknown history must never be treated as a fresh user.
    await assertUserActionLockHeld(deps.redis, lock);
    const at = now();
    const strictSummary = await deps.history.summaryStrict(input.targetUser);
    if (!strictSummary.ok) {
      throw new Error('could not read action history; no Reddit action was attempted');
    }
    const summary = strictSummary.summary;
    const strictRows = await deps.history.loadStrict(input.targetUser);
    if (!strictRows.ok) {
      throw new Error('could not verify action history; no Reddit action was attempted');
    }
    if (strictRows.rows.some((row) => row.state === 'pending')) {
      throw new Error('an earlier Reddit action has an unresolved outcome; reconcile it before retrying');
    }
    const rung = pickRung(summary.total, summary.latestAt, at);
    const effective = effectivePriors(summary.total, summary.latestAt, at);

    if (rung.action === 'ban' && !input.subredditName.trim()) {
      throw new Error('cannot apply a ban without a subreddit name');
    }

    let recorded = false;
    let pendingRecord: ModActionRecord | undefined;
    try {
      // Re-check immediately before the first history mutation. This is the
      // fail-closed boundary if explicit lock recovery raced this request.
      await assertUserActionLockHeld(deps.redis, lock);
      // Append is a single atomic ZADD that mints the unique row id and
      // returns the stored record — that record is the compensation identity.
      const appended = await deps.history.append(
        input.targetUser,
        pendingRecordFor(input, at, rung)
      );
      pendingRecord = appended.record;
      recorded = appended.ok;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[punish] failed to pre-record ${input.targetUser}: ${detail}`);
      recorded = false;
    }
    if (!recorded) {
      // A Reddit action without a positively confirmed pending marker cannot
      // be safely retried or reconciled. Fail closed before crossing the
      // external side-effect boundary. If the append may have landed despite
      // an ambiguous Redis reply, the returned id remains useful to an
      // administrator inspecting the history; never guess by deleting it.
      const id = pendingRecord?.id ? ` (${pendingRecord.id})` : '';
      throw new Error(
        `could not confirm pending history record${id}; no Reddit action was attempted`
      );
    }

    let commentId = '';
    let redditCallStarted = false;
    try {
      // A Reddit call cannot be rolled back once started. Check ownership at
      // the last safe point so an operationally recovered request never starts
      // a new external action after losing the shared lock.
      await assertUserActionLockHeld(deps.redis, lock);
      redditCallStarted = true;
      if (rung.action === 'warn') {
        commentId = await deps.submitComment({
          text: buildWarningComment({
            targetUser: input.targetUser,
            rule: input.rule,
            ruleName: rule.name,
            reason: input.reason,
            rung,
          }),
          replyTargetThingId: input.targetThingId,
        });
      } else {
        await deps.banUser({
          username: input.targetUser,
          subredditName: input.subredditName,
          ...(rung.durationDays > 0 ? { durationDays: rung.durationDays } : {}),
          message: banMessage(input, rung, rule.name),
          reason: `R${input.rule} — ${rule.name}`,
          note: `[devvit] by ${input.modUser}`,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (recorded && pendingRecord) {
        if (redditCallStarted) {
          // Timeout/exception is not proof that Reddit rejected the request.
          // Keep the marker and require an operator to reconcile Reddit before
          // any retry; never auto-remove or auto-retry an ambiguous outcome.
          console.error(
            `[punish] Reddit outcome unknown for ${input.targetUser}; ` +
              `pending record ${pendingRecord.id} retained for manual reconciliation: ${detail}`
          );
          throw new Error(
            `Reddit outcome unknown; pending record ${pendingRecord.id} retained. ` +
              `Inspect Reddit before reconciliation; do not retry. Original error: ${detail}`
          );
        } else {
          // A pre-call ownership failure proves this invocation did not start
          // Reddit work. Compensation is still conditional: removeOwned()
          // watches the lock and refuses to mutate history after ownership is
          // lost or changes during the transaction.
          const removed = await deps.history.removeOwned(input.targetUser, pendingRecord.id, {
            redis: deps.redis,
            key: lock.key,
            token: lock.token,
          });
          if (!removed) {
            console.error(
              `[punish] pre-call failure for ${input.targetUser}; pending record ` +
                `${pendingRecord.id} retained because ownership was not proven: ${detail}`
            );
          }
        }
      }
      throw error;
    }

    let finalized = false;
    if (recorded && pendingRecord) {
      // The lock is deliberately held through every bounded retry. Each
      // attempt re-proves ownership; a lost lock stops retries rather than
      // mutating history under a replacement owner.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await assertUserActionLockHeld(deps.redis, lock);
          finalized = await deps.history.markApplied(input.targetUser, pendingRecord.id, {
            redis: deps.redis,
            key: lock.key,
            token: lock.token,
          });
          if (finalized) break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(
            `[punish] finalization attempt ${attempt}/3 for ${pendingRecord.id} stopped: ${detail}`
          );
          break;
        }
      }
      if (!finalized) {
        console.error(
          `[punish] Reddit action applied but pending record ${pendingRecord.id} ` +
            'could not be finalized after 3 safe attempts'
        );
      }
    }

    return {
      action: rung.action,
      durationDays: rung.durationDays,
      label: rung.label,
      commentId,
      priors: effective,
      ruleName: rule.name,
      recorded,
      finalized,
      ...(pendingRecord ? { pendingRecordId: pendingRecord.id } : {}),
    };
  } finally {
    // A Redis release failure must never throw over an already-applied
    // punishment result or mask the original execution error.
    await releaseUserActionLock(deps.redis, lock, 'punish');
  }
}
