# rpclipsgta-modactions

A moderator-actions Devvit app for r/RPClipsGTA. It provides:

- **Escalate** on posts/comments, a thin trigger in front of the Python
  escalation service.
- **Create clip fixture** on a source post, an explicit moderator-only action
  that creates an ordinary link post in the development or QA subreddit.

Fixture creation is never automatic mirroring. It does not run on a schedule,
listen for submissions, create comments, or create Reddit crossposts. The
fixture's submitted URL remains the original Twitch/Kick clip URL so the
clipbackup detector can exercise the normal ingestion path.

A moderator presses **Escalate** on any post or comment, picks which of the 12
rules was broken (plus an optional reason), and the app POSTs that to the
Python service. The service owns everything else:

1. counts the author's prior mod actions in PocketBase,
2. picks the escalation ladder rung for that count,
3. executes it — a distinguished warning comment reply for first offenses, or
   a ban for repeat offenders,
4. records the action back into the PocketBase `mod_actions` collection so the
   Python-side `!w` / `!b` recorder and this app share one history.

The app itself does **no** ladder logic and **no** PocketBase access. It only
resolves the target, forwards `{ target_user, target_id, rule, reason,
mod_user }` to the service, and toasts the outcome.

```
┌──────────────────────────┐   POST /devvit/escalate   ┌──────────────────────────┐
│  Devvit app (this repo)  │ ────────────────────────► │  Python escalation svc   │
│  menu → form → POST →    │ ◄──────────────────────── │  priors · ladder ·       │
│  toast                   │      EscalateResult       │  execution · PocketBase  │
└──────────────────────────┘                           └────────────┬─────────────┘
     reddit: resolve target                                         │
                                                                    ▼
                                                         ┌────────────────────┐
                                                         │     PocketBase     │
                                                         │    mod_actions     │
                                                         └────────────────────┘
```

## Endpoint contract

`POST {SERVICE_BASE_URL}/devvit/escalate`

Headers:

| Header            | Value                                          |
| ----------------- | ---------------------------------------------- |
| `X-Escalate-Token` | shared secret — must equal the service's `ESCALATE_TOKEN` |
| `Content-Type`    | `application/json`                             |

Request body (sent by the app):

```json
{
  "target_user": "spammer99",
  "target_id": "t1_xyz789",
  "rule": 2,
  "reason": "toxic chat",
  "mod_user": "realmod"
}
```

- `target_user` — author username, no leading `u/`.
- `target_id` — thing id of the moderated content (`t3_...` post / `t1_...` comment).
- `rule` — canonical rule number, 1–12.
- `reason` — free text from the form; `''` when the mod skipped it.
- `mod_user` — acting moderator's username, no leading `u/`.

Success response (`200`, parsed by the app):

```json
{
  "action": "warn",
  "duration_days": 7,
  "label": "7 day ban",
  "comment_id": "",
  "priors": 2,
  "rule_name": "Toxicity",
  "recorded": true
}
```

- `action` — `"warn"` or `"ban"`.
- `duration_days` — ban length in days; `0` for warnings and permanent bans.
- `label` — human-readable ladder label (`Warning`, `3 day ban`, `7 day ban`,
  `30 day ban`, `Permanent ban`).
- `comment_id` — thing id of the submitted warning comment (`t1_...`); `''` for bans.
- `priors` — prior mod-action count the service used to pick the rung.
- `rule_name` — name of the violated rule.
- `recorded` — `false` when the service executed the action but the PocketBase
  write failed; the app then appends `(not recorded)` to the success toast.

Errors: any non-2xx is surfaced to the mod as a short error toast. When the
error body is JSON, the app includes the FastAPI-style `{ "detail": ... }`
message, e.g. `Escalation failed: Escalation service returned 401
Unauthorized: invalid escalation token`.

The toast formats are:

- warn: `Warned u/x (R2 — Toxicity)`
- ban: `Banned u/x — 7 day ban` (label comes from the service)
- unrecorded: suffix ` (not recorded)`

## Moderator clip fixtures

On a source **post**, a moderator can choose **Create clip fixture** from the
post menu. The form offers exactly these targets; there is no free-form
subreddit field:

| Form choice | Subreddit | Title prefix |
| --- | --- | --- |
| Development | `S17Cjn21GT` | `[DEV FIXTURE]` |
| QA/staging | `rpclipsgta_mod_dev` | `[QA FIXTURE]` |

The app resolves the source post, requires that it belongs to
`r/rpclipsgta`, verifies the acting username in Reddit's moderator listing,
validates that its submitted URL is a Twitch or Kick clip URL, and calls
`reddit.submitPost` with `runAs: 'APP'`, the original URL, and a bounded title.
The title includes `source:<post id>` and the source permalink for visible
traceability. A structured copy of that source/actor/target/destination data is
also stored in global Redis metadata. It deliberately does **not** call
`crosspost()` and never calls `submitComment()`.

Fixture creation is deduplicated by source post ID + target using a global
Redis `SET NX` claim. A repeated press reports that the fixture is already
claimed and returns the stored destination metadata when available. A pending
claim expires after ten minutes, and a failed Reddit submission releases it so
it can be retried. Deleting a fixture manually does not clear a successful
claim, so an operator should treat the command as create-once.

The menu is registered with Devvit's existing `forUserType: 'moderator'`
convention. Because that setting controls menu visibility rather than being a
complete authorization boundary, the form handler also checks the source
subreddit and verifies current moderator membership through the Reddit API
before it reads or writes fixture state. No
non-moderator menu item is registered.

Errors are shown in a toast for an unauthorized source/moderator,
missing/non-clip URLs, invalid target selection, duplicate requests, or Reddit
submission failures. The source and target receive no comments.

## Auto-escalation

When the `auto-escalate-enabled` installation setting is enabled, the app
listens for `PostSubmit` events only in `r/rpclipsgta` (case-insensitive).
Installations on development or QA subreddits are guarded and never
auto-act. The setting is off by default.

The trigger applies only high-confidence, deterministic checks:

- Rule 5: HTTP(S) links must use one of the eight exact allowlisted domains
  (one leading `www.` is ignored), Twitch/Kick VOD URLs are rejected, and
  Twitch's only exception on `twitch.tv` is the legacy `/{channel}/clip/{slug}`
  path; Streamable titles need a bracket tag at the title start containing
  letters (a convention proxy — actual POV-streamer verification stays
  manual).
- Rule 6: a normalized whitelisted link URL already seen in the 14-day Redis
  window.
- Rule 4: Twitch channel links, text posts with fewer than two sentences, and
  titles containing no letters.
- Rule 12: a banned streamer name in the title or decoded URL path segments
  (query strings, hosts, and userinfo are not scanned).

Everything else remains on the manual **Escalate** path; the app does not try
to automate judgment-heavy rules such as toxicity, harassment, context,
self-promotion, GTA RP relevance, or flairs. At most one violation is returned
per rule, and one violation is selected in the priority order R5 > R6 > R4 >
R12. Every selected violation is removed. R5, R6, and R4 removals are sent to
the escalation service with `mod_user: "devvit-auto"`; R12 is deliberately
**remove-only** and never warns or bans the author, per the wiki.

Automatic processing is idempotent and installation-scoped in Redis:

- `autoescalate:seen:{postId}` — 7-day claim, so a PostSubmit retry cannot
  action the same post twice. If moderation fails before or during removal,
  this claim is deleted so a replay can retry; after successful removal it is
  kept, including when escalation fails.
- `autoescalate:url:{normalizedUrl}` — 14-day first-seen URL claim used for
  duplicate detection. It is claimed only by a clean, otherwise eligible post,
  never by an R4/R5/R12-violating post.

Detection and removal do not depend on service settings. If the service is
missing, a punish-class post is still removed and logged as
`actioned-unescalated`; a moderator can use the manual **Escalate** menu.
Removal and escalation failures are logged with an `[auto-escalate]` audit
prefix; a removal failure never calls the service. `AUTO_MOD_USER` is the
fixed service actor name `devvit-auto`.

## What the app does on each press

### Escalate

1. Opens the **rule + reason form** (select of the 12 rules, optional reason).
2. Re-derives the target from the submit context (`context.commentId` wins
   over `context.postId`; the `showForm` pass-through payload is not readable
   in `onSubmit` in @devvit/public-api 0.14.2) and resolves the thing to get
   the author name and thing id.
3. Reads the two secret settings, **POSTs to the service** and **toasts** the
   result.

There are **no PM fallbacks** in the app: the service handles user
notification (warning comment / ban message) and its own PocketBase recording
fallbacks. Failures surface as a short toast, details go to the app logs.

## Setup

### 1. Edit `SERVICE_BASE_URL` (⚠️ required before upload)

The service base URL is **hardcoded at the top of `src/main.ts`**:

```ts
const SERVICE_BASE_URL = 'https://escalate.rpclips.example.com';
```

This is a hard requirement of the Devvit platform:

- Apps run on **Reddit's servers** — `localhost` and LAN addresses are
  unreachable from there. The host must be a **public URL** (e.g. your
  Coolify deployment of the Python service).
- Fetch domains are **static**: the host is derived from this constant via
  `new URL(SERVICE_BASE_URL).host` and baked into the app bundle from
  `Devvit.configure({ http: { domains: [SERVICE_HOST] } })` **at upload
  time**. It cannot be set per-installation via app settings, wildcards
  (`*.example.com`) are not supported, and the allowlist entry must be a bare
  hostname.
- **Changing the service host means editing `SERVICE_BASE_URL` and
  re-uploading the app.** The `service-url` setting must use exactly this
  host (the app aborts with a clear toast if it doesn't — the fetch would be
  blocked anyway).

### 2. Deploy the Python service publicly

The Python escalation service must be reachable at the public host above and
started with `ESCALATE_TOKEN` set to **the same value** you put into the
`escalate-token` app setting below — the app sends it as `X-Escalate-Token`
and the service rejects requests with a wrong token (`401`).

### 3. Set the app secrets

Credentials are app-scoped secrets — never hardcoded:

```bash
devvit settings set escalate-token  # shared secret (== service ESCALATE_TOKEN)
devvit settings set service-url     # full https:// URL of the service (same host as SERVICE_BASE_URL)
```

The fixture action does not need another secret or service endpoint. Its
subreddit allowlist is compiled into `src/actions/fixture.ts`; changing either
target requires a code change and a new upload. The app must retain the
`redditAPI` and `redis` permissions: Reddit is used to resolve/submit posts,
and global Redis provides the duplicate claim.

## Publish checklist

1. **Edit `SERVICE_BASE_URL`** in `src/main.ts` to the public host of the
   Python service.
2. `npm run build && npm test` — both must be green.
3. `devvit login`.
4. Set the two secrets (see above) — `devvit settings set` works before or
   after upload, but they must be set before the app is used.
5. `devvit upload` (or `devvit publish`), then **install the app to the
   source and test subreddits** via the app installation page
   (`https://developers.reddit.com/r/<subreddit>/apps`). The fixture menu is
   intended only for source posts in `r/rpclipsgta`; the handler rejects other
   source subreddits. The invoking user must be a current moderator of
   `r/rpclipsgta`, and the app account must be allowed to submit link posts in
   both `S17Cjn21GT` and `rpclipsgta_mod_dev`.
6. Smoke-test escalation by pressing **Escalate** on a post with a test
   account, confirm the toast (`Warned u/... (R1 — Reddit Rules)` on a fresh
   account) and that a `mod_actions` record exists with `source = 'devvit'`.
7. Smoke-test fixtures from a source post containing a real-looking Twitch or
   Kick clip URL: choose each target once, verify the ordinary link post keeps
   that exact URL and has the expected prefix, then press the action again and
   verify no second post is created. Do not use this action on production data
   except for an intentional, reviewed test.

## Coexistence with the Python `!w` / `!b` recorder

The Python-side `!w` / `!b` comment-command recorder writes to the same
`mod_actions` collection with the same field conventions, so counts stay
consistent regardless of which surface (chat command or this app) triggered
the action. The service attributes records to their origin via its `source` /
`source_ref` fields.

## Development

```bash
npm run build   # tsc --noEmit — type check
npm test        # vitest run — unit tests (no network, no Devvit runtime)
```

- `src/lib/service.ts` — typed client for `POST /devvit/escalate` (injectable fetch).
- `src/actions/escalate.ts` — pure helpers: target resolution + toast text builders.
- `src/actions/fixture.ts` — fixture targets, URL/title validation, and dedupe orchestration.
- `src/actions/autoescalate.ts` — framework-free idempotent moderation and escalation orchestration.
- `src/lib/detection.ts` — pure rule 4/5/12 detectors and duplicate URL normalization.
- `src/lib/rules.ts` — the canonical 12 subreddit rules.
- `src/main.ts` — deliberately thin Devvit wiring (menus, forms, settings, Reddit API, toast).
- `tests/detection.test.ts` — deterministic detection and URL-normalization tests.
- `tests/autoescalate.test.ts` — in-memory Redis orchestration tests.
