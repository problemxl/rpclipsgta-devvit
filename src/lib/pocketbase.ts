/**
 * Minimal fetch-based PocketBase client.
 *
 * All functions take `fetchImpl` as their first argument so callers (and tests)
 * can inject the Devvit runtime `fetch` or a mock. The default is the global
 * `fetch` provided by the Devvit runtime (requires
 * `Devvit.configure({ http: { domains: [host] } })`).
 */

/** Structural subset of the global `fetch` signature. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fields persisted to the PocketBase `mod_actions` collection. */
export interface ModActionFields {
  /** Escalation step taken: 'warn' or 'ban'. */
  action: string;
  /** Rule number (1-12). */
  rule: number;
  /** Ban length in days; 0 for warnings and permanent bans. */
  duration_days: number;
  /** Username of the target user (no leading u/). */
  target_user: string;
  /** Username of the acting moderator (no leading u/). */
  mod_user: string;
  /** Thing id (t1_...) of the comment/command that triggered the action. */
  command_comment_id: string;
  /** Thing id (t1_/t3_) of the moderated content. */
  thing_id: string;
  /** Permalink of the moderated content. */
  permalink: string;
  /** Free-text reason recorded for the action. */
  reason: string;
  /** Name of the violated rule. */
  rule_name: string;
  /** ISO-8601 timestamp of the action. */
  action_date: string;
  /** Where the action came from (e.g. 'menu', 'command'). */
  source: string;
  /** Reference within the source (e.g. the mod menu label). */
  source_ref: string;
  /** Reddit post id (t3_...) or empty string for comment-only actions. */
  reddit_post_id: string;
  /** Reddit comment id (t1_...) or empty string for post-only actions. */
  reddit_comment_id: string;
}

/** Subset of the PocketBase auth-with-password response we rely on. */
interface AuthResponse {
  token: string;
}

/** Subset of the PocketBase records list response we rely on. */
interface RecordsResponse {
  totalItems: number;
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) {
    throw new Error(
      `PocketBase ${context} failed with status ${response.status}: ${response.statusText}`
    );
  }
}

/**
 * Authenticate a PocketBase superuser and return the auth token.
 *
 * POST `${baseUrl}/api/collections/_superusers/auth-with-password`
 * with JSON body `{ identity, password }`.
 */
export async function pbLogin(
  fetchImpl: FetchLike,
  baseUrl: string,
  email: string,
  password: string
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/api/collections/_superusers/auth-with-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: email, password }),
  });
  assertOk(response, 'login');
  const data = (await response.json()) as AuthResponse;
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new Error('PocketBase login response did not contain a token');
  }
  return data.token;
}

/**
 * Count prior mod actions recorded against a target user.
 *
 * GET `${baseUrl}/api/collections/mod_actions/records?perPage=1&filter=(target_user='X')`
 * (filter URL-encoded) and return `totalItems`.
 */
export async function countModActions(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  targetUser: string
): Promise<number> {
  const filter = `(target_user='${targetUser}')`;
  const url =
    `${baseUrl}/api/collections/mod_actions/records` +
    `?perPage=1&filter=${encodeURIComponent(filter)}`;
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: token },
  });
  assertOk(response, 'count mod actions');
  const data = (await response.json()) as RecordsResponse;
  return data.totalItems;
}

/**
 * Create a mod action record.
 *
 * POST `${baseUrl}/api/collections/mod_actions/records` with the fields as the
 * JSON body.
 */
export async function createModAction(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  fields: ModActionFields
): Promise<void> {
  const response = await fetchImpl(`${baseUrl}/api/collections/mod_actions/records`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify(fields),
  });
  assertOk(response, 'create mod action');
}
