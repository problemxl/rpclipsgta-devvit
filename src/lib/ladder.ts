/** One rung of the r/RPClipsGTA warning and ban ladder. */
export interface LadderRung {
  readonly action: 'warn' | 'ban';
  readonly durationDays: number;
  readonly label: string;
}

/**
 * The six-level ladder from the subreddit rules wiki:
 * <https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/>.
 *
 * A first violation receives a warning. Each subsequent effective prior moves
 * to the next rung; five or more effective priors receive a permanent ban.
 */
export const LADDER: readonly LadderRung[] = [
  { action: 'warn', durationDays: 0, label: 'Warning' },
  { action: 'ban', durationDays: 3, label: '3 day ban' },
  { action: 'ban', durationDays: 7, label: '7 day ban' },
  { action: 'ban', durationDays: 14, label: '14 day ban' },
  { action: 'ban', durationDays: 30, label: '30 day ban' },
  { action: 'ban', durationDays: 0, label: 'Permanent ban' },
] as const;

/** Three months is represented as 90 days for deterministic decay. */
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Count prior actions after one level of decay for every full three-month
 * (90-day) quiet stretch since the latest prior action.
 *
 * History is retained for life, so `total` keeps growing forever; the decay
 * anchored at the latest action is what keeps the ladder correct for
 * long-quiet users (see src/lib/history.ts for the retention decision).
 */
export function effectivePriors(total: number, latestAt: number | undefined, now: number): number {
  if (latestAt === undefined) return 0;

  const quietMs = Math.max(0, now - latestAt);
  const decay = Math.floor(quietMs / THREE_MONTHS_MS);
  return Math.max(0, total - decay);
}

/** Select the ladder rung for a user's retained infraction total and latest action. */
export function pickRung(total: number, latestAt: number | undefined, now: number): LadderRung {
  return LADDER[Math.min(effectivePriors(total, latestAt, now), LADDER.length - 1)];
}
