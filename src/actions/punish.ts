import { effectivePriors, LADDER, pickRung, type LadderRung } from '../lib/ladder.js';
import { ruleByNumber } from '../lib/rules.js';
import type { HistoryStore, ModActionRecord, RedisLike } from '../lib/history.js';

const RULES_WIKI = 'https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/';
const MODMAIL_APPEAL =
  'If you would like to appeal, please contact the moderators via modmail.';

const LOCK_TTL_MS = 30 * 1000;

export interface PunishDeps {
  readonly history: HistoryStore;
  /** Shared Redis used to serialize the complete per-user punishment flow. */
  readonly redis: RedisLike;
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
export function punishLockKey(username: string): string {
  return `punish:lock:${username.toLowerCase()}`;
}

function recordFor(input: PunishInput, at: number, rung: LadderRung): ModActionRecord {
  return {
    at,
    rule: input.rule,
    action: rung.action,
    label: rung.label,
    modUser: input.modUser,
    targetThingId: input.targetThingId,
  };
}

async function compensateRecord(
  history: HistoryStore,
  username: string,
  record: ModActionRecord
): Promise<void> {
  if (!history.remove) {
    console.error('[punish] execution failed; history store cannot compensate the pending record');
    return;
  }
  try {
    const removed = await history.remove(username, record);
    if (!removed) {
      console.error('[punish] execution failed; compensation could not remove the pending record');
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[punish] execution failed; history compensation failed: ${detail}`);
  }
}

/** Execute the ladder under a per-user lock and record before Reddit execution. */
export async function punish(
  deps: PunishDeps,
  input: PunishInput
): Promise<PunishResult> {
  const rule = ruleByNumber(input.rule);
  if (!rule) throw new Error(`Unknown rule: ${input.rule}`);

  const lockKey = punishLockKey(input.targetUser);
  const lockResult = await deps.redis.set(lockKey, '1', {
    nx: true,
    expiration: new Date(Date.now() + LOCK_TTL_MS),
  });
  const acquired = typeof lockResult === 'string';
  if (!acquired) throw new Error('punishment already in progress for this user');

  try {
    const now = deps.now ?? Date.now;
    const at = now();
    // A history read failure is a failed escalation, not permission to execute
    // a second action against a user whose current level is unknown.
    const priorRecords = await deps.history.load(input.targetUser);
    const priorTimestamps = priorRecords
      .map((record) => record.at)
      .filter((timestamp) => Number.isFinite(timestamp));
    const rung = pickRung(priorTimestamps, at);
    const effective = effectivePriors(priorTimestamps, at);

    const pendingRecord = recordFor(input, at, rung);
    let recorded = false;
    try {
      recorded = await deps.history.append(input.targetUser, pendingRecord);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[punish] failed to pre-record ${input.targetUser}: ${detail}`);
      recorded = false;
    }
    if (!recorded) {
      console.error(`[punish] proceeding without a history record for ${input.targetUser}`);
    }

    let commentId = '';
    try {
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
      if (recorded) {
        // There is a tiny crash window between the Reddit action and this
        // compensation; pending-first makes a failed action visible otherwise.
        await compensateRecord(deps.history, input.targetUser, pendingRecord);
      }
      throw error;
    }

    return {
      action: rung.action,
      durationDays: rung.durationDays,
      label: rung.label,
      commentId,
      priors: effective,
      ruleName: rule.name,
      recorded,
    };
  } finally {
    // Release only when this call acquired the lock; a failed NX must not
    // delete another caller's lock.
    if (acquired) await deps.redis.del(lockKey);
  }
}
