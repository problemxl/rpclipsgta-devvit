/**
 * Retained as a fail-closed compatibility seam for callers that may still
 * reference the former recovery action. The production menu is removed.
 */

import type { RedisLeaseStore } from '../lib/history.js';
import { userActionLockKey } from '../lib/user-lock.js';

export interface LockRecoveryDeps {
  readonly redis: Pick<RedisLeaseStore, 'get'>;
  readonly authorizeActor: (subredditName: string, actor: string) => Promise<boolean>;
}

export interface LockRecoveryInput {
  readonly subredditName: string;
  readonly actor: string;
  readonly username: string;
  /** A deliberate confirmation that no request for this user is running. */
  readonly confirm: boolean;
}

export type LockRecoveryOutcome =
  | { readonly status: 'denied'; readonly detail: string }
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'disabled'; readonly detail: string }
  | { readonly status: 'failed'; readonly detail: string };

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function audit(outcome: LockRecoveryOutcome): LockRecoveryOutcome {
  const username = 'username' in outcome ? ` u/${outcome.username}` : '';
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  console.log(`[lock-recovery] ${outcome.status}${username}${detail}`);
  return outcome;
}

function normalizedUsername(raw: string): string {
  return raw.trim().replace(/^u\//i, '').trim().toLowerCase();
}

function validUsername(username: string): boolean {
  return /^[a-z0-9_-]{3,20}$/i.test(username);
}

/**
 * This menu is intentionally disabled. Redis has no fencing token that can
 * make an already-running Reddit request harmless after lock deletion, so an
 * in-app GET/DEL recovery would be unsafe. Operators must use the documented
 * manual procedure only after establishing process-level quiescence.
 */
export async function recoverUserActionLock(
  deps: LockRecoveryDeps,
  input: LockRecoveryInput
): Promise<LockRecoveryOutcome> {
  const subredditName = input.subredditName.trim();
  const actor = input.actor.trim();
  if (!subredditName || !actor) {
    return audit({ status: 'denied', detail: 'subreddit and acting moderator are required' });
  }

  try {
    if (!(await deps.authorizeActor(subredditName, actor))) {
      return audit({ status: 'denied', detail: 'acting user is not a moderator' });
    }
  } catch (error) {
    console.error(`[lock-recovery] moderator authorization failed: ${detailOf(error)}`);
    return audit({
      status: 'denied',
      detail: 'moderator authorization could not be verified',
    });
  }

  const username = normalizedUsername(input.username);
  if (!validUsername(username)) {
    return audit({ status: 'invalid', detail: 'username must be a valid Reddit username' });
  }
  if (input.confirm !== true) {
    return audit({
      status: 'invalid',
      detail: 'confirm that no action for this user is still running',
    });
  }

  // Keep the authorization and validation path testable, but fail closed
  // before any mutation. There is no safe app-local compare-and-delete/fence.
  try {
    await deps.redis.get(userActionLockKey(username));
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[lock-recovery] lock inspection failed for u/${username}: ${detail}`);
    return audit({ status: 'failed', detail: `lock state could not be inspected: ${detail}` });
  }
  return audit({
    status: 'disabled',
    detail:
      'in-app recovery is disabled; follow the manual quiescence procedure in the runbook',
  });
}

export function buildLockRecoveryToast(outcome: LockRecoveryOutcome): string {
  switch (outcome.status) {
    case 'disabled':
      return `Lock recovery disabled: ${outcome.detail}`;
    case 'denied':
      return `Lock recovery denied: ${outcome.detail}`;
    case 'invalid':
      return `Invalid lock recovery: ${outcome.detail}`;
    case 'failed':
      return `Lock recovery failed: ${outcome.detail}`;
    default: {
      const _exhaustive: never = outcome;
      void _exhaustive;
      return '';
    }
  }
}
