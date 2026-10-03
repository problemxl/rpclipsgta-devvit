/** Framework-free orchestration for deterministic submission moderation. */

import {
  detectContentViolations,
  normalizeUrlForDuplication,
  WHITELISTED_DOMAINS,
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
}

/** Dependencies supplied by the Devvit trigger or by unit tests. */
export interface AutoEscalateDeps {
  readonly redis: RedisLike;
  readonly removePost: (thingId: string) => Promise<void>;
  readonly escalate: (payload: EscalatePayload) => Promise<EscalateResult>;
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

/** Every terminal result returned by {@link runAutoEscalation}. */
export type AutoEscalateOutcome =
  | { readonly status: 'already-processed' }
  | { readonly status: 'skipped-author' }
  | { readonly status: 'skipped-moderator' }
  | { readonly status: 'clean' }
  | { readonly status: 'escalate-failed'; readonly detail: string }
  | { readonly status: 'remove-failed'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string }
  | AutoEscalateActionedOutcome;

const DAY_MS = 24 * 60 * 60 * 1000;

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

function whitelistedLinkUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return WHITELISTED_DOMAINS.some(
      (root) => host === root || host.endsWith(`.${root}`)
    );
  } catch {
    return false;
  }
}

function violationPriority(violation: Violation): number {
  if (violation.rule === 5) return 0;
  if (violation.rule === 6) return 1;
  if (violation.rule === 4) return 2;
  if (violation.rule === 12) return 3;
  return 4;
}

/**
 * Claim, inspect, remove, and (when appropriate) escalate one submission.
 * All expected action failures are converted to an outcome and never escape.
 */
export async function runAutoEscalation(
  input: AutoEscalateInput,
  deps: AutoEscalateDeps
): Promise<AutoEscalateOutcome> {
  const now = deps.now ?? Date.now;
  const seenKey = `autoescalate:seen:${input.postId}`;

  try {
    // Idempotency is deliberately the first external operation.
    const seen = await deps.redis.set(seenKey, '1', {
      nx: true,
      expiration: new Date(now() + 7 * DAY_MS),
    });
    if (!seen) return audit({ status: 'already-processed' }, input.postId);

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
    if (!input.isTextPost && normalizedUrl && whitelistedLinkUrl(input.url)) {
      // Rule 6: only a valid, whitelisted link can enter the duplicate cache.
      const duplicateKey = `autoescalate:url:${normalizedUrl}`;
      const claimed = await deps.redis.set(duplicateKey, input.postId, {
        nx: true,
        expiration: new Date(now() + 14 * DAY_MS),
      });
      if (!claimed) {
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

    const violation = [...violations].sort(
      (left, right) => violationPriority(left) - violationPriority(right)
    )[0];
    if (!violation) return audit({ status: 'clean' }, input.postId);

    const thingId = postThingId(input.postId);
    try {
      await deps.removePost(thingId);
    } catch (error) {
      const detail = detailOf(error);
      console.error(`[auto-escalate] removal failed ${input.postId}: ${detail}`);
      return audit({ status: 'remove-failed', detail }, input.postId);
    }

    if (violation.action === 'remove') {
      return audit({ status: 'actioned', violation }, input.postId);
    }

    const payload: EscalatePayload = {
      target_user: input.authorName,
      target_id: thingId,
      rule: violation.rule,
      reason: `Auto: ${violation.reason}`,
      mod_user: AUTO_MOD_USER,
    };
    try {
      const escalateResult = await deps.escalate(payload);
      return audit({ status: 'actioned', violation, escalateResult }, input.postId);
    } catch (error) {
      const detail = detailOf(error);
      console.error(`[auto-escalate] escalation failed ${input.postId}: ${detail}`);
      return audit({ status: 'escalate-failed', detail }, input.postId);
    }
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[auto-escalate] processing failed ${input.postId}: ${detail}`);
    return audit({ status: 'failed', detail }, input.postId);
  }
}
