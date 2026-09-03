# rpclipsgta-modactions

A one-button **auto-escalating warn/ban** Devvit app for r/RPClipsGTA.

A moderator presses **Escalate** on any post or comment, picks which of the 12
rules was broken (plus an optional reason), and the app does the rest:

1. Looks up how many prior mod actions the author already has in PocketBase.
2. Picks the escalation ladder step for that count.
3. Executes it — a distinguished warning comment reply for first offenses, or
   a ban (with notification message) for repeat offenders.
4. Writes the action back into the PocketBase `mod_actions` collection so the
   Python-side `!w` / `!b` recorder and this app share one history.

All rule data, the ladder and the PocketBase client live in `src/lib/`; the
pure, unit-tested helpers (warning text, ban params, record fields) live in
`src/actions/escalate.ts`; `src/main.ts` is only the Devvit wiring.

## Escalation ladder

Prior mod actions are counted from PocketBase (`mod_actions` where
`target_user = <author>`). The acting mod does not choose the punishment:

| Priors | Action        | Length            |
| ------ | ------------- | ----------------- |
| 0      | ⚠️ Warning    | —                 |
| 1      | 🔨 Ban        | 3 days            |
| 2      | 🔨 Ban        | 7 days            |
| 3      | 🔨 Ban        | 30 days           |
| 4+     | 🔨 Ban        | **Permanent**     |

(The ladder lives in `src/lib/escalation.ts` — counts above 4 clamp to
permanent.)

## What happens on each action

### Warn (0 priors)

- The app submits a **comment reply on the target post/comment** (not a PM),
  as the app account, containing:
  - the author handle and what was flagged (post vs. comment),
  - the rule, as `R<number> — <name>` (e.g. `R2 — Toxicity`),
  - the optional reason, if the mod typed one,
  - a notice that repeat offenses escalate to temporary, then permanent, bans.
- The reply is then **distinguished as a mod** via `Comment.distinguish()`
  (exists in @devvit/public-api 0.14.2 — no sticky). If distinguishing fails
  (e.g. the app account is not a moderator), the failure is logged and
  skipped gracefully; the warning text stands on its own.

### Ban (1+ priors)

- `context.reddit.banUser(...)` with the ladder duration in days. For
  permanent bans the `duration` key is **omitted entirely** (per the typings,
  absence = permanent; `0` is not a documented permanent value).
- A ban notification `message` (PM to the banned user) is included — that
  part of the old flow stays.
- A modlog `note` is attached: rule + reason + prior count.

### Confirmation to the acting mod

- A **toast** is shown on every outcome (success, abort, failure). Toasts are
  available in 0.14.2 via `context.ui.showToast`, so they are the primary
  confirmation channel.
- **Bans additionally PM the acting mod a one-line summary** — a toast is
  ephemeral, and a durable record of who banned whom is worth the extra
  message.
- Warns need no extra PM: the distinguished comment on the thing *is* the
  visible confirmation.

### Failure handling

- **Execution failed** (couldn't resolve the target, comment/ban submission
  failed, PocketBase unreachable): toast + PM to the acting mod. **Nothing is
  recorded.**
- **Executed, but the PocketBase write failed**: the action has already
  happened, so the mod gets a toast + PM saying the action is **applied but
  NOT recorded**, with the error, so they can backfill the `mod_actions`
  record manually (otherwise the ladder will under-count that user).

## PocketBase host requirement (⚠️ edit `PB_HOST`)

The PocketBase host is **hardcoded at the top of `src/main.ts`**:

```ts
const PB_HOST = 'pb.rpclips.example.com';
```

This is a hard requirement of the Devvit platform:

- Apps run on **Reddit's servers** — `localhost` and LAN addresses are
  unreachable from there. The host must be a **public URL**.
- Fetch domains are **static**: they are baked into the app bundle from
  `Devvit.configure({ http: { domains: [PB_HOST] } })` **at upload time**.
  They cannot be set per-installation via app settings, wildcards
  (`*.example.com`) are not supported, and it must be a bare hostname (no
  protocol/port/path).
- **Changing the PocketBase host means editing `PB_HOST` and re-uploading the
  app.** The `pocketbase-url` setting must use exactly this host (the app
  aborts with a clear toast if it doesn't match — the fetch would be blocked
  anyway).

## Secrets setup

Credentials are app-scoped secrets — never hardcoded:

```bash
devvit settings set pocketbase-url      # e.g. https://pb.rpclips.example.com
devvit settings set pocketbase-email    # PocketBase superuser email
devvit settings set pocketbase-password # PocketBase superuser password
```

(These correspond to the three `isSecret` settings declared in
`src/main.ts`. `pocketbase-url` must be the full `https://` URL of the same
host as `PB_HOST`.)

## Publish checklist

1. **Edit `PB_HOST`** in `src/main.ts` to the public PocketBase host.
2. `npm run build && npm test` — both must be green.
3. `devvit login`.
4. Set the three secrets (see above) — `devvit settings set` works before or
   after upload, but they must be set before the app is used.
5. `devvit upload` (or `devvit publish`), then **install the app to the
   subreddit** via the app installation page
   (`https://developers.reddit.com/r/<subreddit>/apps`).
6. Make sure the **app account is a moderator** of the subreddit — otherwise
   the warning comment submits fine but the `distinguish()` call fails (it is
   skipped gracefully, logged as a warning).
7. Smoke-test: press **Escalate** on a post with a test account, confirm the
   warning comment appears distinguished and a `mod_actions` record exists
   with `source = 'devvit'`.

## Coexistence with the Python `!w` / `!b` recorder

The Python-side `!w` / `!b` comment-command recorder **stays running** until
you deliberately retire it by setting `MOD_COMMANDS_ENABLED=false` in the
Python bot's environment. Both systems write to the same `mod_actions`
collection with the same field conventions, so counts stay consistent:

- `duration_days` is `0` for warnings recorded live (matches the live `!w`
  recorder; only imported historical warnings carry real durations when
  known) and for permanent bans.
- This app writes `source = 'devvit'`, `source_ref = devvit:<thingId>` and
  `command_comment_id = ''` (no chat command triggered it), while the Python
  recorder uses its own `source` / `source_ref` values — records remain
  attributable to their origin.

## Development

```bash
npm run build   # tsc --noEmit — type check
npm test        # vitest run — 36 unit tests (no network, no Devvit runtime)
```

The handler logic in `src/actions/escalate.ts` and `src/lib/` is pure and
covered by `tests/`; `src/main.ts` is deliberately thin Devvit wiring.
