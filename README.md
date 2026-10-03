# rpclipsgta-modactions

A self-contained moderator-actions Devvit app for r/RPClipsGTA. It provides:

- **Escalate** on posts and comments: applies the in-app warning/ban ladder,
  replies to the target, bans repeat offenders through Reddit, and records
  action history in installation Redis.
- **Remove post**: moderator-initiated deterministic R4/R5/R6/R12 detection,
  followed by removal and policy-controlled escalation.
- **Create clip fixture**: moderator-only creation of an ordinary link post in
  the development or QA subreddit.

There is no external escalation endpoint, Python runtime, PocketBase dependency,
network allowlist, or app secret. All execution happens through Devvit's Reddit
and Redis APIs.

## In-app escalation engine

A moderator presses **Escalate** on any post or comment, picks one of the 12
rules, and optionally supplies a reason. The app resolves the target and then:

1. Acquires `punish:lock:{lowercased username}` in Redis with NX and a ~30s
   TTL, so overlapping actions for one user serialize; a second concurrent
   action fails fast with an "already in progress" error.
2. Reads an O(1)-ish summary of `modactions:z:user:{lowercased username}`: a
   Redis sorted set holding one row per infraction — the record JSON, which
   includes a unique id — scored by its epoch-ms timestamp. The summary is the
   `ZCARD` row count plus the newest row's score; the full history is never
   loaded for rung selection.
3. Applies the wiki ladder and decay policy:

   | Effective prior actions | Action |
   | ----------------------- | ------ |
   | 0 | Warning |
   | 1 | 3 day ban |
   | 2 | 7 day ban |
   | 3 | 14 day ban |
   | 4 | 30 day ban |
   | 5+ | Permanent ban |

   Every full three-month quiet stretch since the **latest** prior action lowers
   the effective prior count by one, never below zero. History is retained for
   life — no record cap, no TTL — so decay alone governs the rung.
4. Executes the selected action with Reddit. A warning is a Markdown reply to
   the target thing. A ban uses `reddit.banUser` with the ladder message, short
   rule reason, and `[devvit] by {modUser}` note. Permanent bans omit duration.
5. Appends the action to the sorted set **before** execution
   (pending-record-first) as a new row with a freshly minted unique id, so
   identical records can never overwrite each other. If the Reddit call then
   fails, the pending row is compensated (removed by id) so the next action
   sees no phantom prior. Reddit execution is still attempted even if recording
   fails; the success toast then includes `(not recorded)`. Bans are refused
   outright when the resolved subreddit name is empty.
6. Releases the lock in a `finally` block — only when it was acquired.

The warning comment links the rules wiki, explains the current violation and
next ladder consequence, and points appeals to modmail. Reddit's comment API
supports Markdown text and replies by passing the target post/comment ID as
`id`; this app submits `{ id, text, runAs: 'APP' }`.

Action history is deliberately kept forever: one sorted-set row per
infraction, no record cap, no TTL. The 90-day decay against the latest action
is what keeps rungs correct, so old rows never over-punish — they only
preserve the audit trail.

Two deliberate trade-offs remain:

- Redis history is not shared with the retired Python/PocketBase stack.
- Devvit's comment submission API does not provide a distinguished-comment
  option, so warning comments use clear moderator-style Markdown instead.

The toast formats remain:

- warning: `Warned u/x (R2 — Toxicity)`
- ban: `Banned u/x — 7 day ban`
- either action can append ` (not recorded)` when Redis history cannot be saved.

## Moderator clip fixtures

On a source **post**, a moderator can choose **Create clip fixture** from the
post menu. The form offers exactly these targets; there is no free-form
subreddit field:

| Form choice | Subreddit | Title prefix |
| --- | --- | --- |
| Development | `S17Cjn21GT` | `[DEV FIXTURE]` |
| QA/staging | `rpclipsgta_mod_dev` | `[QA FIXTURE]` |

The app resolves the source post, requires that it belongs to `r/rpclipsgta`,
verifies the acting username in Reddit's moderator listing, validates that its
submitted URL is a Twitch or Kick clip URL, and calls `reddit.submitPost` with
`runAs: 'APP'`, the original URL, and a bounded title. A structured copy of the
source/actor/target/destination data is stored in global Redis metadata. It does
not call `crosspost()` and never calls `submitComment()`.

Fixture creation is deduplicated by source post ID + target using a global Redis
`SET NX` claim. A repeated press reports that the fixture is already claimed and
returns stored destination metadata when available. A pending claim expires
after ten minutes, and a failed Reddit submission releases it so it can be
retried. Deleting a fixture manually does not clear a successful claim.

The menu is registered with `forUserType: 'moderator'`. The form handler also
checks the source subreddit and verifies current moderator membership through
Reddit before it reads or writes fixture state. Errors are shown in a toast and
details are logged.

## Mod remove action

There is no autonomous moderation trigger and no auto-escalation toggle. A
moderator presses **Remove post** from a post menu. The action resolves the
post, performs deterministic checks, removes it, and escalates only when the
policy class says to do so. If detection is clean, a form offers all 12 rules
and an optional reason.

The automatic checks remain high-confidence:

- **R5:** HTTP(S) links must use one of the eight exact allowlisted domains;
  Twitch/Kick VOD URLs are rejected; Twitch's only `twitch.tv` exception is the
  legacy `/{channel}/clip/{slug}` path; Streamable titles need a letter-bearing
  bracket tag at the start.
- **R6:** a normalized allowlisted URL already seen in the 14-day Redis window.
- **R4:** Twitch channel links, text posts with fewer than two sentences, and
  titles containing no letters.
- **R12:** a banned streamer name in the title or decoded URL path segments.

| Rules | Class |
| --- | --- |
| R1, R2, R3, R4, R7, R8, R9 | remove + escalate |
| R5, R6, R10, R11, R12 | remove only |

Detection priority is R5 > R6 > R4 > R12. R12 is remove-only per the wiki.
The form still allows manual judgment for every rule. Manual and automatic
escalations attribute the actual pressing moderator as `modUser`.

Redis state is installation-scoped and idempotent:

- `autoescalate:seen:{postId}` — seven-day claim, acquired before author/content
  checks and retained after successful handling.
- `autoescalate:url:{normalizedUrl}` — 14-day duplicate claim, made only by an
  otherwise-clean post.
- `modactions:z:user:{username}` — lifetime in-app action history, one
  sorted-set row per infraction.

## Publish checklist

1. Run `npm run build && npm test` — both must be green.
2. `devvit login`.
3. `devvit upload` (or `devvit publish`). No secrets or external URL settings
   are required.
4. Install the app to the source and test subreddits via the app installation
   page (`https://developers.reddit.com/r/<subreddit>/apps`). Fixture creation
   is intended only for source posts in `r/rpclipsgta`; the handler rejects
   other source subreddits.
5. Smoke-test escalation with a test account. Confirm a fresh account gets the
   warning toast (`Warned u/... (R1 — Reddit Rules)`), the warning reply, and a
   Redis history record. Exercise repeat and decay rungs before production use.
6. Smoke-test fixtures from a source post containing a real-looking Twitch or
   Kick clip URL. Choose each target once, verify the exact URL and title prefix,
   then repeat the action to confirm no second post is created.

## Development

```bash
npm run build   # tsc --noEmit — type check
npm test        # vitest run — unit tests, no network or Devvit runtime
```

- `src/actions/punish.ts` — pure in-app ladder execution seam and warning text.
- `src/lib/ladder.ts` — wiki ladder and three-month decay policy.
- `src/lib/history.ts` — Redis-backed lifetime per-user action history
  (sorted set, one row per infraction).
- `src/actions/escalate.ts` — pure target resolution and toast builders.
- `src/actions/fixture.ts` — fixture targets, URL/title validation, and dedupe.
- `src/actions/autoescalate.ts` — framework-free moderator Remove post orchestration.
- `src/lib/detection.ts` — pure R4/R5/R12 detectors and URL normalization.
- `src/lib/rules.ts` — canonical 12 subreddit rules.
- `src/main.ts` — Devvit wiring for menus, forms, Reddit APIs, and Redis.
- `tests/ladder.test.ts`, `tests/history.test.ts`, `tests/punish.test.ts` —
  deterministic engine, storage, and execution coverage.
