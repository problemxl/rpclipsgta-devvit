# Local test-account helper

`scripts/gen-test-accounts.py` is a standalone, dependency-light Python tool for
preparing disposable accounts for local end-to-end testing. It is **not part of
the Devvit app**. No Python code is imported by `src/`, no Python runtime is
bundled, and the tool is never run by an npm lifecycle script.

## Boundary and safety

The helper does only two kinds of network work:

1. It calls the fixed Guerrilla Mail AJAX endpoint to create/list/fetch a
   disposable inbox.
2. It displays candidate links found in mail for a person to inspect.

It does **not** call Reddit, automate Reddit registration, use a Reddit API or
browser, bypass CAPTCHA, or open a link. A human must use the normal Reddit
signup page. The tool does not verify that a message sender is genuine; sender
metadata is only a filter, while every candidate URL is independently checked.
The current sender filter accepts only `noreply@reddit.com` (optionally with a
plain display name); sender metadata is never treated as authentication.

Candidate links must be HTTPS, have exactly `reddit.com` or
`www.reddit.com` as their host, have no user-info, explicit port, fragment, or
backslash, and use a verification-style route (`/verify/`, `/verification/`,
or `/activate/`). Redirect URLs and lookalike domains are rejected. Links are
printed as candidates only; inspect the sender, host, path, and expected signup
context before opening them manually.

## Commands

Python 3.10+ is recommended. The core uses only the standard library; no
package installation is required.

```sh
# Show commands, limits, exit statuses, and safety notes
python scripts/gen-test-accounts.py --help

# Interactive text menu (bare invocation or explicit tui; requires a TTY)
python scripts/gen-test-accounts.py
python scripts/gen-test-accounts.py tui

# Noninteractive commands (safe for scripts and CI)
python scripts/gen-test-accounts.py gen       # creates three accounts
python scripts/gen-test-accounts.py gen 1
python scripts/gen-test-accounts.py check --wait 120 --interval 10
python scripts/gen-test-accounts.py check --wait=0  # one immediate poll

# Offline tests; no real Guerrilla Mail request is made
python -m unittest discover -s tests -p 'test_*.py'
```

The menu is a small standard-library text UI: generate one inbox plus a
username/password, display the generated email and username, and reveal the
password only after an explicit confirmation; check saved inboxes for
verification mail; or exit. It never signs up for Reddit or opens a link.
`check` and the menu redact verification query tokens by default; use
`--show-links` (CLI) or the menu confirmation only when a human is ready to
inspect a candidate manually. The explicit `gen` and `check` commands remain
noninteractive and suitable for scripts. Bare `python scripts/gen-test-accounts.py`
or `tui` refuses immediately when stdin/stdout are not TTYs, so redirected jobs
do not hang.
A positive `--wait` is a hard overall polling window, including bounded network
reads; `--wait 0` performs one immediate poll using the normal request timeout.
Verification links are never opened automatically. The `--store PATH` option is
available on all commands for automation and isolated tests. The default is
repository-root `test-accounts.txt`. A same-directory lock serializes each
load/update/save operation; the lock file is also gitignored.

## Secret storage and sessions

`test-accounts.txt` is gitignored and contains Reddit passwords, inbox session
tokens, and any allowlisted Guerrilla Mail cookies. It is written with an
atomic same-directory temporary file, flushed and fsynced before replacement,
and set to exactly `0600`. Existing symlinks and non-regular destinations are
refused. A failed write leaves the previous destination untouched and removes
the temporary file. Directory durability failures are reported instead of
silently being ignored. Use a trusted private parent directory; path-based
filesystem races outside the helper's lock/permissions model still require
host-level isolation.

New writes use versioned JSON records (one record per line, despite the
historical `.txt` suffix). The loader accepts the old helper's `sidToken` JSON
records and saving migrates them to a `session.sid_token` record. Sessions are
kept per account rather than shared. A rotated session token and fixed-origin
cookies are retained after successful requests so a later check can continue
where possible. Sessions can expire at any time; use the Guerrilla Mail web
inbox or generate a new account rather than trying to recover a token.

Generation saves after each successfully created inbox. This preserves already
created accounts after an interruption, while each individual write remains
atomic. Do not copy the file into an issue, chat, test fixture, or commit.
Delete it when the local test accounts are no longer needed:

```sh
rm -f test-accounts.txt
```

## Limitations

- Guerrilla Mail is an external disposable-mail service; availability,
  retention, sender metadata, and session lifetime are outside this tool's
  control.
- A verification candidate is not proof of authenticity. The tool deliberately
  does not follow it, resolve it, or submit it. Query tokens are bearer-like;
  output is redacted by default and `--show-links` should only be used for a
  controlled terminal.
- There is no automated Reddit signup and no guarantee that Reddit accepts a
  disposable address or the generated username.
- The menu does not require Textual or another third-party dependency; it uses
  standard-library terminal prompts. Use the injected/mock transport in tests
  for deterministic automation.
