/** Framework-free orchestration for moderator-initiated post removal. */

import {
  actionForRule,
  detectContentViolations,
  isWhitelistedHost,
  normalizeUrlForDuplication,
  parseSubmissionUrl,
  type SubmissionInput,
  type Violation,
} from '../lib/detection.js';
import type { RedisSetOptions, RedisStringLike } from '../lib/history.js';
import { ruleByNumber, type Rule } from '../lib/rules.js';
import { ruleLabel } from './escalate.js';
import type { PunishInput, PunishResult } from './punish.js';

// The removal flow shares the exact structural Redis client used by the
// punish lock (string commands); the history store consumes the sorted-set
// subset of the same client. Re-exported for existing callers.
export type { RedisStringLike, RedisSetOptions as AutoRedisSetOptions };
/** Payload passed across the framework-free removal/escalation seam. */
export interface EscalatePayload {
  readonly target_user: string;
  readonly target_id: string;
  /** The resolved target post's subreddit; punish refuses bans without one. */
  readonly subreddit_name: string;
  readonly rule: number;
  readonly reason: string;
  readonly mod_user: string;
}

/** Result shape retained for removal toasts and existing action callers. */
export interface EscalateResult {
  readonly action: 'warn' | 'ban';
  readonly duration_days: number;
  readonly label: string;
  readonly comment_id: string;
  readonly priors: number;
  readonly rule_name: string;
  readonly recorded: boolean;
}

export type EscalateFn = (payload: EscalatePayload) => Promise<EscalateResult>;

/** Dependencies supplied by the moderator menu or by unit tests. */
export interface ModRemovalDeps {
  readonly redis: RedisStringLike;
  readonly removePost: (thingId: string) => Promise<void>;
  /** The always-available in-app punishment function. */
  readonly escalate: EscalateFn;
  readonly now?: () => number;
}

/** Post fields supplied by the moderator menu. */
export interface ModRemovalInput extends SubmissionInput {
  readonly postId: string;
  readonly authorName: string;
  readonly modUser: string;
  /** The resolved post's subreddit, threaded to punish for ban safety. */
  readonly subredditName: string;
}

/** The smaller input needed when a moderator picks a rule in the form. */
export type ManualRuleRemovalInput = Pick<
  ModRemovalInput,
  'postId' | 'authorName' | 'modUser' | 'subredditName'
>;

/** Result when removal and any policy-required escalation succeeded. */
export interface ModRemovalActionedOutcome {
  readonly status: 'actioned';
  readonly violation: Violation;
  readonly escalateResult?: EscalateResult;
}

/** Every terminal result returned by either removal entry point. */
export type ModRemovalOutcome =
  | { readonly status: 'already-processed' }
  | { readonly status: 'skipped-author' }
  | { readonly status: 'clean' }
  | { readonly status: 'escalate-failed'; readonly detail: string }
  | { readonly status: 'remove-failed'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | ModRemovalActionedOutcome;

/** A framework callback failure kept separate from an action outcome. */
export type ModRemovalSafeOutcome =
  | ModRemovalOutcome
  | { readonly status: 'trigger-failed'; readonly detail: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN_TTL_DAYS = 7;
const URL_TTL_DAYS = 14;

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function audit(outcome: ModRemovalOutcome, postId: string): ModRemovalOutcome {
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  console.log(`[mod-remove] ${outcome.status} ${postId}${detail}`);
  return outcome;
}

function postThingId(postId: string): string {
  return postId.startsWith('t3_') ? postId : `t3_${postId}`;
}

function violationPriority(violation: Violation): number {
  if (violation.rule === 5) return 0;
  if (violation.rule === 6) return 1;
  if (violation.rule === 4) return 2;
  if (violation.rule === 12) return 3;
  return 4;
}

function seenKey(postId: string): string {
  return `autoescalate:seen:${postId}`;
}

async function releaseSeenClaim(
  redis: RedisStringLike,
  key: string,
  postId: string
): Promise<void> {
  try {
    await redis.del(key);
    console.log(`[mod-remove] released seen claim ${postId}`);
  } catch (error) {
    console.error(`[mod-remove] failed to release seen claim ${postId}: ${detailOf(error)}`);
  }
}

function validRule(rule: number): boolean {
  return Number.isInteger(rule) && rule >= 1 && rule <= 12;
}

async function claimSeen(
  input: { postId: string },
  deps: ModRemovalDeps,
  now: () => number
): Promise<{ key: string; claimed: boolean }> {
  const key = seenKey(input.postId);
  const result = await deps.redis.set(key, '1', {
    nx: true,
    expiration: new Date(now() + SEEN_TTL_DAYS * DAY_MS),
  });
  return { key, claimed: Boolean(result) };
}

async function applyViolation(
  input: {
    postId: string;
    authorName: string;
    modUser: string;
    subredditName: string;
  },
  violation: Violation,
  reason: string,
  deps: ModRemovalDeps,
  claimKey: string,
  claimed: boolean
): Promise<ModRemovalOutcome> {
  const thingId = postThingId(input.postId);
  try {
    await deps.removePost(thingId);
  } catch (error) {
    const detail = detailOf(error);
    if (claimed) await releaseSeenClaim(deps.redis, claimKey, input.postId);
    console.error(`[mod-remove] removal failed ${input.postId}: ${detail}`);
    return audit({ status: 'remove-failed', detail }, input.postId);
  }

  if (actionForRule(violation.rule) === 'remove') {
    return audit({ status: 'actioned', violation }, input.postId);
  }

  const payload: EscalatePayload = {
    target_user: input.authorName,
    target_id: thingId,
    subreddit_name: input.subredditName,
    rule: violation.rule,
    reason,
    mod_user: input.modUser,
  };
  try {
    const escalateResult = await deps.escalate(payload);
    return audit({ status: 'actioned', violation, escalateResult }, input.postId);
  } catch (error) {
    const detail = detailOf(error);
    console.error(
      `[mod-remove] escalation failed ${input.postId}: ${detail}; ` +
        'removal succeeded; use the manual Escalate menu'
    );
    return audit({ status: 'escalate-failed', detail }, input.postId);
  }
}

/**
 * Detect, remove, and policy-escalate one post after a moderator presses the
 * Remove post menu action. URL duplicate state is claimed only by clean posts.
 */
export async function runModRemoval(
  input: ModRemovalInput,
  deps: ModRemovalDeps
): Promise<ModRemovalOutcome> {
  const now = deps.now ?? Date.now;
  const key = seenKey(input.postId);
  let claimed = false;

  try {
    const claim = await claimSeen(input, deps, now);
    if (!claim.claimed) return audit({ status: 'already-processed' }, input.postId);
    claimed = true;
    if (!input.authorName.trim() || input.authorName.trim().toLowerCase() === 'automoderator') {
      return audit({ status: 'skipped-author' }, input.postId);
    }

    const violations = detectContentViolations(input);
    const parsedUrl = input.isTextPost ? undefined : parseSubmissionUrl(input.url);
    const normalizedUrl = input.isTextPost ? '' : normalizeUrlForDuplication(input.url);
    const eligibleForDuplicateLookup = Boolean(
      parsedUrl?.ok && isWhitelistedHost(parsedUrl.host) && normalizedUrl
    );

    // Duplicate detection must run even when another content violation exists:
    // R6 is a real candidate in the R5 > R6 > R4 > R12 priority order. The
    // URL claim remains deliberately limited to otherwise-clean posts, so a
    // violating post can never poison the duplicate cache.
    if (eligibleForDuplicateLookup) {
      const duplicateKey = `autoescalate:url:${normalizedUrl}`;
      const earlierPost = await deps.redis.get(duplicateKey);
      if (earlierPost !== undefined && earlierPost !== input.postId) {
        violations.push({
          rule: 6,
          reason: 'duplicate of an earlier submission of this URL',
          action: actionForRule(6),
        });
      } else if (violations.length === 0 && earlierPost === undefined) {
        await deps.redis.set(duplicateKey, input.postId, {
          expiration: new Date(now() + URL_TTL_DAYS * DAY_MS),
        });
      }
    }

    const violation = [...violations].sort(
      (left, right) => violationPriority(left) - violationPriority(right)
    )[0];
    if (!violation) {
      // Keep both the seen claim and any clean URL claim. Marking the seen
      // value lets the follow-up rule form use this same claim exactly once;
      // later presses still receive already-processed.
      await deps.redis.set(key, 'clean', {
        xx: true,
        expiration: new Date(now() + SEEN_TTL_DAYS * DAY_MS),
      });
      return audit({ status: 'clean' }, input.postId);
    }

    return applyViolation(
      input,
      violation,
      `Auto: ${violation.reason}`,
      deps,
      key,
      claimed
    );
  } catch (error) {
    const detail = detailOf(error);
    if (claimed) await releaseSeenClaim(deps.redis, key, input.postId);
    console.error(`[mod-remove] processing failed ${input.postId}: ${detail}`);
    return audit({ status: 'failed', detail }, input.postId);
  }
}

/**
 * Remove a moderator-selected rule when deterministic detection found nothing.
 * Manual judgment never reads or writes the duplicate URL cache.
 */
export async function applyManualRuleRemoval(
  input: ManualRuleRemovalInput,
  rule: number,
  reason: string,
  deps: ModRemovalDeps
): Promise<ModRemovalOutcome> {
  const now = deps.now ?? Date.now;
  const key = seenKey(input.postId);
  let claimed = false;

  try {
    const claim = await claimSeen(input, deps, now);
    if (!claim.claimed) {
      // A clean automatic pass deliberately keeps its seen claim so the URL
      // remains protected, but the immediately presented rule form may consume
      // that clean claim once. Any other existing value is already processed.
      if ((await deps.redis.get(key)) !== 'clean') {
        return audit({ status: 'already-processed' }, input.postId);
      }
      await deps.redis.del(key);
      // DEL and SET are intentionally separate: if the process crashes after
      // DEL, before this SET NX, the claim is lost and the post may be retried.
      // That narrow retry-allowed window is accepted for this form workflow.
      const consumed = await deps.redis.set(key, '1', {
        nx: true,
        expiration: new Date(now() + SEEN_TTL_DAYS * DAY_MS),
      });
      if (!consumed) return audit({ status: 'already-processed' }, input.postId);
    }
    claimed = true;
    if (!validRule(rule)) {
      await releaseSeenClaim(deps.redis, key, input.postId);
      return audit({ status: 'failed', detail: `invalid rule: ${rule}` }, input.postId);
    }
    const violation: Violation = {
      rule,
      reason: reason || `Rule ${rule} removal`,
      action: actionForRule(rule),
    };
    return applyViolation(input, violation, violation.reason, deps, key, claimed);
  } catch (error) {
    const detail = detailOf(error);
    if (claimed) await releaseSeenClaim(deps.redis, key, input.postId);
    console.error(`[mod-remove] manual processing failed ${input.postId}: ${detail}`);
    return audit({ status: 'failed', detail }, input.postId);
  }
}

/** Never-throw boundary for the moderator menu's automatic detection path. */
export async function runModRemovalSafely(
  input: ModRemovalInput,
  deps: ModRemovalDeps
): Promise<ModRemovalSafeOutcome> {
  try {
    return await runModRemoval(input, deps);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[mod-remove] action failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}

/** Never-throw boundary for the moderator rule form path. */
export async function applyManualRuleRemovalSafely(
  input: ManualRuleRemovalInput,
  rule: number,
  reason: string,
  deps: ModRemovalDeps
): Promise<ModRemovalSafeOutcome> {
  try {
    return await applyManualRuleRemoval(input, rule, reason, deps);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[mod-remove] manual action failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}

/** Pure success text used by the Devvit menu and unit tests. */
export function buildRemovalSuccessToast(
  outcome: ModRemovalActionedOutcome,
  ruleName?: string
): string {
  const label = `R${outcome.violation.rule}${ruleName ? ` — ${ruleName}` : ''}`;
  return outcome.escalateResult
    ? `Removed post (${label}) and escalated.`
    : `Removed post (${label}); no escalation required.`;
}

/** Pure failure text used by the Devvit menu and unit tests. */
export function buildRemovalFailureToast(
  outcome: Exclude<ModRemovalSafeOutcome, ModRemovalActionedOutcome | { readonly status: 'clean' } | { readonly status: 'skipped-author' } | { readonly status: 'already-processed' }>
): string {
  return outcome.status === 'escalate-failed'
    ? `Escalation failed after removal: ${outcome.detail}. Use the manual Escalate option.`
    : `Remove post failed: ${outcome.detail}`;
}

// ---------------------------------------------------------------------------
// Remove & escalate — one combined moderator action (any rule, mod discretion)
// ---------------------------------------------------------------------------

/** Input for the combined remove-and-escalate moderator action. */
export interface RemoveEscalateInput {
  /** Thing id including prefix: `t3_...` for posts, `t1_...` for comments. */
  readonly thingId: string;
  /** Username of the target author, without the leading `u/`. */
  readonly authorName: string;
  /** The resolved target's subreddit; punish refuses bans without one. */
  readonly subredditName: string;
  /** The rule the acting moderator selected — any of the 12, by discretion. */
  readonly rule: number;
  readonly reason: string;
  /** Username of the pressing moderator. */
  readonly modUser: string;
}

/** Structural dependencies of the combined action, supplied by main or tests. */
export interface RemoveEscalateDeps {
  readonly redis: RedisStringLike;
  /** Removes one post or comment; reddit.remove accepts t1_ and t3_ ids. */
  readonly removeThing: (thingId: string) => Promise<void>;
  /** The in-app punishment function, wired exactly like the Escalate path. */
  readonly punish: (input: PunishInput) => Promise<PunishResult>;
  readonly now?: () => number;
}

/** Result when the removal and the ladder escalation both succeeded. */
export interface RemoveEscalateActionedOutcome {
  readonly status: 'actioned';
  readonly punishResult: PunishResult;
}

/** Every terminal result returned by the combined action. */
export type RemoveEscalateOutcome =
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'already-processed' }
  | { readonly status: 'remove-failed'; readonly detail: string }
  | { readonly status: 'escalate-failed'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | RemoveEscalateActionedOutcome;

/** A framework callback failure kept separate from an action outcome. */
export type RemoveEscalateSafeOutcome =
  | RemoveEscalateOutcome
  | { readonly status: 'trigger-failed'; readonly detail: string };

/** Failure-shaped outcomes consumed by the failure toast builder. */
export type RemoveEscalateFailureOutcome = Exclude<
  RemoveEscalateSafeOutcome,
  RemoveEscalateActionedOutcome | { readonly status: 'already-processed' }
>;

const REMOVE_ESCALATE_TTL_DAYS = 7;

function removeEscalateSeenKey(thingId: string): string {
  return `removeescalate:seen:${thingId}`;
}

function removeEscalateAudit<T extends RemoveEscalateOutcome>(
  outcome: T,
  thingId: string
): T {
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  const label = outcome.status === 'actioned' ? ` (${outcome.punishResult.label})` : '';
  console.log(`[remove-escalate] ${outcome.status} ${thingId}${label}${detail}`);
  return outcome;
}

async function releaseRemoveEscalateClaim(
  redis: RedisStringLike,
  thingId: string
): Promise<void> {
  try {
    await redis.del(removeEscalateSeenKey(thingId));
    console.log(`[remove-escalate] released seen claim ${thingId}`);
  } catch (error) {
    console.error(
      `[remove-escalate] failed to release seen claim ${thingId}: ${detailOf(error)}`
    );
  }
}

/**
 * Remove one post or comment and escalate its author through the ladder in a
 * single press, for ANY of the 12 rules — explicit moderator discretion, no
 * policy-class filtering. Ordering is remove-first: no punishment is applied
 * unless the removal succeeded, so a removal failure releases the seen claim
 * (the action can be retried), while an escalation failure keeps it — the
 * thing is already gone and the plain Escalate menu is the ladder fallback.
 */
export async function runRemoveAndEscalate(
  input: RemoveEscalateInput,
  deps: RemoveEscalateDeps
): Promise<RemoveEscalateOutcome> {
  const now = deps.now ?? Date.now;
  const thingId = input.thingId;
  try {
    // -- Validation ---------------------------------------------------------
    if (!ruleByNumber(input.rule)) {
      return removeEscalateAudit(
        { status: 'invalid', detail: `unknown rule: ${input.rule}` },
        thingId
      );
    }
    if (!/^t[13]_/.test(thingId)) {
      return removeEscalateAudit(
        { status: 'invalid', detail: 'thing id must be t3_/t1_ prefixed' },
        thingId
      );
    }
    if (!input.authorName.trim()) {
      return removeEscalateAudit({ status: 'invalid', detail: 'empty author name' }, thingId);
    }
    if (!input.modUser.trim()) {
      return removeEscalateAudit({ status: 'invalid', detail: 'empty mod user' }, thingId);
    }
    if (!input.subredditName.trim()) {
      return removeEscalateAudit({ status: 'invalid', detail: 'empty subreddit name' }, thingId);
    }

    // -- Idempotency: one claim per thing, kept unless removal failed --------
    const key = removeEscalateSeenKey(thingId);
    const claim = await deps.redis.set(key, '1', {
      nx: true,
      expiration: new Date(now() + REMOVE_ESCALATE_TTL_DAYS * DAY_MS),
    });
    if (!claim) return removeEscalateAudit({ status: 'already-processed' }, thingId);

    // -- Removal first: no punishment without a successful removal -----------
    try {
      await deps.removeThing(thingId);
    } catch (error) {
      const detail = detailOf(error);
      await releaseRemoveEscalateClaim(deps.redis, thingId);
      console.error(`[remove-escalate] removal failed ${thingId}: ${detail}`);
      return removeEscalateAudit({ status: 'remove-failed', detail }, thingId);
    }

    // -- Escalation: failures keep the claim (the thing is already removed) --
    try {
      const punishResult = await deps.punish({
        targetUser: input.authorName,
        targetThingId: thingId,
        subredditName: input.subredditName,
        rule: input.rule,
        reason: input.reason,
        modUser: input.modUser,
      });
      return removeEscalateAudit({ status: 'actioned', punishResult }, thingId);
    } catch (error) {
      const detail = detailOf(error);
      console.error(
        `[remove-escalate] escalation failed ${thingId}: ${detail}; ` +
          'thing removed; use the plain Escalate menu'
      );
      return removeEscalateAudit({ status: 'escalate-failed', detail }, thingId);
    }
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[remove-escalate] processing failed ${thingId}: ${detail}`);
    return removeEscalateAudit({ status: 'failed', detail }, thingId);
  }
}

/** Never-throw boundary for the combined moderator menu action. */
export async function runRemoveAndEscalateSafely(
  input: RemoveEscalateInput,
  deps: RemoveEscalateDeps
): Promise<RemoveEscalateSafeOutcome> {
  try {
    return await runRemoveAndEscalate(input, deps);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[remove-escalate] action failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}

/** Pure success text used by the Devvit menu and unit tests. */
export function buildRemoveEscalateSuccessToast(params: {
  result: PunishResult;
  /** Username of the target user, without the leading `u/`. */
  targetUser: string;
  /** The rule the acting mod selected in the form. */
  rule: Rule;
}): string {
  const { result, targetUser, rule } = params;
  const summary =
    result.action === 'warn'
      ? `Removed & warned u/${targetUser} (${ruleLabel(rule)})`
      : `Removed & banned u/${targetUser} — ${result.label}`;
  return result.recorded ? summary : `${summary} (not recorded)`;
}

/** Pure already-processed text used by the Devvit menu and unit tests. */
export function buildRemoveEscalateAlreadyProcessedToast(): string {
  return 'Already processed by this action.';
}

/** Pure failure text used by the Devvit menu and unit tests. */
export function buildRemoveEscalateFailureToast(outcome: RemoveEscalateFailureOutcome): string {
  return outcome.status === 'escalate-failed'
    ? `Removed, but escalation failed: ${outcome.detail}. Use the Escalate menu to warn or ban the author.`
    : `Remove & escalate failed: ${outcome.detail}`;
}
