/** The moderation action to take against the target user. */
export type EscalationAction = 'warn' | 'ban';

/** One rung of the escalation ladder, indexed by number of prior mod actions. */
export interface LadderStep {
  /** Number of prior mod actions on the target that triggers this rung. */
  readonly priorCount: number;
  readonly action: EscalationAction;
  /**
   * Ban length in days; `0` means permanent.
   * Always `0` when `action` is `'warn'`.
   */
  readonly durationDays: number;
  /** Human-readable label used in messages and the PocketBase record. */
  readonly label: string;
}

/**
 * The escalation ladder for repeat offenders, by prior mod-action count:
 * 0 -> warning, 1 -> 3 day ban, 2 -> 7 day ban, 3 -> 30 day ban, 4+ -> permanent.
 */
export const LADDER: readonly LadderStep[] = [
  { priorCount: 0, action: 'warn', durationDays: 0, label: 'Warning' },
  { priorCount: 1, action: 'ban', durationDays: 3, label: '3 day ban' },
  { priorCount: 2, action: 'ban', durationDays: 7, label: '7 day ban' },
  { priorCount: 3, action: 'ban', durationDays: 30, label: '30 day ban' },
  { priorCount: 4, action: 'ban', durationDays: 0, label: 'Permanent ban' },
];

/**
 * Determine the escalation step for a user with `priorCount` prior mod actions.
 * Values below 0 are clamped to the first rung; values above the last rung
 * clamp to permanent ban.
 */
export function escalate(priorCount: number): LadderStep {
  const index = Math.min(Math.max(priorCount, 0), LADDER.length - 1);
  return LADDER[index];
}
