# API Notes — @devvit/public-api 0.14.2

> **Historical reference only.** This file contains examples from the retired
> PocketBase-backed implementation, including generic Devvit HTTP/fetch
> permissions and settings for that old service. The current app does **not**
> configure `http`, call `fetch`, use PocketBase, or declare email/password
> settings. Do not apply those retired examples to the current app. The only
> network/email helper in this repository is the explicitly local
> `scripts/gen-test-accounts.py` CLI, which is outside the Devvit bundle and is
> not imported by the app.

All signatures below are quoted/verified from the installed typings under
`node_modules/@devvit/public-api` (and its `@devvit/*` dependencies). Import
path for everything app-facing is `@devvit/public-api`.

- `Devvit` class: `node_modules/@devvit/public-api/devvit/Devvit.d.ts`
- Config type: `node_modules/@devvit/public-api/types/configuration.d.ts`
- Menu item: `node_modules/@devvit/public-api/types/menu-item.d.ts`
- Forms: `node_modules/@devvit/public-api/types/form.d.ts`, field shapes in
  `node_modules/@devvit/shared-types/shared/form.d.ts`
- Reddit client: `node_modules/@devvit/reddit/RedditClient.d.ts`,
  option types in `node_modules/@devvit/reddit/models/*.d.ts`
- Settings client: `node_modules/@devvit/settings/SettingsClient.d.ts`
- Context: `node_modules/@devvit/public-api/types/context.d.ts`
- UI client: `node_modules/@devvit/public-api/types/ui-client.d.ts`
- Redis public API/types/runtime: `node_modules/@devvit/public-api/types/redis.d.ts`,
  `node_modules/@devvit/redis/RedisClient.d.ts`,
  `node_modules/@devvit/redis/RedisClient.js`, and
  `node_modules/@devvit/protos/schema/devvit/plugin/redis/redisapi.proto`

---

## Current Redis concurrency notes (installed 0.14.6)

The current app uses the installed Devvit Redis API, not an assumed Redis
command surface:

- `set(key, value, { nx: true })` is atomic acquisition. The installed
  `RedisClient.set` returns `"OK"` for success and the runtime's empty string
  value when NX declines the write; it does not expose Lua or an atomic
  compare-delete helper.
- The installed client exposes `watch(...keys)`, returning a transaction with
  `multi()`, queued `del()`/`zRem()`, `discard()`, and `exec()`. The app reads
  the owner token after WATCH, queues destructive work only when it matches,
  and commits the transaction. A changed watched key aborts the transaction,
  so release and ownership-fenced compensation never perform an unsafe
  GET-then-DEL or stale history mutation.
- Redis has expiry support, but a 30-second lease is not sound for this flow:
  a Reddit request can run longer and then mutate history or perform an
  external action after a new owner takes over. The shared action lock is
  therefore non-expiring. The app intentionally exposes no recovery menu:
  Redis cannot fence an already-started Reddit call, and an unconditional DEL
  could delete a replacement owner. Operators must obtain external quiescence
  and use a separate administrative compare-and-delete procedure documented in
  README.md; if either guarantee is unavailable, leave the lock in place.
- The Redis client has no atomic sorted-set replace operation. Seed therefore
  performs a strict summary read, rejects any non-empty history, appends the
  requested rows, and verifies count/newest score before reporting success.
  A partial batch remains visible and must be explicitly cleared before retry.
  Punishment also uses strict summary reads; a Redis read failure never becomes
  a fresh-user warning path. A started Reddit request that times out or throws
  leaves its pending row for manual reconciliation because the external result
  is ambiguous.

The relevant source is `src/lib/user-lock.ts` and `src/actions/seed.ts`. The transaction mock shipped in the installed
package is only a test double; the app's deterministic tests model WATCH's
abort-on-change behavior explicitly.

---

## a. `Devvit.configure` with reddit + http permissions (external fetch to PocketBase)

```ts
import { Devvit } from '@devvit/public-api';

Devvit.configure({
  redditAPI: true,
  http: { domains: ['your-pb-host.example.com'] },
});
```

Exact signature (`devvit/Devvit.d.ts`):

```ts
static configure(config: Configuration): void;
```

Exact `Configuration` type (`types/configuration.d.ts`):

```ts
export type Configuration = {
    /** Allows your app to use the HTTP/Fetch API */
    http?: PluginSettings | boolean | {
        domains: string[];
    };
    /** Allows your app to use the reddit API */
    redditAPI?: PluginSettings | boolean;
    /** Allows your app to use the Redis Plugin */
    redis?: PluginSettings | boolean;
    /** Allows media uploads from apps */
    media?: PluginSettings | boolean;
    /** Allows your app to call Reddit APIs on behalf of the User. */
    userActions?: boolean | { enabled: boolean } | { scopes: Scope[] }; // (condensed)
    /** Allows your app to use the Blob Plugin */
    blob?: PluginSettings | boolean;
};
```

### How the allowed-domains config works (verified in `@devvit/shared-types/fetch-domains.js` and `public-api/devvit/Devvit.js`)

- Domains are **static**: they must be passed in the `Devvit.configure({ http: { domains: [...] } })`
  call in source. `configure()` normalizes them (strips protocol and `www.`, requires a valid
  TLD, e.g. `.com`) and registers them as `requestedFetchDomains` on the app's permission
  config at **bundle/upload time**:

  ```js
  // public-api/devvit/Devvit.js
  config.addPermissions?.({
      requestedFetchDomains: Devvit.domains, // normalized from configure()
      asUserScopes: Devvit.scopes,
  });
  ```

- **Wildcard support: NO.** `normalizeDomains()` treats every entry as a literal hostname —
  `*.example.com` fails the TLD check and `new URL()` parsing. Register the exact host, e.g.
  `domains: ['pb.rpclips.example.com']` (protocol/port are not part of the match; the
  platform matches by hostname, see `FetchDomain { domain: "api.stlouisfed.org" }` in
  `@devvit/protos/json/devvit/dev_portal/fetch_domain/fetch_domain.d.ts`).
- **Runtime/settings-configured domains: NOT possible.** Domains cannot come from app settings
  or form input at runtime — they are baked into the app bundle. To change hosts you must
  update `configure()` and re-upload the app. (Runtime values you *can* read from settings:
  username/password/token for that host — see section f.)
- Hard limit: **25 domains** (`MAX_DOMAINS = 25`, `assertRequestedFetchDomainsLimit` throws
  beyond that).
- Once `http` is enabled, use the **global `fetch`** inside handlers — the Devvit runtime
  routes it through the HTTP plugin and enforces the domain allowlist server-side.
  Responses are standard `Response` objects (`await fetch(url).then(r => r.json())`).
- Extra guard enforced by the API: secret string settings **must** be app-scoped (see f).

Minimal working example (PocketBase on a fixed host):

```ts
Devvit.configure({
  redditAPI: true,
  http: { domains: ['pb.rpclips.example.com'] },
});

// later, in a handler:
const res = await fetch(`https://pb.rpclips.example.com/api/health`);
```

---

## b. Mod menu item on posts AND comments

Exact API (`devvit/Devvit.d.ts` + `types/menu-item.d.ts`):

```ts
static addMenuItem(item: MenuItem): void;

export type MenuItem = {
    label: string;
    description?: string;
    location: MenuItemLocation | MenuItemLocation[];
    /** @experimental — only for post menu items ('currentApp') */
    postFilter?: MenuItemPostFilter;
    forUserType?: MenuItemUserType | MenuItemUserType[]; // 'loggedOut' | 'moderator'
    onPress: (event: MenuItemRequest, context: Devvit.Context) => void | Promise<void>;
};

export type MenuItemLocation = 'subreddit' | 'post' | 'comment';

export type MenuItemRequest = {
    location: MenuItemLocation;
    /** The ID of subreddit/post/comment; includes Thing ID prefix:
        t1_ comment, t3_ post, t5_ subreddit */
    targetId: string;
};
```

To show on posts AND comments, pass an array of locations. Use `forUserType: 'moderator'`
so only mods see it:

```ts
Devvit.addMenuItem({
  label: 'Mod action',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: async (event, context) => {
    // event.targetId is 't3_xxx' (post) or 't1_xxx' (comment)
    context.ui.showForm(someFormKey, { targetId: event.targetId });
  },
});
```

### Getting author / id / permalink of the target

From the press event you only get `event.targetId`. Resolve the thing via the reddit client
(`public-api/apis/reddit/RedditAPIClient.d.ts` — note these take plain `string` ids):

```ts
getPostById(id: string): Promise<Post>;
getCommentById(id: string): Promise<Comment>;
```

Relevant getters (`@devvit/reddit/models/Post.d.ts` / `Comment.d.ts`):

```ts
// Post
get id(): T3;                    // 't3_...'
get authorId(): T2 | undefined;
get authorName(): string;        // without leading u/
get permalink(): string;         // path relative to https://www.reddit.com
get subredditName(): string;

// Comment
get id(): T1;                    // 't1_...'
get authorName(): string;
get permalink(): string;
get postId(): T3;                // parent post id
get subredditName(): string;
```

Example:

```ts
onPress: async (event, context) => {
  if (event.targetId.startsWith('t3_')) {
    const post = await context.reddit.getPostById(event.targetId);
    const { authorName, id, permalink } = post;
  } else if (event.targetId.startsWith('t1_')) {
    const comment = await context.reddit.getCommentById(event.targetId);
    const { authorName, id, permalink, postId } = comment;
  }
}
```

> `context.postId` / `context.commentId` also exist on `BaseContext` for some handlers, but
> for menu presses rely on `event.targetId` — it is always populated with the target thing.

---

## c. Forms: define, open, receive values

Exact API (`devvit/Devvit.d.ts` + `types/form.d.ts`):

```ts
static createForm<const T extends Form | FormFunction>(
  form: T,
  onSubmit: FormOnSubmitEventHandler<FormToFormValues<T>>
): FormKey;

export type FormOnSubmitEvent<T extends Partial<JSONObject>> = {
    values: T;
};

export type FormOnSubmitEventHandler<Data extends Partial<JSONObject>> = (
    event: FormOnSubmitEvent<Data>,
    context: Devvit.Context
) => void | Promise<void>;
```

Open a form from a menu item / handler (`types/ui-client.d.ts`):

```ts
export type UIClient = {
    showForm(formKey: FormKey, data?: JSONObject | undefined): void;
    showToast(text: string): void;                  // also showToast(toast: Toast)
    navigateTo(url: string): void;                  // also accepts {permalink}|{url}
    // ...
};
```

`Form` and field types (`@devvit/shared-types/shared/form.d.ts`):

```ts
export type Form = {
    fields: FormField[];
    title?: string;
    description?: string;
    acceptLabel?: string;   // submit button label
    cancelLabel?: string;
};

export type FormField = StringField | ImageField | ParagraphField | NumberField
                      | BooleanField | SelectField | FormFieldGroup;

// shared BaseField props: name, label, helpText?, required?, disabled?, defaultValue?, scope?
export type StringField = BaseField<string> & { type: 'string'; placeholder?...; isSecret?: boolean };
export type ParagraphField = BaseField<string> & { type: 'paragraph'; placeholder?... };
export type NumberField = BaseField<number> & { type: 'number' };
export type BooleanField = { type: 'boolean'; ... };            // toggle
export type SelectField = BaseField<string[]> & {
    type: 'select';
    options: FieldConfig_Selection_Item[];  // { label: string; value: string }[]
    multiSelect?: boolean;
};
```

**Important value-type gotchas** (how `FormToFormValues` maps fields → `event.values`):
- `string` / `paragraph` field → `string`
- `number` field → `number`
- `boolean` field → `boolean`
- **`select` field → `string[]`** (always an array, even single-select; use `[0]`)
- Fields not filled in / optional fields may be missing or empty in values.

**No `buttons`/`selector` field type exists in 0.14.2** — selection renders as a dropdown
(`renderAsList` and `min/maxSelections` are omitted from the public `SelectField` type).

Full pattern (typed automatically — `FormToFormValues` derives the values type from the
literal `fields` array):

```ts
import { Devvit } from '@devvit/public-api';

const modActionForm = Devvit.createForm(
  {
    title: 'Take mod action',
    acceptLabel: 'Apply',
    fields: [
      {
        type: 'select',
        name: 'rule',
        label: 'Rule broken',
        required: true,
        options: [{ label: '1 — Reddit Rules', value: '1' } /* ... */],
      },
      {
        type: 'paragraph',
        name: 'reason',
        label: 'Reason (sent to the user)',
        required: true,
      },
      { type: 'boolean', name: 'notify', label: 'Send the user a PM', defaultValue: true },
    ],
  },
  async (event, context) => {
    const rule = event.values.rule[0];   // select values are string[]
    const reason = event.values.reason;  // string
    const notify = event.values.notify;  // boolean
    // ...do the action, then:
    context.ui.showToast('Done');
  }
);

// open it from a menu item; pass-through data arrives in `context`? No —
// pass-through data is NOT merged into event.values. Keep targetId in a closure,
// or stash it before showing the form (see note below).
Devvit.addMenuItem({
  label: 'Mod action',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: (event, context) => {
    context.ui.showForm(modActionForm, { targetId: event.targetId });
  },
});
```

**Note on `showForm(formKey, data?)`:** the second argument is opaque JSON passed along with
the submission. In 0.14.2 `FormOnSubmitEvent` only exposes `values` (no separate `context`
data field), so the safest pattern for carrying the target id from press → submit is to keep
the id in the form definition closure per-target is *not* possible (forms are static); the
recommended approach is to re-derive the target inside `onSubmit` from `context.postId` /
`context.commentId`, or store the pending target in Redis keyed by the user before calling
`showForm`. Design the second worker's app accordingly (e.g. derive from `context` first,
Redis fallback if neither is set).

---

## d. Ban a user (duration in days / permanent)

Exact API (`@devvit/reddit/RedditClient.d.ts`, exposed as `context.reddit`):

```ts
banUser(options: BanUserOptions): Promise<void>;
```

```ts
// @devvit/reddit/models/User.d.ts
export type BanUserOptions = {
    username: string;        // without leading u/
    subredditName: string;
    context?: string;        // permalink/id of post or comment that caused the ban
    message?: string;        // message sent to the user with the ban
    reason?: string;         // shown in the mod log
    duration?: number;       // DAYS; omit/undefined => PERMANENT ban
    note?: string;           // private mod note
};
```

Usage:

```ts
// 3-day ban
await context.reddit.banUser({
  username: authorName,
  subredditName: context.subredditName!,       // BaseContext.subredditName?: string
  duration: 3,                                  // days
  reason: `Rule ${rule.number}: ${rule.name}`,
  message: 'You have been banned for 3 days.',
  context: permalink,
  note: 'Auto-escalation ladder',
});

// permanent: omit `duration`
await context.reddit.banUser({ username, subredditName, reason });
```

(`subreddit.banUser(options: Omit<BanUserOptions, 'subredditName'>)` also exists on
`Subreddit` objects from `reddit.getSubredditById(...)`; `unbanUser(username, subredditName)`
undoes it. There is also `getBannedUsers({ subredditName, username? })` to check status.)

---

## e. Send a private message to a user

Exact API (`@devvit/reddit/RedditClient.d.ts`):

```ts
sendPrivateMessage(options: SendPrivateMessageOptions): Promise<void>;
```

```ts
// @devvit/reddit/models/PrivateMessage.d.ts
export type SendPrivateMessageOptions = {
    /** Recipient username (without the leading u/), or /r/name for that subreddit's moderators. */
    to: string;
    /** The subject of the message. */
    subject: string;
    /** The body of the message in Markdown text format. */
    text: string;
};
```

Usage:

```ts
await context.reddit.sendPrivateMessage({
  to: authorName,
  subject: `Your post was removed: Rule ${rule.number}`,
  text: `Hi ${authorName},\n\n${reason}\n\n*This is an automated mod message.*`,
});
```

> `sendPrivateMessageAsSubreddit` exists but is **deprecated** in the typings — use modmail
> (`context.reddit.modMail.createConversation(...)`) if a modmail-style notice is needed.

---

## f. App settings with SECRET fields

Exact API (`devvit/Devvit.d.ts`):

```ts
static addSettings(fields: SettingsFormField[] | SettingsFormField): void;
```

Field types (`types/settings.d.ts`): `SettingsFormField = ValidatedStringField |
ValidatedParagraphField | ValidatedNumberField | ValidatedBooleanField |
ValidatedSelectField | SettingsFormFieldGroup` — i.e. the same shapes as form fields plus
optional `onValidate?: (event, context) => void | string` and `scope`.

Secret field definition (must be a **string** field with `isSecret: true` and **app scope** —
the runtime throws `only app settings can be secrets` otherwise):

```ts
import { Devvit, SettingScope } from '@devvit/public-api';

Devvit.addSettings([
  {
    type: 'string',
    name: 'pb-email',
    label: 'PocketBase superuser email',
    scope: SettingScope.App,   // enum: App = 'app', Installation = 'installation'
    isSecret: true,
  },
  {
    type: 'string',
    name: 'pb-password',
    label: 'PocketBase superuser password',
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: 'string',
    name: 'pb-base-url',
    label: 'PocketBase base URL (https://...)',
    scope: SettingScope.App,   // not secret, but developer-owned → app scope
  },
]);
```

Values are set via CLI (`devvit settings set pb-email`, etc.) — never hardcode secrets in
`addSettings`; the call only *declares* the fields.

Reading them in any handler via the SettingsClient
(`node_modules/@devvit/settings/SettingsClient.d.ts`):

```ts
export declare class SettingsClient {
    get<T = string | number | boolean | string[] | undefined>(name: string): Promise<T | undefined>;
    getAll<T extends object = SettingsValues>(): Promise<T>;
}
```

```ts
onPress: async (event, context) => {
  const baseUrl = await context.settings.get<string>('pb-base-url');
  const email = await context.settings.get<string>('pb-email');
  const password = await context.settings.get<string>('pb-password');
  if (!baseUrl || !email || !password) {
    context.ui.showToast('PocketBase settings are not configured');
    return;
  }
  const token = await pbLogin(fetch, baseUrl, email, password);
}
```

---

## Misc context facts (BaseContext, `types/context.d.ts`)

- `context.subredditId: string`, `context.subredditName?: string`
- `context.userId?: string` — id (t2_) of the logged-in user who triggered the event (the mod
  pressing the menu item, not the post author)
- `context.username?: string` — that user's handle
- `context.postId?: string`, `context.commentId?: string`
- `context.reddit` / `context.settings` / `context.ui` / `context.redis` / `context.scheduler`

## devvit.yaml

Only `name` is required (`node_modules/@devvit/shared-types/schemas/config-file.v1.json`,
`"required": ["name"]`). Permissions shown in `AppPermissionConfigJson` are written back into
the manifest by the CLI from `Devvit.configure()` at upload time, so the local file can stay
minimal. See `devvit.yaml` in the repo root.
