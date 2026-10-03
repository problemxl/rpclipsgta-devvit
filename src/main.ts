/**
 * r/RPClipsGTA moderator-actions Devvit app.
 *
 * A mod can press "Escalate" on a post or comment, or explicitly create a
 * clip fixture from a source post for the development/QA subreddits. Fixture
 * creation makes a normal link post with the original Twitch/Kick URL; it is
 * moderator-initiated and never creates a comment or crosspost.
 *
 * Escalations are executed entirely in the app: the ladder and decay policy
 * are pure code, action history is in installation Redis, and Reddit receives
 * the warning comment or ban directly.
 */

import { Devvit } from '@devvit/public-api';

import {
  applyManualRuleRemovalSafely,
  buildRemovalFailureToast,
  buildRemovalSuccessToast,
  runModRemovalSafely,
  type ModRemovalSafeOutcome,
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
import { actionForRule } from './lib/detection.js';
import { ruleByNumber, RULES } from './lib/rules.js';
import { createHistoryStore } from './lib/history.js';
import { punish, type PunishDeps, type PunishResult } from './actions/punish.js';
import type { EscalateFn, EscalatePayload, EscalateResult } from './actions/autoescalate.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
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

      const result = await punish(
        createPunishDeps(context),
        {
          targetUser: target.authorName,
          targetThingId: target.thingId,
          // The resolved target's subreddit; never a context fallback that
          // could diverge from where the comment/ban is applied.
          subredditName: target.subredditName || context.subredditName || '',
          rule: rule.number,
          reason,
          modUser: modUsername,
        }
      );
      console.log(
        `[escalate] app executed ${result.label} on u/${target.authorName} ` +
          `(priors: ${result.priors}, recorded: ${result.recorded})`
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
      const outcome = await applyManualRuleRemovalSafely(
        {
          postId: post.id,
          authorName: post.authorName,
          modUser,
          subredditName: post.subredditName,
        },
        rule,
        typeof event.values.reason === 'string' ? event.values.reason : '',
        createModRemovalDeps(context)
      );
      showRemovalOutcome(context, outcome);
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
    // No subreddit guard: this moderator action intentionally matches Escalate.
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
      const outcome = await runModRemovalSafely(
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
      );
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

function createEscalateFn(context: Devvit.Context): EscalateFn {
  const punishDeps = createPunishDeps(context);
  return async (payload: EscalatePayload): Promise<EscalateResult> => {
    const result: PunishResult = await punish(punishDeps, {
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

export default Devvit;
