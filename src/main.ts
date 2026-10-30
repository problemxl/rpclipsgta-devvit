/**
 * r/RPClipsGTA moderator-actions Devvit app.
 *
 * A mod can press "Escalate" on a post or comment, or explicitly create a
 * clip fixture from a source post for the development/QA subreddits. Fixture
 * creation makes a normal link post with the original Twitch/Kick URL; it is
 * moderator-initiated and never creates a comment or crosspost.
 *
 * A "Seed test history" subreddit menu action (moderators only) seeds or
 * resets a user's action history to exercise the ladder in the dev/QA
 * subreddits; the allowlist guard inside seedHistory makes it a no-op
 * everywhere else.
 *
 * Escalations are executed entirely in the app: the ladder and decay policy
 * are pure code, action history is in installation Redis, and Reddit receives
 * the warning comment or ban directly.
 */

import { Devvit, SettingScope } from '@devvit/public-api';

import {
  applyManualRuleRemovalSafely,
  buildRemoveEscalateAlreadyProcessedToast,
  buildRemoveEscalateFailureToast,
  buildRemoveEscalateSuccessToast,
  buildRemovalFailureToast,
  buildRemovalSuccessToast,
  runModRemovalSafely,
  runRemoveAndEscalateSafely,
  type ModRemovalSafeOutcome,
  type RemoveEscalateDeps,
  type RemoveEscalateSafeOutcome,
} from './actions/autoescalate.js';
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
import {
  buildSeedToast,
  parseSeedOperation,
  runSeedSafely,
  type SeedInput,
} from './actions/seed.js';
import {
  buildReconcilePendingToast,
  parsePendingResolution,
  runReconcilePendingSafely,
  type ReconcilePendingInput,
} from './actions/reconcile-pending.js';
import { actionForRule } from './lib/detection.js';
import { runAuthorizedModeratorAction } from './actions/moderator-boundary.js';
import { ruleByNumber, RULES, type Rule } from './lib/rules.js';
import { createHistoryStore } from './lib/history.js';
import {
  punish,
  type PunishDeps,
  type PunishInput,
  type PunishResult,
} from './actions/punish.js';
import type { EscalateFn, EscalatePayload, EscalateResult } from './actions/autoescalate.js';
import {
  DEFAULT_WIDGET_SHORT_NAME,
  TWITCH_CLIENT_ID_SETTING,
  TWITCH_CLIENT_SECRET_SETTING,
  TWITCH_LANGUAGE_SETTING,
  WIDGET_SHORT_NAME_SETTING,
  runSidebarRefresh,
} from './actions/sidebar-refresh.js';
import type { TwitchToken } from './lib/twitch.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
  http: true,
});

const SIDEBAR_REFRESH_JOB = 'refresh-sidebar';
const SIDEBAR_REFRESH_CRON = '*/10 * * * *';
const TWITCH_TOKEN_CACHE_KEY = 'sidebar-refresh:twitch-oauth-token';

Devvit.addSettings([
  {
    type: 'string',
    name: TWITCH_CLIENT_ID_SETTING,
    label: 'Twitch client ID',
    helpText: 'App-level Twitch Helix client ID. Set with the Devvit CLI.',
    scope: SettingScope.App,
  },
  {
    type: 'string',
    name: TWITCH_CLIENT_SECRET_SETTING,
    label: 'Twitch client secret',
    helpText: 'App-level Twitch Helix client secret. Set with the Devvit CLI.',
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: 'group',
    label: 'Top streamers sidebar',
    helpText: 'Settings for the installation subreddit sidebar widget.',
    fields: [
      {
        type: 'string',
        name: WIDGET_SHORT_NAME_SETTING,
        label: 'Sidebar widget short name',
        helpText: `Defaults to "${DEFAULT_WIDGET_SHORT_NAME}".`,
        scope: SettingScope.Installation,
        defaultValue: DEFAULT_WIDGET_SHORT_NAME,
      },
      {
        type: 'string',
        name: TWITCH_LANGUAGE_SETTING,
        label: 'Twitch language filter (optional)',
        helpText: 'Use a language code such as en, or leave blank for all languages.',
        scope: SettingScope.Installation,
        defaultValue: '',
      },
    ],
  },
]);

Devvit.addSchedulerJob({
  name: SIDEBAR_REFRESH_JOB,
  onRun: async (_event, context) => {
    try {
      const subredditName = await resolveSubredditName(context);
      const outcome = await runSidebarRefresh(
        createSidebarRefreshDeps(context),
        { subredditName }
      );
      if (outcome.status === 'config-missing') {
        console.error(
          `[sidebar-refresh] missing Twitch settings: ${outcome.missing.join(', ')}`
        );
        return;
      }
      console.log(
        `[sidebar-refresh] ${outcome.status} ${outcome.widgetShortName} (${outcome.streamCount} streams)`
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[sidebar-refresh] scheduled refresh failed: ${detail}`);
    }
  },
});

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    try {
      await scheduleSidebarRefresh(context.scheduler, false);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[sidebar-refresh] install scheduling failed: ${detail}`);
    }
  },
});

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (_event, context) => {
    try {
      await scheduleSidebarRefresh(context.scheduler, true);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[sidebar-refresh] upgrade scheduling failed: ${detail}`);
    }
  },
});

async function scheduleSidebarRefresh(
  scheduler: Devvit.Context['scheduler'],
  replace: boolean
): Promise<void> {
  const existing = (await scheduler.listJobs()).filter(
    (job) => job.name === SIDEBAR_REFRESH_JOB
  );
  if (replace) {
    await Promise.all(existing.map((job) => scheduler.cancelJob(job.id)));
  } else if (existing.length > 0) {
    console.log(`[sidebar-refresh] cron already scheduled (${existing[0].id})`);
    return;
  }
  const id = await scheduler.runJob({
    name: SIDEBAR_REFRESH_JOB,
    cron: SIDEBAR_REFRESH_CRON,
  });
  console.log(`[sidebar-refresh] scheduled cron job ${id}`);
}

async function resolveSubredditName(
  context: Pick<Devvit.Context, 'subredditId' | 'subredditName' | 'reddit'>
): Promise<string> {
  const configured = context.subredditName?.trim();
  if (configured) return configured;
  const subreddit = await context.reddit.getSubredditById(
    context.subredditId as `t5_${string}`
  );
  const name = subreddit?.name?.trim();
  if (!name) throw new Error(`could not resolve subreddit ${context.subredditId}`);
  return name;
}

function fetchAllowedTwitchUrl(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
): Promise<Response> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('blocked invalid Twitch fetch URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    (url.hostname !== 'id.twitch.tv' && url.hostname !== 'api.twitch.tv')
  ) {
    throw new Error(`blocked Twitch fetch URL: ${url.origin}`);
  }
  return globalThis.fetch(input, init);
}

function createSidebarRefreshDeps(
  context: Pick<Devvit.Context, 'settings' | 'redis' | 'reddit'>
) {
  return {
    settings: context.settings,
    fetch: fetchAllowedTwitchUrl,
    getToken: () => context.redis.get(TWITCH_TOKEN_CACHE_KEY),
    setToken: async (token: TwitchToken) => {
      await context.redis.set(TWITCH_TOKEN_CACHE_KEY, token.access_token, {
        expiration: new Date(Date.now() + (token.expires_in - 300) * 1000),
      });
    },
    clearToken: () => context.redis.del(TWITCH_TOKEN_CACHE_KEY),
    getWidgets: (subredditName: string) => context.reddit.getWidgets(subredditName),
    addWidget: (widget: {
      type: 'textarea';
      subreddit: string;
      shortName: string;
      text: string;
    }) => context.reddit.addWidget(widget),
    updateWidget: (widget: {
      type: 'textarea';
      subreddit: string;
      id: string;
      shortName: string;
      text: string;
    }) => context.reddit.updateWidget(widget),
  };
}

Devvit.addMenuItem({
  label: 'Refresh top streamers now',
  description: 'Update the Twitch GTA RP sidebar widget immediately',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const subredditName = context.subredditName?.trim();
    const actor = context.username?.trim();
    if (!subredditName || !actor) {
      safeToast(context, 'Could not determine the subreddit or acting moderator. Action aborted.');
      return;
    }
    try {
      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        subredditName,
        actor,
        () => runSidebarRefresh(createSidebarRefreshDeps(context), { subredditName })
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      const outcome = authorized.result;
      if (outcome.status === 'config-missing') {
        safeToast(context, 'Twitch credentials are not configured. Check app settings.');
        console.error(
          `[sidebar-refresh] manual refresh missing settings: ${outcome.missing.join(', ')}`
        );
        return;
      }
      safeToast(context, `Top streamers sidebar ${outcome.status}.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[sidebar-refresh] manual refresh failed: ${detail}`);
      safeToast(context, 'Top streamers refresh failed. Check the app logs for details.');
    }
  },
});

const escalateForm = Devvit.createForm(
  {
    title: 'Escalate',
    description:
      'The in-app ladder applies a warning first, then escalating bans based on prior ' +
      'actions, with three-month decay between punishments.',
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
        helpText: 'Included in the warning / ban message.'
      },
    ],
  },
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

    try {
      // -- Resolve the target thing (comment vs post) -------------------------
      const target = targetId.startsWith('t1_')
        ? targetFromComment(await context.reddit.getCommentById(targetId))
        : targetFromPost(await context.reddit.getPostById(targetId));

      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        target.subredditName,
        modUsername,
        () => punish(
          createPunishDeps(context),
          {
            targetUser: target.authorName,
            targetThingId: target.thingId,
            // The resolved target's subreddit; never a context fallback that
            // could diverge from where the comment/ban is applied.
            subredditName: target.subredditName,
            rule: rule.number,
            reason,
            modUser: modUsername,
          }
        )
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      const result = authorized.result;
      console.log(
        `[escalate] app executed ${result.label} on u/${target.authorName} ` +
          `(priors: ${result.priors}, recorded: ${result.recorded}, finalized:${result.finalized})`
      );
      safeToast(context, buildSuccessToast({ result, targetUser: target.authorName, rule }));
    } catch (err) {
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
  onPress: async (event, context) => {
    // Resolve and authorize at menu invocation before the form is offered;
    // submission performs the same live check again.
    const targetId = resolveTargetIdFromContext(context.commentId, context.postId) ?? event.targetId;
    const modUser = context.username?.trim();
    if (!targetId || !modUser) {
      safeToast(context, 'Could not determine the acting moderator or target. Action aborted.');
      return;
    }
    try {
      const target = targetId.startsWith('t1_')
        ? targetFromComment(await context.reddit.getCommentById(targetId))
        : targetFromPost(await context.reddit.getPostById(targetId));
      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        target.subredditName,
        modUser,
        async () => undefined
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      context.ui.showForm(escalateForm, { targetId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[escalate] menu authorization failed: ${detail}`);
      safeToast(context, 'Moderator access could not be verified. Action aborted.');
    }
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

const removePostForm = Devvit.createForm(
  {
    title: 'Remove post',
    description:
      'Choose a rule when automatic detection found nothing. The selected rule is removed and escalated according to policy.',
    acceptLabel: 'Remove post',
    fields: [
      {
        type: 'select',
        name: 'rule',
        label: 'Rule broken',
        required: true,
        options: RULES.map((rule) => ({
          label: `R${rule.number} — ${rule.name} (${actionForRule(rule.number) === 'remove-and-escalate' ? 'remove + escalate' : 'remove only'})`,
          value: String(rule.number),
        })),
      },
      {
        type: 'string',
        name: 'reason',
        label: 'Reason (optional)',
        helpText: 'Included in the warning / ban message when this rule escalates.',
      },
    ],
  },
  async (event, context) => {
    const rule = Number(event.values.rule?.[0]);
    if (!Number.isInteger(rule) || !ruleByNumber(rule)) {
      safeToast(context, 'No valid rule selected — action aborted.');
      return;
    }
    const postId = context.postId;
    const modUser = context.username?.trim();
    if (!postId || !modUser) {
      safeToast(
        context,
        !postId
          ? 'Could not determine the target post — action aborted.'
          : 'Could not determine the acting moderator — action aborted.'
      );
      return;
    }

    try {
      const post = await context.reddit.getPostById(postId);
      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        post.subredditName,
        modUser,
        () => applyManualRuleRemovalSafely(
          {
            postId: post.id,
            authorName: post.authorName,
            modUser,
            subredditName: post.subredditName,
          },
          rule,
          typeof event.values.reason === 'string' ? event.values.reason : '',
          createModRemovalDeps(context)
        )
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      showRemovalOutcome(context, authorized.result);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[mod-remove] form failed: ${detail}`);
      safeToast(context, `Remove post failed: ${detail}`);
    }
  }
);

Devvit.addMenuItem({
  label: 'Remove post',
  description: 'Auto-detect R4/R5/R6/R12 or pick a rule; removes and escalates per policy',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    // Resolve and authorize before the automatic path can claim Redis state or
    // call Reddit. Form submission repeats this check after the form opens.
    const postId = context.postId;
    const modUser = context.username?.trim();
    if (!postId || !modUser) {
      safeToast(
        context,
        !postId
          ? 'Could not determine the target post — action aborted.'
          : 'Could not determine the acting moderator — action aborted.'
      );
      return;
    }

    try {
      const post = await context.reddit.getPostById(postId);
      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        post.subredditName,
        modUser,
        () => runModRemovalSafely(
          {
            postId: post.id,
            authorName: post.authorName,
            title: post.title,
            url: post.url,
            body: post.body ?? '',
            isTextPost: post.body !== undefined,
            modUser,
            subredditName: post.subredditName,
          },
          createModRemovalDeps(context)
        )
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      const outcome = authorized.result;
      if (outcome.status === 'clean') {
        context.ui.showForm(removePostForm, { targetId: post.id });
        return;
      }
      showRemovalOutcome(context, outcome);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[mod-remove] menu failed: ${detail}`);
      safeToast(context, `Remove post failed: ${detail}`);
    }
  },
});

const removeEscalateForm = Devvit.createForm(
  {
    title: 'Remove & escalate',
    description:
      'Removes this post or comment and escalates the author per the ladder — moderator discretion, any rule.',
    acceptLabel: 'Remove & escalate',
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
        helpText: 'Included in the warning / ban message.'
      },
    ],
  },
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

    try {
      // -- Resolve the target thing (comment vs post) -------------------------
      const target = targetId.startsWith('t1_')
        ? targetFromComment(await context.reddit.getCommentById(targetId))
        : targetFromPost(await context.reddit.getPostById(targetId));

      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        target.subredditName,
        modUsername,
        () => runRemoveAndEscalateSafely(
          {
            thingId: target.thingId,
            authorName: target.authorName,
            // The resolved target's subreddit; never a context fallback that
            // could diverge from where the removal and ban are applied.
            subredditName: target.subredditName,
            rule: rule.number,
            reason,
            modUser: modUsername,
          },
          createRemoveEscalateDeps(context)
        )
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      showRemoveEscalateOutcome(context, authorized.result, target.authorName, rule);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[remove-escalate] form failed: ${detail}`);
      safeToast(context, buildRemoveEscalateFailureToast({ status: 'trigger-failed', detail }));
    }
  }
);

Devvit.addMenuItem({
  label: 'Remove & escalate',
  description: 'Remove this post/comment and warn or ban the author per the escalation ladder',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: async (event, context) => {
    // Resolve and authorize at menu invocation before the form is offered;
    // submission performs the same live check again.
    const targetId = resolveTargetIdFromContext(context.commentId, context.postId) ?? event.targetId;
    const modUser = context.username?.trim();
    if (!targetId || !modUser) {
      safeToast(context, 'Could not determine the acting moderator or target. Action aborted.');
      return;
    }
    try {
      const target = targetId.startsWith('t1_')
        ? targetFromComment(await context.reddit.getCommentById(targetId))
        : targetFromPost(await context.reddit.getPostById(targetId));
      const authorized = await runAuthorizedModeratorAction(
        context.reddit,
        target.subredditName,
        modUser,
        async () => undefined
      );
      if (!authorized.authorized) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      context.ui.showForm(removeEscalateForm, { targetId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[remove-escalate] menu authorization failed: ${detail}`);
      safeToast(context, 'Moderator access could not be verified. Action aborted.');
    }
  },
});

Devvit.addMenuItem({
  label: 'Create clip fixture',
  description: 'Copy this clip URL to the development or QA subreddit for testing',
  location: 'post',
  forUserType: 'moderator',
  onPress: async (event, context) => {
    // Resolve the source and verify current membership before opening the
    // form. The form repeats this check because it may be replayed later.
    const sourceId = context.postId ?? event.targetId;
    const actor = context.username?.trim();
    if (!sourceId || !actor) {
      safeToast(context, 'Could not determine the source or acting moderator. Action aborted.');
      return;
    }
    try {
      const source = await context.reddit.getPostById(sourceId);
      if (!isAllowedFixtureSourceSubreddit(source.subredditName)) {
        safeToast(context, `Fixtures may only be created from r/${FIXTURE_SOURCE_SUBREDDIT}.`);
        return;
      }
      if (!(await isAuthorizedFixtureActor(context.reddit, source.subredditName, actor))) {
        safeToast(context, 'Moderator access could not be verified. Action aborted.');
        return;
      }
      context.ui.showForm(fixtureForm, { sourceId });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[fixture] menu authorization failed: ${detail}`);
      safeToast(context, 'Moderator access could not be verified. Action aborted.');
    }
  },
});

const seedForm = Devvit.createForm(
  {
    title: 'Seed test history',
    description: 'Dev/QA only: place a user at a ladder position or reset their history.',
    acceptLabel: 'Apply',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: 'Username',
        required: true,
        helpText: 'No leading u/',
      },
      {
        type: 'select',
        name: 'operation',
        label: 'Operation',
        required: true,
        options: [
          { label: 'Seed priors (history must be empty)', value: 'seed' },
          { label: 'Clear history', value: 'clear' },
        ],
      },
      {
        type: 'number',
        name: 'priors',
        label: 'Priors to seed (1-20)',
        helpText: 'Seed priors only: rows are spaced one day apart.',
      },
      {
        type: 'number',
        name: 'latestAgeDays',
        label: 'Age of newest prior, days (0-3650)',
        helpText: 'Seed priors only: drives the 90-day decay clock.',
      },
    ],
  },
  async (event, context) => {
    // -- Subreddit guard ------------------------------------------------------
    // A subreddit menu press sets context.subredditName; without it the
    // allowlist cannot be evaluated, so the press is reported as a denial.
    // The allowlist itself is enforced (and loudly logged) inside seedHistory.
    const subredditName = context.subredditName?.trim() ?? '';
    if (!subredditName) {
      safeToast(context, buildSeedToast({ status: 'denied' }));
      return;
    }

    // -- Form input -----------------------------------------------------------
    // Number fields arrive as numbers; guard against malformed/NaN replays
    // before calling seedHistory, which re-validates the bounds anyway.
    const priors = numericFormValue(event.values.priors);
    const latestAgeDays = numericFormValue(event.values.latestAgeDays);
    const operation = parseSeedOperation(event.values.operation);
    const actor = context.username?.trim();
    if (!operation) {
      safeToast(context, 'No valid operation selected — action aborted.');
      return;
    }
    if (!actor) {
      safeToast(context, 'Could not determine the acting moderator. Action aborted.');
      return;
    }

    try {
      const seedInput: SeedInput = {
        subredditName,
        actor,
        username: typeof event.values.username === 'string' ? event.values.username : '',
        operation,
        ...(operation === 'seed' && priors !== undefined ? { priors } : {}),
        ...(operation === 'seed' && latestAgeDays !== undefined ? { latestAgeDays } : {}),
      };
      const outcome = await runSeedSafely(
        {
          history: createHistoryStore(context.redis),
          redis: context.redis,
          authorizeActor: async (name, username) =>
            (await context.reddit
              .getModerators({ subredditName: name, username, limit: 1, pageSize: 1 })
              .all()).length > 0,
        },
        seedInput
      );
      safeToast(context, buildSeedToast(outcome));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[seed] form failed: ${detail}`);
      safeToast(context, `Seed test history failed: ${detail}`);
    }
  }
);

Devvit.addMenuItem({
  label: 'Seed test history',
  description: 'Dev/QA testing tool: seed or reset escalation history',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: (_event, context) => {
    context.ui.showForm(seedForm);
  },
});

const reconcilePendingForm = Devvit.createForm(
  {
    title: 'Dev/QA reconcile pending action',
    description:
      'Inspect Reddit moderator log and the target comment/ban first. Unknown outcomes stay pending. ' +
      'This tool never retries Reddit and never unlocks a user.',
    acceptLabel: 'Reconcile',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: 'Target username',
        required: true,
        helpText: 'The username whose exact pending row is shown in the app logs/toast.',
      },
      {
        type: 'string',
        name: 'recordId',
        label: 'Exact pending record id',
        required: true,
      },
      {
        type: 'select',
        name: 'resolution',
        label: 'Resolution',
        required: true,
        options: [
          { label: 'Inspect only', value: 'inspect' },
          { label: 'Reddit definitely applied — mark applied', value: 'applied' },
          { label: 'Reddit definitely did not apply — remove pending row', value: 'not-applied' },
        ],
      },
      {
        type: 'boolean',
        name: 'confirmExternalOutcome',
        label: 'I inspected Reddit and the selected outcome is definite (not unknown)',
      },
    ],
  },
  async (event, context) => {
    const actor = context.username?.trim() ?? '';
    const resolution = parsePendingResolution(event.values.resolution);
    if (!resolution) {
      safeToast(context, 'No valid reconciliation resolution selected — action aborted.');
      return;
    }
    const input: ReconcilePendingInput = {
      subredditName: context.subredditName?.trim() ?? '',
      actor,
      username: typeof event.values.username === 'string' ? event.values.username : '',
      recordId: typeof event.values.recordId === 'string' ? event.values.recordId : '',
      resolution,
      confirmExternalOutcome: event.values.confirmExternalOutcome === true,
    };
    const outcome = await runReconcilePendingSafely(
      {
        history: createHistoryStore(context.redis),
        redis: context.redis,
        authorizeActor: async (name, username) =>
          (await context.reddit
            .getModerators({ subredditName: name, username, limit: 1, pageSize: 1 })
            .all()).length > 0,
      },
      input
    );
    safeToast(context, buildReconcilePendingToast(outcome));
  }
);

Devvit.addMenuItem({
  label: 'Reconcile pending action (dev/QA)',
  description: 'Inspect and resolve one known pending Reddit outcome; never retries or unlocks',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: (_event, context) => {
    context.ui.showForm(reconcilePendingForm);
  },
});

function createPunishDeps(context: Devvit.Context): PunishDeps {
  return {
    history: createHistoryStore(context.redis),
    // The same Redis client serializes punishments per user via the lock in
    // punish().
    redis: context.redis,
    submitComment: async ({ text, replyTargetThingId }) => {
      const comment = await context.reddit.submitComment({
        id: replyTargetThingId as `t1_${string}` | `t3_${string}`,
        text,
        runAs: 'APP',
      });
      return comment.id;
    },
    banUser: async ({ username, subredditName, durationDays, message, reason, note }) => {
      await context.reddit.banUser({
        username,
        subredditName,
        ...(durationDays === undefined ? {} : { duration: durationDays }),
        message,
        reason,
        note,
      });
    },
  };
}

/**
 * One punish call bound to this context's Reddit/Redis wiring, shared by the
 * Escalate path and the Remove & escalate action.
 */
function createPunishFn(context: Devvit.Context): (input: PunishInput) => Promise<PunishResult> {
  const punishDeps = createPunishDeps(context);
  return (input: PunishInput) => punish(punishDeps, input);
}

function createEscalateFn(context: Devvit.Context): EscalateFn {
  const punishFn = createPunishFn(context);
  return async (payload: EscalatePayload): Promise<EscalateResult> => {
    const result: PunishResult = await punishFn({
      targetUser: payload.target_user,
      targetThingId: payload.target_id,
      // The RESOLVED post's subreddit threaded through the removal seam; an
      // empty name makes punish refuse any ban before banUser is called.
      subredditName: payload.subreddit_name,
      rule: payload.rule,
      reason: payload.reason,
      modUser: payload.mod_user,
    });
    return {
      action: result.action,
      duration_days: result.durationDays,
      label: result.label,
      comment_id: result.commentId,
      priors: result.priors,
      rule_name: result.ruleName,
      recorded: result.recorded,
      finalized: result.finalized,
      ...(result.pendingRecordId ? { pending_record_id: result.pendingRecordId } : {}),
    };
  };
}

function createModRemovalDeps(context: Devvit.Context) {
  return {
    redis: context.redis,
    removePost: (thingId: string) =>
      context.reddit.remove(thingId as `t3_${string}`, false),
    escalate: createEscalateFn(context),
  };
}

function createRemoveEscalateDeps(context: Devvit.Context): RemoveEscalateDeps {
  return {
    redis: context.redis,
    // reddit.remove accepts both t1_ comments and t3_ posts.
    removeThing: (thingId: string) =>
      context.reddit.remove(thingId as `t1_${string}` | `t3_${string}`, false),
    punish: createPunishFn(context),
  };
}

function showRemovalOutcome(context: Devvit.Context, outcome: ModRemovalSafeOutcome): void {
  switch (outcome.status) {
    case 'actioned':
      safeToast(
        context,
        buildRemovalSuccessToast(outcome, ruleByNumber(outcome.violation.rule)?.name)
      );
      return;
    case 'already-processed':
      safeToast(context, 'Already processed by this action.');
      return;
    case 'escalate-failed':
    case 'remove-failed':
    case 'failed':
    case 'trigger-failed':
      safeToast(context, buildRemovalFailureToast(outcome));
      return;
    case 'skipped-author':
      safeToast(context, 'Post author is empty or AutoModerator — action skipped.');
      return;
    case 'clean':
      return;
    default: {
      // Exhaustiveness guard: a new outcome status must be handled above.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return;
    }
  }
}

function showRemoveEscalateOutcome(
  context: Devvit.Context,
  outcome: RemoveEscalateSafeOutcome,
  targetUser: string,
  rule: Rule
): void {
  switch (outcome.status) {
    case 'actioned':
      safeToast(
        context,
        buildRemoveEscalateSuccessToast({ result: outcome.punishResult, targetUser, rule })
      );
      return;
    case 'already-processed':
      safeToast(context, buildRemoveEscalateAlreadyProcessedToast());
      return;
    case 'invalid':
    case 'remove-failed':
    case 'escalate-failed':
    case 'failed':
    case 'trigger-failed':
      safeToast(context, buildRemoveEscalateFailureToast(outcome));
      return;
    default: {
      // Exhaustiveness guard: a new outcome status must be handled above.
      const _exhaustive: never = outcome;
      void _exhaustive;
      return;
    }
  }
}

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

/** Pass a form number field through only when it is a usable finite number. */
function numericFormValue(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export default Devvit;
