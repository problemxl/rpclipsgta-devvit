/** Framework-free orchestration for deterministic submission moderation. */

import {
  detectContentViolations,
  isWhitelistedHost,
  normalizeUrlForDuplication,
  parseSubmissionUrl,
  type SubmissionInput,
  type Violation,
} from '../lib/detection.js';
import type { EscalatePayload, EscalateResult } from '../lib/service.js';

/** Username recorded as the actor for automatic escalations. */
export const AUTO_MOD_USER = 'devvit-auto';

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

/** Dependencies supplied by the Devvit trigger or by unit tests. */
export interface AutoEscalateDeps {
  readonly redis: RedisLike;
  readonly removePost: (thingId: string) => Promise<void>;
  /** An already configured service client, if one is available. */
  readonly escalate?: EscalateFn;
  /** Lazily configures the service only after a punishable violation is found. */
  readonly getEscalate?: () => Promise<EscalateFn | undefined>;
  readonly isModerator: (username: string) => Promise<boolean>;
  readonly now?: () => number;
}

/** Submission fields supplied by the PostSubmit trigger. */
export interface AutoEscalateInput extends SubmissionInput {
  readonly postId: string;
  readonly authorName: string;
}

/** Result when the submission was acted on successfully. */
export interface AutoEscalateActionedOutcome {
  readonly status: 'actioned';
  readonly violation: Violation;
  readonly escalateResult?: EscalateResult;
}

/** Removal succeeded but the service was not configured. */
export interface AutoEscalateUnescalatedOutcome {
  readonly status: 'actioned-unescalated';
  readonly reason: 'service-not-configured';
  readonly violation: Violation;
}

/** Every terminal result returned by {@link runAutoEscalation}. */
export type AutoEscalateOutcome =
  | { readonly status: 'already-processed' }
  | { readonly status: 'skipped-author' }
  | { readonly status: 'skipped-moderator' }
  | { readonly status: 'clean' }
  | { readonly status: 'escalate-failed'; readonly detail: string }
  | { readonly status: 'remove-failed'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | AutoEscalateActionedOutcome
  | AutoEscalateUnescalatedOutcome;

/** A trigger-level failure is kept separate from an action outcome. */
export type AutoEscalateSafeOutcome =
  | AutoEscalateOutcome
  | { readonly status: 'trigger-failed'; readonly detail: string };

const DAY_MS = 24 * 60 * 60 * 1000;

class TriggerDependencyError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'TriggerDependencyError';
  }
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function audit(outcome: AutoEscalateOutcome, postId: string): AutoEscalateOutcome {
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  console.log(`[auto-escalate] ${outcome.status} ${postId}${detail}`);
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

async function releaseSeenClaim(
  redis: RedisLike,
  seenKey: string,
  postId: string
): Promise<void> {
  try {
    await redis.del(seenKey);
    console.log(`[auto-escalate] released seen claim ${postId}`);
  } catch (error) {
    console.error(
      `[auto-escalate] failed to release seen claim ${postId}: ${detailOf(error)}`
    );
  }
}

/**
 * Claim, inspect, remove, and (when appropriate) escalate one submission.
 * The safe trigger wrapper below is the boundary used by framework code.
 */
export async function runAutoEscalation(
  input: AutoEscalateInput,
  deps: AutoEscalateDeps
): Promise<AutoEscalateOutcome> {
  const now = deps.now ?? Date.now;
  const seenKey = `autoescalate:seen:${input.postId}`;
  let claimed = false;
  let removed = false;

  try {
    const seen = await deps.redis.set(seenKey, '1', {
      nx: true,
      expiration: new Date(now() + 7 * DAY_MS),
    });
    if (!seen) return audit({ status: 'already-processed' }, input.postId);
    claimed = true;

    if (!input.authorName.trim() || input.authorName.trim().toLowerCase() === 'automoderator') {
      return audit({ status: 'skipped-author' }, input.postId);
    }
    if (await deps.isModerator(input.authorName)) {
      return audit({ status: 'skipped-moderator' }, input.postId);
    }

    const violations = detectContentViolations(input);
    const normalizedUrl = input.isTextPost
      ? ''
      : normalizeUrlForDuplication(input.url);

    // A content violation means this post is not eligible to reserve the URL.
    // In particular, removed VOD/R12 posts must never poison the duplicate cache.
    if (
      violations.length === 0 &&
      !input.isTextPost &&
      normalizedUrl
    ) {
      const parsed = parseSubmissionUrl(input.url);
      if (parsed.ok && isWhitelistedHost(parsed.host)) {
        const duplicateKey = `autoescalate:url:${normalizedUrl}`;
        const duplicateClaim = await deps.redis.set(duplicateKey, input.postId, {
          nx: true,
          expiration: new Date(now() + 14 * DAY_MS),
        });
        if (!duplicateClaim) {
          const earlierPost = await deps.redis.get(duplicateKey);
          console.log(
            `[auto-escalate] duplicate ${input.postId} of ${earlierPost ?? 'an earlier submission'}`
          );
          violations.push({
            rule: 6,
            reason: 'duplicate of an earlier submission of this URL',
            action: 'remove-and-escalate',
          });
        }
      }
    }

    const violation = [...violations].sort(
      (left, right) => violationPriority(left) - violationPriority(right)
    )[0];
    if (!violation) return audit({ status: 'clean' }, input.postId);

    const thingId = postThingId(input.postId);
    try {
      await deps.removePost(thingId);
      removed = true;
    } catch (error) {
      const detail = detailOf(error);
      await releaseSeenClaim(deps.redis, seenKey, input.postId);
      console.error(`[auto-escalate] removal failed ${input.postId}: ${detail}`);
      return audit({ status: 'remove-failed', detail }, input.postId);
    }

    if (violation.action === 'remove') {
      return audit({ status: 'actioned', violation }, input.postId);
    }

    let escalate = deps.escalate;
    if (!escalate && deps.getEscalate) {
      // A rejected lazy settings getter is a trigger-level failure. It happens
      // after removal, so the seen claim remains and the post is not retried.
      try {
        escalate = await deps.getEscalate();
      } catch (error) {
        throw new TriggerDependencyError(detailOf(error));
      }
    }
    if (!escalate) {
      console.error(
        `[auto-escalate] punishment skipped for ${input.postId}: service-not-configured; ` +
          'a moderator can use the manual Escalate menu'
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
      reason: `Auto: ${violation.reason}`,
      mod_user: AUTO_MOD_USER,
    };
    try {
      const escalateResult = await escalate(payload);
      return audit({ status: 'actioned', violation, escalateResult }, input.postId);
    } catch (error) {
      const detail = detailOf(error);
      console.error(
        `[auto-escalate] escalation failed ${input.postId}: ${detail}; ` +
          'punishment was skipped after removal; use the manual Escalate menu'
      );
      return audit({ status: 'escalate-failed', detail }, input.postId);
    }
  } catch (error) {
    if (error instanceof TriggerDependencyError) throw error;
    const detail = detailOf(error);
    if (claimed && !removed) await releaseSeenClaim(deps.redis, seenKey, input.postId);
    console.error(`[auto-escalate] processing failed ${input.postId}: ${detail}`);
    return audit({ status: 'failed', detail }, input.postId);
  }
}

/**
 * Framework-free trigger boundary. Nothing from a Devvit event handler should
 * be able to escape this catch, including lazy settings/service glue errors.
 */
export async function runAutoEscalationSafely(
  input: AutoEscalateInput,
  deps: AutoEscalateDeps
): Promise<AutoEscalateSafeOutcome> {
  try {
    return await runAutoEscalation(input, deps);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[auto-escalate] trigger failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}
