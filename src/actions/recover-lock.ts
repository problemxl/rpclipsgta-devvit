/** Explicit moderator recovery for a stuck per-user action lock. */

import type { RedisLeaseStore } from '../lib/history.js';
import { forceReleaseUserActionLock } from '../lib/user-lock.js';

export interface LockRecoveryDeps {
  readonly redis: Pick<RedisLeaseStore, 'del'>;
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
  | { readonly status: 'recovered'; readonly username: string }
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
 * Delete a lock only after an authenticated moderator explicitly confirms that
 * its owner is dead. This is emergency recovery, not an automatic timeout;
 * using it while a request is running can permit overlap and is unsafe.
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

  try {
    await forceReleaseUserActionLock(deps.redis, username);
    return audit({ status: 'recovered', username });
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[lock-recovery] failed for u/${username}: ${detail}`);
    return audit({ status: 'failed', detail: `lock may still be held: ${detail}` });
  }
}

export function buildLockRecoveryToast(outcome: LockRecoveryOutcome): string {
  switch (outcome.status) {
    case 'recovered':
      return `Recovered the action lock for u/${outcome.username}; verify no action is still running`;
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
