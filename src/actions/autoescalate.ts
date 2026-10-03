/** Framework-free orchestration for moderator-initiated post removal. */

import {
  actionForRule,
  detectContentViolations,
  normalizeUrlForDuplication,
  type SubmissionInput,
  type Violation,
} from '../lib/detection.js';
import type { EscalatePayload, EscalateResult } from '../lib/service.js';

/** The Redis options used by the installed Devvit Redis client. */
export interface AutoRedisSetOptions {
  readonly nx?: boolean;
  readonly xx?: boolean;
  readonly expiration?: Date;
}

/** The small structural Redis subset needed by this action. */
export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(
    key: string,
    value: string,
    options?: AutoRedisSetOptions
  ): Promise<string | undefined>;
  readonly del: (key: string) => Promise<unknown>;
}

export type EscalateFn = (payload: EscalatePayload) => Promise<EscalateResult>;

/** Dependencies supplied by the moderator menu or by unit tests. */
export interface ModRemovalDeps {
  readonly redis: RedisLike;
  readonly removePost: (thingId: string) => Promise<void>;
  /** An already configured service client, if one is available. */
  readonly escalate?: EscalateFn;
  /** Lazily configures the service only after a punishable violation is found. */
  readonly getEscalate?: () => Promise<EscalateFn | undefined>;
  readonly now?: () => number;
}

/** Post fields supplied by the moderator menu. */
export interface ModRemovalInput extends SubmissionInput {
  readonly postId: string;
  readonly authorName: string;
  readonly modUser: string;
}

/** The smaller input needed when a moderator picks a rule in the form. */
export type ManualRuleRemovalInput = Pick<
  ModRemovalInput,
  'postId' | 'authorName' | 'modUser'
>;

/** Result when removal and any policy-required escalation succeeded. */
export interface ModRemovalActionedOutcome {
  readonly status: 'actioned';
  readonly violation: Violation;
  readonly escalateResult?: EscalateResult;
}

/** Removal succeeded but the escalation service was not configured. */
export interface ModRemovalUnescalatedOutcome {
  readonly status: 'actioned-unescalated';
  readonly reason: 'service-not-configured';
  readonly violation: Violation;
}

/** Every terminal result returned by either removal entry point. */
export type ModRemovalOutcome =
  | { readonly status: 'already-processed' }
  | { readonly status: 'skipped-author' }
  | { readonly status: 'clean' }
  | { readonly status: 'escalate-failed'; readonly detail: string }
  | { readonly status: 'remove-failed'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | ModRemovalActionedOutcome
  | ModRemovalUnescalatedOutcome;

/** A framework callback failure kept separate from an action outcome. */
export type ModRemovalSafeOutcome =
  | ModRemovalOutcome
  | { readonly status: 'trigger-failed'; readonly detail: string };

/** Backwards-compatible exported names for the action outcome contracts. */
export type AutoEscalateActionedOutcome = ModRemovalActionedOutcome;
export type AutoEscalateUnescalatedOutcome = ModRemovalUnescalatedOutcome;
export type AutoEscalateOutcome = ModRemovalOutcome;
export type AutoEscalateSafeOutcome = ModRemovalSafeOutcome;

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
  redis: RedisLike,
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

async function resolveEscalate(
  deps: ModRemovalDeps
): Promise<EscalateFn | undefined> {
  if (deps.escalate) return deps.escalate;
  if (!deps.getEscalate) return undefined;
  return deps.getEscalate();
}

async function applyViolation(
  input: { postId: string; authorName: string; modUser: string },
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

  let escalate: EscalateFn | undefined;
  try {
    escalate = await resolveEscalate(deps);
  } catch (error) {
    const detail = detailOf(error);
    console.error(
      `[mod-remove] escalation setup failed ${input.postId}: ${detail}; ` +
        'removal succeeded; use the manual Escalate menu'
    );
    return audit({ status: 'escalate-failed', detail }, input.postId);
  }

  if (!escalate) {
    console.error(
      `[mod-remove] escalation skipped for ${input.postId}: service-not-configured; ` +
        'use the manual Escalate menu'
    );
    return audit(
      { status: 'actioned-unescalated', reason: 'service-not-configured', violation },
      input.postId
    );
  }

  const payload: EscalatePayload = {
    target_user: input.authorName,
    target_id: thingId,
    rule: violation.rule,
    reason,
    mod_user: input.modUser,
  };
  try {
    const escalateResult = await escalate(payload);
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
    const normalizedUrl = input.isTextPost ? '' : normalizeUrlForDuplication(input.url);

    // A deterministic content violation never reserves a URL. The moderator
    // action is intentionally low-concurrency, so duplicate detection uses a
    // straightforward GET followed by SET rather than a race-prone claim read.
    if (violations.length === 0 && normalizedUrl) {
      const duplicateKey = `autoescalate:url:${normalizedUrl}`;
      const earlierPost = await deps.redis.get(duplicateKey);
      if (earlierPost !== undefined && earlierPost !== input.postId) {
        violations.push({
          rule: 6,
          reason: 'duplicate of an earlier submission of this URL',
          action: actionForRule(6),
        });
      } else if (earlierPost === undefined) {
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
      const consumed = await deps.redis.set(key, '1', {
        xx: true,
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
  outcome: ModRemovalActionedOutcome | ModRemovalUnescalatedOutcome,
  ruleName?: string
): string {
  const label = `R${outcome.violation.rule}${ruleName ? ` — ${ruleName}` : ''}`;
  if (outcome.status === 'actioned-unescalated') {
    return `Removed post (${label}); not escalated — use the manual Escalate option.`;
  }
  return outcome.escalateResult
    ? `Removed post (${label}) and escalated.`
    : `Removed post (${label}); no escalation required.`;
}

/** Pure failure text used by the Devvit menu and unit tests. */
export function buildRemovalFailureToast(
  outcome: Exclude<ModRemovalSafeOutcome, ModRemovalActionedOutcome | ModRemovalUnescalatedOutcome | { readonly status: 'clean' } | { readonly status: 'skipped-author' } | { readonly status: 'already-processed' }>
): string {
  return outcome.status === 'escalate-failed'
    ? `Escalation failed after removal: ${outcome.detail}. Use the manual Escalate option.`
    : `Remove post failed: ${outcome.detail}`;
}
