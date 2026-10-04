/** Hard environment boundary for tools that can mutate synthetic/moderation state. */

/** The only subreddit installations where test/recovery tooling may mutate history. */
export const DEV_QA_SUBREDDITS = ['S17Cjn21GT', 'rpclipsgta_mod_dev'] as const;

/** Case-insensitive, whitespace-tolerant match against the exact dev/QA names. */
export function isDevQaSubreddit(subredditName: string | undefined): boolean {
  const normalized = subredditName?.trim().toLowerCase();
  return (
    normalized !== undefined &&
    normalized.length > 0 &&
    DEV_QA_SUBREDDITS.some((allowed) => allowed.toLowerCase() === normalized)
  );
}
