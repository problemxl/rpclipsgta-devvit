/**
 * Client for the Python escalation service.
 *
 * The Devvit app is only a thin trigger: it collects the mod's input and
 * POSTs it to the service, which owns everything else — prior-count lookup,
 * escalation ladder, warn/ban execution and the PocketBase record.
 *
 * Endpoint contract (see README):
 *   POST `${baseUrl}/devvit/escalate`
 *   Headers: `X-Escalate-Token: <shared secret>`, `Content-Type: application/json`
 *
 * All functions take `fetchImpl` as their first argument so callers (and
 * tests) can inject the Devvit runtime `fetch` or a mock. The Devvit runtime
 * requires `Devvit.configure({ http: { domains: [host] } })` for the host.
 */

/** Structural subset of the global `fetch` signature. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Body of `POST /devvit/escalate`. */
export interface EscalatePayload {
  /** Username of the target user, without the leading `u/`. */
  target_user: string;
  /** Thing id of the moderated content (`t3_...` post or `t1_...` comment). */
  target_id: string;
  /** Canonical number of the broken rule (1–12, from `src/lib/rules.ts`). */
  rule: number;
  /** Free-text reason from the form; `''` when the mod skipped it. */
  reason: string;
  /** Username of the acting moderator, without the leading `u/`. */
  mod_user: string;
}

/** Successful response of `POST /devvit/escalate`. */
export interface EscalateResult {
  /** What the service executed. */
  action: 'warn' | 'ban';
  /** Ban length in days; `0` for warnings and permanent bans. */
  duration_days: number;
  /** Human-readable ladder label (e.g. `7 day ban`, `Permanent ban`). */
  label: string;
  /** Thing id of the warning comment (`t1_...`); `''` for bans. */
  comment_id: string;
  /** Prior mod-action count the service used to pick the ladder rung. */
  priors: number;
  /** Name of the violated rule. */
  rule_name: string;
  /** Whether the service managed to record the action in PocketBase. */
  recorded: boolean;
}

/** Extract the FastAPI-style `{ detail }` message from an error body, if any. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (body && typeof body.detail === 'string' && body.detail.length > 0) {
      return `: ${body.detail}`;
    }
  } catch {
    // Body was not JSON — fall back to the status line only.
  }
  return '';
}

/**
 * Ask the service to escalate one mod action.
 *
 * Resolves with the parsed {@link EscalateResult} on any 2xx response and
 * throws on non-2xx, with the HTTP status plus the service's `detail` message
 * when the error body is JSON.
 */
export async function callEscalate(
  fetchImpl: FetchLike,
  baseUrl: string,
  token: string,
  payload: EscalatePayload
): Promise<EscalateResult> {
  // Trailing slashes would double up in `${base}/devvit/escalate`.
  const base = baseUrl.replace(/\/+$/, '');
  const response = await fetchImpl(`${base}/devvit/escalate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Escalate-Token': token,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      `Escalation service returned ${response.status} ${response.statusText}${detail}`
    );
  }
  return (await response.json()) as EscalateResult;
}
