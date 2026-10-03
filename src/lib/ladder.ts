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

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Count prior actions after one level of decay for every full three-month
 * quiet stretch since the latest prior action.
 */
export function effectivePriors(priorTimestamps: readonly number[], now: number): number {
  if (priorTimestamps.length === 0) return 0;

  const latest = Math.max(...priorTimestamps);
  const quietMs = Math.max(0, now - latest);
  const decay = Math.floor(quietMs / THREE_MONTHS_MS);
  return Math.max(0, priorTimestamps.length - decay);
}

/** Select the ladder rung for a user's prior action timestamps. */
export function pickRung(priorTimestamps: readonly number[], now: number): LadderRung {
  return LADDER[Math.min(effectivePriors(priorTimestamps, now), LADDER.length - 1)];
}
