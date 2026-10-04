/** Framework-free authorization seam for destructive moderator actions. */

export interface ModeratorLookupClient {
  getModerators(options: {
    subredditName: string;
    username: string;
    limit?: number;
    pageSize?: number;
  }): { all(): Promise<readonly unknown[]> };
}

export interface AuthorizedModeratorAction<T> {
  readonly authorized: true;
  readonly result: T;
}

export interface DeniedModeratorAction {
  readonly authorized: false;
}

export type ModeratorActionResult<T> =
  | AuthorizedModeratorAction<T>
  | DeniedModeratorAction;

/**
 * Check current Reddit moderator membership and run an action only after the
 * lookup has positively succeeded. Visibility filters such as `forUserType`
 * are not an authorization boundary: form submissions can be replayed or
 * invoked after membership changes.
 *
 * Lookup failures deliberately become denial. The callback is never invoked
 * when the actor, subreddit, or moderator listing is unknown.
 */
export async function runAuthorizedModeratorAction<T>(
  reddit: ModeratorLookupClient,
  subredditName: string | undefined,
  actor: string | undefined,
  action: () => Promise<T>
): Promise<ModeratorActionResult<T>> {
  const subreddit = subredditName?.trim() ?? '';
  const username = actor?.trim() ?? '';
  if (!subreddit || !username) return { authorized: false };

  let moderators: readonly unknown[];
  try {
    moderators = await reddit
      .getModerators({
        subredditName: subreddit,
        username,
        limit: 1,
        pageSize: 1,
      })
      .all();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[moderator-auth] lookup failed for r/${subreddit}: ${detail}`);
    return { authorized: false };
  }

  if (!Array.isArray(moderators) || moderators.length === 0) {
    return { authorized: false };
  }
  return { authorized: true, result: await action() };
}
