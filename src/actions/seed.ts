/**
 * Framework-free seeding of test action history for the escalation ladder.
 *
 * PURPOSE: let a moderator instantly place any username at any ladder position
 * (or reset them) so the ladder and its 90-day decay can be exercised in
 * minutes instead of months of waiting or many throwaway accounts. Seeded rows
 * go through the SAME HistoryStore the punish flow reads, so the ladder cannot
 * tell them apart from real infractions — that is what makes the tool useful.
 *
 * SAFETY: the subreddit allowlist is checked FIRST on every call, so a form
 * replay or a stray install in the production subreddit is refused before any
 * username is normalized or any row is written.
 */

import type { HistoryStore } from '../lib/history.js';

/** The only subreddits the seed tool may ever run in (dev and QA installs). */
export const SEED_ALLOWED_SUBREDDITS = ['S17Cjn21GT', 'rpclipsgta_mod_dev'] as const;

/** Case-insensitive allowlist match; subreddit names arrive in any casing. */
export function isSeedAllowedSubreddit(subredditName: string | undefined): boolean {
  const normalized = subredditName?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized.length > 0 &&
    SEED_ALLOWED_SUBREDDITS.some((allowed) => allowed.toLowerCase() === normalized)
  );
}

/** Inclusive integer bounds for the seed parameters. */
export const SEED_MIN_PRIORS = 1;
export const SEED_MAX_PRIORS = 20;
export const SEED_MIN_LATEST_AGE_DAYS = 0;
export const SEED_MAX_LATEST_AGE_DAYS = 3650;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Attributes of every seeded row, kept simple and honestly synthetic. */
const SEED_RECORD_FIELDS = {
  // Rule 11 is the catch-all "Off-topic" rule: no policy meaning is implied.
  rule: 11,
  action: 'warn',
  label: 'Warning',
  modUser: 'seed-tool',
  targetThingId: 't3_seeded',
} as const;

/** Structural dependencies, satisfied by main.ts wiring and by unit tests. */
export interface SeedDeps {
  readonly history: HistoryStore;
  readonly now?: () => number;
}

/** The two operations the tool performs on one user's history. */
export type SeedOperation = 'seed' | 'clear';

export interface SeedInput {
  readonly subredditName: string;
  readonly username: string;
  readonly operation: SeedOperation;
  /** Rows to write; required for 'seed', ignored for 'clear'. */
  readonly priors?: number;
  /** Age of the newest row in days; required for 'seed', ignored for 'clear'. */
  readonly latestAgeDays?: number;
}

/** Every terminal result returned by the seed tool. */
export type SeedOutcome =
  | { readonly status: 'denied' }
  | { readonly status: 'invalid'; readonly detail: string }
  | {
      readonly status: 'seeded';
      readonly username: string;
      readonly priors: number;
      readonly latestAgeDays: number;
    }
  | { readonly status: 'cleared'; readonly username: string }
  | { readonly status: 'failed'; readonly detail: string };

/** A framework callback failure kept separate from a seed outcome. */
export type SeedSafeOutcome = SeedOutcome | { readonly status: 'trigger-failed'; readonly detail: string };

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `[seed]`-prefixed audit line for every terminal status; returns the outcome. */
function audit(outcome: SeedOutcome): SeedOutcome {
  const name = 'username' in outcome ? ` u/${outcome.username}` : '';
  const detail = 'detail' in outcome ? `: ${outcome.detail}` : '';
  console.log(`[seed] ${outcome.status}${name}${detail}`);
  return outcome;
}

/**
 * Normalize a form username for storage: trim, drop one leading `u/` (any
 * case), lowercase — matching the per-user history key convention.
 */
export function normalizeSeedUsername(raw: string): string {
  return raw
    .trim()
    .replace(/^u\//i, '')
    .trim()
    .toLowerCase();
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Seed synthetic priors or clear a user's history — dev/QA subreddits only.
 *
 * Timestamps are spaced one day apart so the rows look like distinct real
 * actions: record k (k = 1 oldest … N newest) lands at
 * `now − (latestAgeDays + (N − k)) days`, so the newest row is exactly
 * `latestAgeDays` old and drives the ladder's decay clock.
 *
 * Never throws: every failure path degrades to a terminal outcome and logs.
 */
export async function seedHistory(deps: SeedDeps, input: SeedInput): Promise<SeedOutcome> {
  // -- Allowlist guard FIRST: production history must never be touched. -----
  if (!isSeedAllowedSubreddit(input.subredditName)) {
    // Loud on purpose: a press here means someone tried the tool in prod.
    console.error(
      `[seed] DENIED subreddit '${input.subredditName}' — the test seed tool is ` +
        `dev/QA-only (${SEED_ALLOWED_SUBREDDITS.join(', ')}); no history was read or written`
    );
    return audit({ status: 'denied' });
  }

  try {
    const username = normalizeSeedUsername(input.username);
    if (!username) {
      return audit({ status: 'invalid', detail: 'username is required' });
    }

    if (input.operation === 'clear') {
      const cleared = await deps.history.clear(username);
      if (!cleared) {
        return audit({
          status: 'failed',
          detail: `redis refused the clear for u/${username}; history may remain`,
        });
      }
      return audit({ status: 'cleared', username });
    }

    // -- 'seed': validate both numbers before any write ---------------------
    if (!isIntegerInRange(input.priors, SEED_MIN_PRIORS, SEED_MAX_PRIORS)) {
      return audit({
        status: 'invalid',
        detail: `priors must be a whole number ${SEED_MIN_PRIORS}-${SEED_MAX_PRIORS}`,
      });
    }
    if (
      !isIntegerInRange(
        input.latestAgeDays,
        SEED_MIN_LATEST_AGE_DAYS,
        SEED_MAX_LATEST_AGE_DAYS
      )
    ) {
      return audit({
        status: 'invalid',
        detail: `latestAgeDays must be a whole number ${SEED_MIN_LATEST_AGE_DAYS}-${SEED_MAX_LATEST_AGE_DAYS}`,
      });
    }

    const priors: number = input.priors;
    const latestAgeDays: number = input.latestAgeDays;
    const now = deps.now ?? Date.now;
    const at = now();

    // Append is what mints the row ids, so writes go one-by-one through the
    // same HistoryStore the punish flow uses.
    let landed = 0;
    for (let k = 1; k <= priors; k += 1) {
      const rowAt = at - (latestAgeDays + (priors - k)) * DAY_MS;
      const appended = await deps.history.append(username, {
        at: rowAt,
        ...SEED_RECORD_FIELDS,
      });
      if (!appended.ok) {
        // No auto-clear: the operator decides (Clear history is one press
        // away), because deleting rows the tool does not own would be worse.
        return audit({
          status: 'failed',
          detail: `only ${landed} of ${priors} rows landed; clear u/${username} and retry`,
        });
      }
      landed += 1;
    }

    return audit({ status: 'seeded', username, priors, latestAgeDays });
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[seed] unexpected failure: ${detail}`);
    return { status: 'failed', detail };
  }
}

/** Never-throw boundary for the moderator form path. */
export async function runSeedSafely(deps: SeedDeps, input: SeedInput): Promise<SeedSafeOutcome> {
  try {
    return await seedHistory(deps, input);
  } catch (error) {
    const detail = detailOf(error);
    console.error(`[seed] action failed: ${detail}`);
    return { status: 'trigger-failed', detail };
  }
}

/** Pure toast text for every seed outcome, used by the Devvit form handler. */
export function buildSeedToast(outcome: SeedSafeOutcome): string {
  switch (outcome.status) {
    case 'seeded':
      return `Seeded ${outcome.priors} priors for u/${outcome.username} (latest ${outcome.latestAgeDays} days ago)`;
    case 'cleared':
      return `Cleared history for u/${outcome.username}`;
    case 'denied':
      return 'Test tool is only available in the dev/QA subreddits.';
    case 'invalid':
      return `Invalid seed input: ${outcome.detail}`;
    case 'failed':
      return `Seed failed: ${outcome.detail}`;
    case 'trigger-failed':
      return `Seed test history failed: ${outcome.detail}`;
    default: {
      // Exhaustiveness guard: a new outcome status must be handled above.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return '';
    }
  }
}
