/** A single subreddit rule, keyed by its canonical number. */
export interface Rule {
  readonly number: number;
  readonly name: string;
}

/**
 * The canonical 12 rules of r/RPClipsGTA, in order.
 * Keep in sync with the subreddit's rule list — the select field in the mod
 * action form and the `rule` field of the service payload derive from this.
 */
export const RULES: readonly Rule[] = [
  { number: 1, name: 'Reddit Rules' },
  { number: 2, name: 'Toxicity' },
  { number: 3, name: 'No call to action' },
  { number: 4, name: 'Low Effort content' },
  { number: 5, name: 'Whitelisted domains' },
  { number: 6, name: 'Duplicate Post' },
  { number: 7, name: 'Self-promotion / Advertising' },
  { number: 8, name: 'Non GTA RP content' },
  { number: 9, name: 'Suggestions for streamers or servers' },
  { number: 10, name: 'Flairs and tags' },
  { number: 11, name: 'Off-topic content' },
  { number: 12, name: 'Banned Streamer' },
];

/**
 * Look up a rule by its canonical number.
 * @returns the matching {@link Rule}, or `undefined` if `number` is not 1–12.
 */
export function ruleByNumber(number: number): Rule | undefined {
  return RULES.find((rule) => rule.number === number);
}
