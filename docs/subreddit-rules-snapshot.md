# r/RPClipsGTA rules & policy — snapshot

Verbatim snapshot of the subreddit wiki
(<https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/>, revision
`0ad077b6-db76-11ef-b638-d631ccee00dc`, reason "remove ref to x and twitter",
2025-01-25). This is the source of truth the deterministic detectors in
`src/lib/detection.ts` are derived from — keep this file in sync when the wiki
changes.

## Rules (canonical order 1–12)

1. **Reddit Rules** — hate speech, racism, sexism, homophobia, transphobia,
   inflammatory language; abusive speech based on religion, sex, gender, or
   sexual orientation; celebrating/advocating/threatening violence; doxxing.
   Defers to redditinc.com content policy and user agreement.
2. **Toxicity** — insulting/harassing/personal attacks, ad-hominem, demeaning
   and inflammatory remarks; vague/misleading/editorialized titles or quotes;
   bragging about trolling or bad faith; attacking users via post history;
   asking mods to remove/ban in-thread or accusing others of rule-breaking;
   attacking moderators; malicious misinformation and unsubstantiated
   allegations; out-of-context clips/quotes/tweets intended to harass;
   concern trolling, "touch grass", sealioning.
3. **No call to action** — no posting information intended to cause harm or
   harassment (twitch accounts, clips, discords, screenshots, twitter
   accounts); hinting at having such information may also earn a ban.
4. **Low Effort content** — appreciation/hate posts; "in before locked" /
   "in before drama" / "drama bait" type comments; low-effort memes; random
   questions (belong in the pinned question thread); submissions focusing on
   reddit; spam/off-topic; text posts under two sentences; linking a twitch
   channel instead of a clip; low-effort titles (just an emote or "this is
   funny"); low-effort insults towards streamers.
5. **Whitelisted domains** — only these domains may be submitted:
   `clips.twitch.tv`, `twitch.tv`, `facebook.com`, `fb.watch`, `kick.com`,
   `streamable.com`, `youtube.com`, `imgur.com`. Clips must be posted as
   "New Link"/"New Clip", not a text post; twitch clips need `clips.twitch.tv`
   specifically. Entire VODs (incl. timestamps) are prohibited as submissions
   but allowed in comments. Streamable links must include the streamer name
   in brackets in the title (e.g. "[Kiva] OG isn't mad, just disappointed." —
   POV streamer only). YouTube videos must come from an allowlisted channel
   (mod-managed list). Text posts are allowed for context or multiple
   related clips.
6. **Duplicate Post** — duplicates are removed; the first or best-timed
   submission is kept, even for the content creator.
7. **Self-promotion / Advertising** — comment-to-submission ratio should be
   ~9:1 to post your own content; no advertising (incl. servers); server
   clips are OK with join info in comments but no advertising keywords in
   the title.
8. **Non GTA RP content** — allowed only if: other-game/just-chatting clips
   with 2+ participants of whom 50%+ are GTA RPers; major life events for
   GTA RPers; referencing GTA RP outside of GTA RP.
9. **Suggestions for streamers or servers** — not allowed in posts (comments
   are exempt).
10. **Flairs and tags** — automoderator flairs most posts; NSFW GTA RP
    content must be tagged; spoiler tags are optional.
11. **Off-topic content** — catch-all for unsuitable content (unapproved
    meta threads, spam, politics).
12. **Banned Streamer** — at minimum, submissions about banned streamers are
    not allowed. The wiki states that talking/posting about them "won't get
    you a warning/ban" unless the user is "annoying about it" (mod
    discretion). Banned list: **Koil**, **dasMEHDI**, **Zombie_Barricades**.

## Policy — warns and bans (the escalation ladder)

1. Breaking a rule ⇒ warning; any rule broken again ⇒ 3 day ban. The
   generally followed system:

   | Level | Punishment       |
   | ----- | ---------------- |
   | 1     | Warning          |
   | 2     | 3 day ban        |
   | 3     | 7 day ban        |
   | 4     | 14 day ban       |
   | 5     | 30 day ban       |
   | 6     | Permanent ban    |

2. **Decay:** three months without a punishment ⇒ current level goes back by
   one.
3. Ban appeals go through modmail; abuse during appeals can increase
   punishment.

> The six-level ladder, including the **Level 4 — 14 day ban** rung and
> three-month decay, is enforced by the app in `src/lib/ladder.ts`. Action
> history is kept in the app's per-user Redis JSON arrays.

## Policy — AutoModerator / accounts

- Auto-removal: unverified email, < −20 comment karma, accounts younger than
  3 days.
- New accounts that break rules may be permanently banned at mod discretion.
- Mod discretion is the final word on all actions.

## Automation mapping (what the Mod remove action auto-detects)

Only deterministic, high-precision checks are run automatically after a
moderator presses **Remove post**; everything else stays on the manual rule
form or the **Escalate** menu path:

| Rule | Automatable? | Approach |
| ---- | ------------ | -------- |
| R1, R2, R3, R8, R9, R11 | No | Needs human judgment (manual Escalate). |
| R4 Low Effort (subset) | Yes | Title heuristics (emote-only / ultra-short), text posts < 2 sentences, twitch channel links. |
| R5 Whitelisted domains | Yes | Exact domain allowlist; VOD links; streamable title must carry `[Name]`. |
| R6 Duplicate Post | Yes | Normalized URL seen before (Redis, TTL-bounded window). |
| R7 Self-promotion | Partial | 9:1 ratio needs history analysis — deferred (manual). |
| R10 Flairs/tags | No | NSFW detection not deterministic — deferred (manual). |
| R12 Banned Streamer | Yes | Name match in title/URL ⇒ **remove only, no warn/ban** per wiki. |

### Implementation decisions

The implementation uses exact HTTP(S) domains (ignoring one leading `www.`),
with the documented legacy Twitch `/{channel}/clip/{slug}` exception. Rule 12
scans the title and decoded URL path segments only. Streamable uses a
letter-containing bracket tag at the start of the title as a convention proxy;
actual POV-streamer verification remains manual. Moderation is now
moderator-initiated through the **Remove post** menu action; there is no
`PostSubmit` trigger and no enable/disable setting. Detection chooses among
R5 > R6 > R4 > R12, and the locked action policy is remove + escalate for
R1, R2, R3, R4, R7, R8, and R9, versus remove-only for R5, R6, R10, R11, and
R12. Escalations carry the pressing moderator's username in `mod_user`.
Escalation is always available in-app through the Reddit API and Redis; there
are no service settings or manual service fallback. Implementation notes: the
policy's "three months" decay interval is represented deterministically as 90
days, and history is retained for 540 days (five effective levels × 90 days,
plus a 90-day buffer). A seen claim is released
before or during failed removal, but retained after removal; URL duplicate
claims are made only by otherwise-clean posts and use GET-then-SET in the
low-concurrency mod path.
