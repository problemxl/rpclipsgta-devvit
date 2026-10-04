# rpclipsgta-modactions

A self-contained moderator-actions Devvit app for r/RPClipsGTA. It provides:

- **Escalate** on posts and comments: applies the in-app warning/ban ladder,
  replies to the target, bans repeat offenders through Reddit, and records
  action history in installation Redis.
- **Remove post**: moderator-initiated deterministic R4/R5/R6/R12 detection,
  followed by removal and policy-controlled escalation.
- **Remove & escalate**: one press on a post or comment that removes the
  target and escalates its author through the ladder for any of the 12 rules,
  by explicit moderator discretion.
- **Create clip fixture**: moderator-only creation of an ordinary link post in
  the development or QA subreddit.
- **Seed test history**: dev/QA-only moderator tool to place a user at any
  ladder position (or reset them) for testing escalation and decay.

There is no external escalation endpoint, Python runtime bundled into the app,
PocketBase dependency, network allowlist, or app secret. The Devvit entry point
and its dependency graph never import or invoke anything under `scripts/`, never
use `fetch` or a mail client, and never connect to Guerrilla Mail or any other
mail server. All app execution happens through Devvit's Reddit and Redis APIs.

The local, manually invoked `scripts/gen-test-accounts.py` helper is a standalone
Python tool outside Devvit. It is not bundled with or imported by the app, and it
is not run by an app path or package lifecycle script. It uses only the Python
standard library to create Guerrilla Mail inboxes and generate credentials.
Account signup remains manual: it never calls Reddit signup APIs, uses a Reddit
browser/API, bypasses CAPTCHA, or opens verification links automatically. See
`docs/test-account-helper.md` for its security, session, storage, and testing
details.

## In-app escalation engine

A moderator presses **Escalate** on any post or comment, picks one of the 12
rules, and optionally supplies a reason. The app resolves the target and then:

1. Acquires `punish:lock:{lowercased username}` in Redis with atomic NX, so
   overlapping actions for one user serialize; a second concurrent action
   fails fast with an "already in progress" error. The lock has no automatic
   expiry: a Reddit call can outlive any practical lease, and expiry would
   permit a stale request to overlap a takeover. Release uses Redis
   WATCH/MULTI/EXEC to compare the owner token and delete only if the key did
   not change. There is deliberately no in-app recovery menu: Redis lock
   deletion cannot fence an already-running request or its Reddit call.
2. Reads an O(1)-ish **strict** summary of
   `modactions:z:user:{lowercased username}`: a Redis sorted set holding one
   row per infraction — the record JSON, which includes a unique id — scored by
   its epoch-ms timestamp. The summary is the `ZCARD` row count plus the
   newest row's score; if either Redis read fails, the action fails closed and
   no Reddit action is attempted. The full history is never loaded for rung
   selection.
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
   identical records can never overwrite each other. A failure or timeout
   after the Reddit request starts has an unknown external outcome: the
   pending row is retained, logged with its id, and requires manual Reddit
   reconciliation before retry. It is never auto-removed or auto-retried. A
   locally proven pre-call ownership failure may remove its own pending row
   only through an ownership-fenced WATCH transaction; if ownership is lost,
   the row is retained. Reddit execution is still attempted even if recording
   fails; the success toast then includes `(not recorded)`. Bans are refused
   outright when the resolved subreddit name is empty.
6. Releases the lock in a `finally` block — only when it was acquired. The
   flow also checks ownership immediately before the history append and before
   the Reddit call, and fails closed if the owner token changed. A Redis
   history-read failure also fails closed rather than treating the user as
   fresh.

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
- `punish:lock:{username}` — non-expiring owner-token lock. It is released
  with WATCH/MULTI/EXEC, never with an unsafe GET-then-DEL sequence. There is
  no in-app recovery because deletion cannot fence a stale owner.

## Remove & escalate action

**Remove & escalate** is a combined moderator action available on posts and
comments. One press removes the target thing and runs its author through the
same in-app ladder as **Escalate**. Unlike **Remove post**, there is no policy
class: the form offers all 12 rules with plain `R# — name` labels and no class
suffixes, because the wiki makes mod discretion the final word on all actions.

Ordering is remove-first: the thing is removed before any punishment is
applied, so a moderator never warns or bans over content that is still live.
A failed removal releases the idempotency claim and no punishment happens, so
the action can simply be retried. A failed escalation keeps the claim — the
thing is already gone — and the toast points to the plain **Escalate** menu
as the fallback for the ladder step.

Redis state is installation-scoped and idempotent:

- `removeescalate:seen:{thingId}` — seven-day claim (SET NX) acquired before
  any removal or punishment; a second press on the same post or comment reports
  "Already processed by this action."

## Testing the ladder

**Seed test history** is a moderator-only menu item shown on the subreddit
itself. Its form takes a username (no leading `u/`), an operation — **Seed
priors** or **Clear history** — and, for seeding, the number of priors (1–20)
and the age of the newest prior in days (0–3650). Seeding writes that many
warning rows spaced one day apart, with the newest row exactly the requested
age, so the decay clock starts where the operator wants it. Because the
installed Redis API has no atomic replace operation for this sorted-set
history, **Seed priors requires a verified empty history**. It refuses any
pre-existing rows (including a previous partial seed); press **Clear history**
explicitly and retry. A partial batch is reported as failed and is never
reported as a successful exact seed.

Two properties matter:

- **Hard dev/QA-only guard.** Every call first checks the subreddit against
  exactly `S17Cjn21GT` (development) and `rpclipsgta_mod_dev` (QA/staging),
  case-insensitively. Anywhere else — including production — the tool refuses
  before moderator authorization, username normalization, Redis locking, or any
  history access, and logs the denial loudly. Menu visibility is not treated as
  authorization: the form handler verifies the authenticated actor against
  Reddit's current moderator listing before it can seed or clear. The rows
  themselves are honest synthetics: rule 11 warnings recorded as
  `modUser: seed-tool` against `t3_seeded`.
- **Seeded rows are indistinguishable from real ones to the ladder.** They go
  through the same `HistoryStore` and per-user sorted set the punish flow
  reads, so rung selection and 90-day decay behave in a seeded test exactly as
  they would after months of real actions. Seed and clear share the exact
  per-user non-expiring owner-token lock used by punishment, so they cannot
  interleave with a punish/clear operation. A crashed request can leave this
  lock held. Clearing a user (`DEL` of the history key) resets them to a fresh
  first-offense state. If a batch write
  fails part-way through, the tool reports the landed count and deliberately
  does not auto-clear existing or partial history; clear explicitly before
  retrying. The success toast says that the history was empty when the exact
  seed was started.

Throwaway Reddit accounts for end-to-end testing are prepared only outside
Devvit with the standalone Python helper `scripts/gen-test-accounts.py`.
It provides a standard-library interactive terminal menu (bare invocation or
`tui`) with options to generate an inbox/credentials, check verification mail,
and exit. It also accepts safe noninteractive `gen [1-10]` and
`check [--wait seconds]` commands; these remain suitable for automation.
Positive `--wait` values are hard overall polling windows; `--wait 0` performs
one immediate poll. A menu invocation with redirected/non-TTY input refuses
immediately instead of waiting. It uses bounded standard-library HTTP requests to create
Guerrilla Mail
inboxes, keeps per-account session tokens/cookies, validates candidate
verification links as exact HTTPS Reddit verification routes, and writes
`test-accounts.txt` atomically with mode `0600`. Verification links are printed
as candidates for cautious human review; query tokens are redacted unless
`check --show-links` is explicitly requested. `test-accounts.txt` is gitignored;
never paste or commit it. The helper never calls Reddit signup APIs or any
Reddit endpoint; use the normal Reddit signup UI manually.

Testing playbook:

1. **Detection:** create a clip fixture from a source post into the dev or QA
   subreddit, then press **Remove post** on the fixture to confirm the
   R4/R5/R6/R12 classes and idempotency.
2. **Ladder:** seed a throwaway account with, say, 2 priors at age 0, then
   trigger one real violation — the next action must land on the matching rung
   (2 priors ⇒ 7 day ban). Seed 5 for the permanent-ban rung.
3. **Decay:** seed 1 prior at age 90 days and trigger a violation — the rung
   must have decayed back to a warning. Clear the user between scenarios.

### Stuck-lock operational recovery

The app intentionally exposes no lock-recovery menu. Do not run an
unconditional `DEL punish:lock:{user}`: it can delete a newer owner while an
old request is still able to call Reddit. First obtain an external quiescence
guarantee (stop or drain the relevant worker, or otherwise prove that the old
invocation and its Reddit request are dead). Then use an administrator Redis
tool that supports compare-and-delete against the exact observed owner token.
If that primitive or the quiescence proof is unavailable, leave the lock in
place and escalate operationally; do not guess, force-delete, or retry the
moderation action. This is an operational procedure, not a fencing guarantee.

## Publish checklist

1. Run `npm run build && npm test` — both must be green.
2. Run `python -m unittest discover -s tests -p 'test_*.py'` — local helper tests
   are deterministic and do not call Guerrilla Mail.
3. `devvit login`.
4. `devvit upload` (or `devvit publish`). No secrets or external URL settings
   are required.
5. Install the app to the source and test subreddits via the app installation
   page (`https://developers.reddit.com/r/<subreddit>/apps`). Fixture creation
   is intended only for source posts in `r/rpclipsgta`; the handler rejects
   other source subreddits.
6. Smoke-test escalation with a test account. Confirm a fresh account gets the
   warning toast (`Warned u/... (R1 — Reddit Rules)`), the warning reply, and a
   Redis history record. Exercise repeat and decay rungs before production use
   — in the dev/QA subreddits the **Seed test history** tool (see *Testing the
   ladder*) places any user on any rung in seconds.
7. Smoke-test fixtures from a source post containing a real-looking Twitch or
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
  (sorted set, one row per infraction), including strict fail-closed summaries
  for exact seeding.
- `src/lib/user-lock.ts` — shared non-expiring owner-token lock with
  WATCH/MULTI/EXEC compare-delete; no unsafe recovery operation is exposed.
- `src/actions/escalate.ts` — pure target resolution and toast builders.
- `src/actions/fixture.ts` — fixture targets, URL/title validation, and dedupe.
- `src/actions/seed.ts` — dev/QA-only history seeding and clearing for ladder
  testing, behind a hard subreddit allowlist.
- `src/actions/autoescalate.ts` — framework-free moderator Remove post and
  Remove & escalate orchestration.
- `src/lib/detection.ts` — pure R4/R5/R12 detectors and URL normalization.
- `src/lib/rules.ts` — canonical 12 subreddit rules.
- `src/main.ts` — Devvit wiring for menus, forms, Reddit APIs, and Redis.
- `tests/ladder.test.ts`, `tests/history.test.ts`, `tests/punish.test.ts`,
  `tests/seed.test.ts` — deterministic engine, storage, execution, and
  dev/QA-seeding coverage.
- `tests/test_gen_test_accounts.py` — offline mocked transport, CLI,
  URL, session, permission, and atomic-storage coverage for the standalone
  helper.
