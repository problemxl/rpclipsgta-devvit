# Privacy Policy

**Last Updated: 2026-11-01**

This Privacy Policy explains how **rpcclipsgta-moderator** (the "App"), maintained by u/rhythmkiller, handles information when it operates in r/RPClipsGTA and authorized development or test subreddits.

## 1. Overview

The App is a Reddit moderation and sidebar utility. It uses Reddit's Devvit platform and Reddit API to perform moderator-directed actions and uses Twitch's API only to obtain public stream listings for the sidebar. We designed the App to keep its application data in Reddit/Devvit-provided storage and not to operate an external database, analytics service, or off-platform user-data logging system.

This Policy describes the App's handling of information. Reddit separately controls information processed by Reddit itself, and your use of Reddit remains subject to Reddit's User Agreement and Privacy Policy.

## 2. Data We Collect

When the App operates, it may read or generate the following information:

- **Reddit account and authorization information:** Reddit usernames and Reddit-provided identifiers for users and content, including moderator and target-user usernames and the identifiers needed to check moderator authorization and identify the post or comment being handled. The App may read Reddit's moderator lists for those checks.
- **Moderation and content metadata:** post and comment IDs, titles, URLs, permalinks, subreddit names, and the identity of the moderator who initiated an action. The App reads this information when a moderator uses its moderation or fixture tools.
- **Escalation history:** a record keyed by the normalized Reddit username containing the rule involved, the warning or ban action, the action timestamp, the acted-on Reddit post or comment ID, and the acting moderator username. A record can temporarily include a pending status while a Reddit action is being reconciled. The history does not store the body of the post or comment.
- **Sidebar and fixture information:** the public Twitch stream names, titles, viewer counts, links, and refresh time used to render the sidebar; the widget text and marker-delimited text the App writes to Reddit; and limited Reddit IDs, permalinks, subreddit names, and moderator usernames needed by development/test clip fixtures and deduplication.
- **App authentication and operational data:** the Twitch client ID and client secret configured by the app owner, and the short-lived Twitch OAuth access token cached for the sidebar refresh. The client secret is an app-scope Devvit secret setting.

The App does not ask for or intentionally collect real names, email addresses, passwords, payment or financial information, precise location, contacts, or other off-platform personally identifying information. It does not use analytics or an external service to build profiles about Redditors.

## 3. Storage, Processing, and External Requests

Application state is stored in Devvit-provided Redis associated with the App's Reddit installation. This includes the authoritative escalation-history rows, per-user action-lock tokens, the cached Twitch OAuth token, and operational deduplication keys. After an escalation row is finalized, the App also writes an append-only backup line to Reddit-native v1 wiki pages named `escalation-log/YYYY-MM` (with numbered rotation pages when needed). Before writing content, the App calls Reddit's `updateWikiPageSettings` with `listed: false` and `permLevel: 2` (`MODS_ONLY`), so each mirror page is unlisted and viewable/editable only by moderators. These wiki pages are Reddit content on the relevant subreddit, not an external database; Redis remains authoritative. The App has no external database. The widget and v1 `config/sidebar` wiki text that it writes are likewise Reddit-native content, not a separate external database.

The App's only outbound network requests outside Reddit/Devvit are to these two allowlisted Twitch domains:

- `id.twitch.tv` for the client-credentials OAuth request; and
- `api.twitch.tv` for the public Twitch stream listing.

Those requests carry the App's own Twitch client credentials and OAuth token as required by Twitch. They carry **no Redditor usernames, Reddit user IDs, post or comment IDs, titles, URLs, bodies, or other Reddit user data**. The Twitch response contains public stream data used for the sidebar. No Reddit user data is shared with Twitch or any other third party.

## 4. No Selling or AI Training

We do not sell, rent, or trade information collected by the App. We do not use information collected by the App to train, fine-tune, or evaluate artificial intelligence or machine-learning models, and we do not provide it to third parties for those purposes.

## 5. Data Retention and Deletion

Escalation history is retained in the installation's Devvit Redis for as long as the App remains installed. The history has no automatic record cap or time-to-live: it preserves the moderation audit trail while the ladder's quiet-period decay determines the effective escalation level. Deleting a Reddit post or comment does not automatically delete its corresponding history row. The row records the moderation action and identifiers, not the deleted post or comment body, so the history may remain after the content is removed from Reddit.

Operational data has purpose-specific retention. The Twitch OAuth token is cached only for the token's usable lifetime, and deduplication data may use configured windows. Widget and wiki text written to Reddit remains there until a later refresh, a moderator edit, or manual removal of that Reddit content. When the App is uninstalled, Devvit removes its installation Redis data.

Deleting an escalation-history row from Redis does not remove the corresponding JSONL backup line from a Reddit wiki page. Redis remains authoritative, while wiki backup content must be removed or edited separately by an authorized moderator if appropriate; an ambiguous append/pointer failure can also leave a duplicate line, so consumers should deduplicate by row `id`. We honor manual requests to delete information that the App controls. Send a private message on Reddit to **u/rhythmkiller** and identify the username or record concerned; do not include a password, Twitch client secret, or other credential. This does not delete information held independently by Reddit or Twitch under their own policies, and it does not automatically remove the Reddit content or moderation records maintained by Reddit.

## 6. Contact

For privacy questions or a manual deletion request, contact **u/rhythmkiller** by private message on Reddit. We may ask for enough information to verify and locate a request, but we will not ask you to send a password or secret credential.
