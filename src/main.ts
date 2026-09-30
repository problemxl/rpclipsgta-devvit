/**
 * r/RPClipsGTA moderator-actions Devvit app.
 *
 * A mod can press "Escalate" on a post or comment, or explicitly create a
 * clip fixture from a source post for the development/QA subreddits. Fixture
 * creation makes a normal link post with the original Twitch/Kick URL; it is
 * never automatic and never creates a comment or crosspost.
 *
 * Failure handling is deliberately minimal: failures surface as a short
 * error toast only. No PM fallbacks — the service handles user notification
 * and its own recording fallbacks (see README).
 */

import { Devvit, SettingScope } from '@devvit/public-api';

import {
  buildFailureToast,
  buildSuccessToast,
  resolveTargetIdFromContext,
  targetFromComment,
  targetFromPost,
} from './actions/escalate.js';
import {
  createFixture,
  FIXTURE_SOURCE_SUBREDDIT,
  FIXTURE_TARGETS,
  fixtureTargetFromSelection,
  isAllowedFixtureSourceSubreddit,
  isAuthorizedFixtureActor,
  type FixturePost,
} from './actions/fixture.js';
import { ruleByNumber, RULES } from './lib/rules.js';
import { callEscalate, type EscalatePayload } from './lib/service.js';

// =============================================================================
// ⚠️⚠️⚠️  EDIT ME BEFORE UPLOAD  ⚠️⚠️⚠️
//
// SERVICE_BASE_URL must be the PUBLIC base URL of the Python escalation
// service (e.g. your Coolify deployment) — `https://` protocol, no path.
// The app POSTs to `${SERVICE_BASE_URL}/devvit/escalate`.
//
// Devvit apps execute on Reddit's servers: `localhost` / LAN / 127.0.0.1
// addresses are unreachable from there. Additionally, fetch domains are
// STATIC — the host is baked into the app bundle at upload time from this
// constant (see API_NOTES.md §a). It cannot be set per-installation via app
// settings, and wildcards are not supported. Changing the service host means
// editing this constant and RE-UPLOADING the app.
//
// Example:
//   const SERVICE_BASE_URL = 'https://escalate.example.com';
// =============================================================================
const SERVICE_BASE_URL = 'https://escalate.rpclips.example.com';

// The allowlist takes bare hostnames only (no protocol/port/path) and is
// registered at upload time — derive it here, at module top, per the
// platform's static-domain requirement (API_NOTES.md §a).
const SERVICE_HOST = new URL(SERVICE_BASE_URL).host;

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: { domains: [SERVICE_HOST] },
});

// The shared service token and its URL are app-scoped SECRETS, set via the CLI:
//   devvit settings set escalate-token
//   devvit settings set service-url
// The token must match ESCALATE_TOKEN on the Python service.
Devvit.addSettings([
  {
    type: 'string',
    name: 'escalate-token',
    label: 'Escalation service token (ESCALATE_TOKEN)',
    helpText: 'Shared secret sent as X-Escalate-Token; must match the Python service.',
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: 'string',
    name: 'service-url',
    label: 'Escalation service base URL',
    helpText: `Full https:// URL of the Python service (must use the host baked into this app: ${SERVICE_HOST}).`,
    scope: SettingScope.App,
    isSecret: true,
  },
]);

const escalateForm = Devvit.createForm(
  {
    title: 'Escalate',
    description:
      'The escalation service decides the punishment automatically based on how many ' +
      'prior mod actions the author already has: a warning first, then escalating bans.',
    acceptLabel: 'Apply',
    fields: [
      {
        type: 'select',
        name: 'rule',
        label: 'Rule broken',
        required: true,
        options: RULES.map((rule) => ({
          label: `R${rule.number} — ${rule.name}`,
          value: String(rule.number),
        })),
      },
      {
        type: 'string',
        name: 'reason',
        label: 'Reason (optional)',
        helpText: 'Forwarded to the service and included in the warning / ban message.',
      },
    ],
  },
  // Thin handler: all real logic lives on the Python service.
  async (event, context) => {
    // -- Form input -----------------------------------------------------------
    const rule = ruleByNumber(Number(event.values.rule?.[0])); // select values are string[]
    if (!rule) {
      safeToast(context, 'No rule selected — action aborted.');
      return;
    }
    const reason = typeof event.values.reason === 'string' ? event.values.reason.trim() : '';

    // -- Target & actor -------------------------------------------------------
    // showForm pass-through data is not delivered on the submit event in
    // 0.14.2, so re-derive the target from the context ids (comment wins over
    // post — on a comment menu press both may be set).
    const targetId = resolveTargetIdFromContext(context.commentId, context.postId);
    const modUsername = context.username;
    if (!targetId || !modUsername) {
      safeToast(
        context,
        !targetId
          ? 'Could not determine the target post/comment — action aborted.'
          : 'Could not determine the acting moderator — action aborted.'
      );
      return;
    }

    // -- Settings ---------------------------------------------------------------
    const [token, rawServiceUrl] = await Promise.all([
      context.settings.get<string>('escalate-token'),
      context.settings.get<string>('service-url'),
    ]);
    const serviceUrl = normalizeBaseUrl(rawServiceUrl);
    if (!token || !serviceUrl) {
      safeToast(
        context,
        'Service settings are not configured ' +
          '(devvit settings set escalate-token / service-url). Action aborted.'
      );
      return;
    }
    if (!isAllowedServiceHost(serviceUrl)) {
      // Fetches to other hosts are blocked by the platform anyway — fail with
      // a clear message instead of an opaque plugin error.
      safeToast(
        context,
        `The service-url setting must use the host baked into this app (${SERVICE_HOST}) — ` +
          'otherwise the fetch is blocked. Action aborted.'
      );
      return;
    }

    try {
      // -- Resolve the target thing (comment vs post) -------------------------
      const target = targetId.startsWith('t1_')
        ? targetFromComment(await context.reddit.getCommentById(targetId))
        : targetFromPost(await context.reddit.getPostById(targetId));

      // -- Hand off to the service --------------------------------------------
      const payload: EscalatePayload = {
        target_user: target.authorName,
        target_id: target.thingId,
        rule: rule.number,
        reason,
        mod_user: modUsername,
      };
      const result = await callEscalate(fetch, serviceUrl, token, payload);
      console.log(
        `[escalate] service executed ${result.label} on u/${target.authorName} ` +
          `(priors: ${result.priors}, recorded: ${result.recorded})`
      );
      safeToast(context, buildSuccessToast({ result, targetUser: target.authorName, rule }));
    } catch (err) {
      // No PM fallback: the service handles user notification and its own
      // recording fallbacks. The mod gets a short toast; details are logged.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[escalate] action failed: ${detail}`);
      safeToast(context, buildFailureToast(detail));
    }
  }
);

Devvit.addMenuItem({
  label: 'Escalate',
  description: 'Warn or ban the author per the escalation ladder',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: (event, context) => {
    // The `showForm(formKey, data)` payload is NOT readable in onSubmit in
    // 0.14.2 — the submit handler re-derives the target from the context ids.
    context.ui.showForm(escalateForm, { targetId: event.targetId });
  },
});

const fixtureForm = Devvit.createForm(
  {
    title: 'Create clip fixture',
    description:
      'Creates one ordinary link post in a non-production test subreddit. ' +
      'The source Twitch/Kick URL is preserved for detector testing.',
    acceptLabel: 'Create fixture',
    fields: [
      {
        type: 'select',
        name: 'target',
        label: 'Target subreddit',
        required: true,
        options: FIXTURE_TARGETS.map((target) => ({
          label: target.label,
          value: target.key,
        })),
      },
    ],
  },
  async (event, context) => {
    const target = fixtureTargetFromSelection(event.values.target);
    if (!target) {
      safeToast(context, 'Choose exactly Development or QA/staging.');
      return;
    }

    const sourceId = context.postId;
    if (!sourceId) {
      safeToast(context, 'Could not determine the source post. Action aborted.');
      return;
    }

    const actor = context.username?.trim();
    if (!actor) {
      safeToast(context, 'Could not determine the acting moderator. Action aborted.');
      return;
    }

    try {
      const source = await context.reddit.getPostById(sourceId);
      if (!isAllowedFixtureSourceSubreddit(source.subredditName)) {
        safeToast(
          context,
          `Fixtures may only be created from r/${FIXTURE_SOURCE_SUBREDDIT}.`
        );
        return;
      }
      const authorized = await isAuthorizedFixtureActor(
        context.reddit,
        source.subredditName,
        actor
      );
      if (!authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }

      const fixture = await createFixture({
        source: {
          id: source.id,
          title: source.title,
          url: source.url,
          permalink: source.permalink,
        },
        target,
        actor,
        reddit: {
          submitPost: async (options: FixturePost) => {
            const created = await context.reddit.submitPost(options);
            return { id: created.id, permalink: created.permalink };
          },
        },
        // Global app Redis makes the source+target claim stable across app
        // installations while NX prevents two simultaneous presses racing.
        dedupe: context.redis.global,
      });

      const destination = fixture.record?.fixturePermalink;
      safeToast(
        context,
        fixture.created
          ? `Created ${target.label} fixture for ${source.id}${
              destination ? `: ${destination}` : '.'
            }`
          : `A ${target.label} fixture is already claimed for ${source.id}.`
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(
        `[fixture] action failed for ${sourceId}/${target.key}: ${detail}`
      );
      safeToast(context, 'Fixture creation failed. Check the app logs for details.');
    }
  }
);

Devvit.addMenuItem({
  label: 'Create clip fixture',
  description: 'Copy this clip URL to the development or QA subreddit for testing',
  location: 'post',
  forUserType: 'moderator',
  onPress: (event, context) => {
    // The menu is moderator-only; the source id is re-derived from the form
    // submit context because showForm pass-through data is opaque in 0.14.2.
    context.ui.showForm(fixtureForm, { sourceId: event.targetId });
  },
});

/**
 * Best-effort toast: UI hiccups must never mask the real outcome.
 * (Toasts ARE available on form submits in 0.14.2, so this is the primary
 * confirmation channel — see README.)
 */
function safeToast(context: Devvit.Context, text: string): void {
  try {
    context.ui.showToast(text);
  } catch {
    // Swallow: a failed toast must not throw over the handler's result.
  }
}

/** Trim whitespace and trailing slashes so `${baseUrl}/devvit/...` never doubles up. */
function normalizeBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

/** Host comparison lenient about a leading `www.`, like configure() is. */
function isAllowedServiceHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).host.replace(/^www\./, '');
    return host === SERVICE_HOST;
  } catch {
    return false;
  }
}

export default Devvit;
