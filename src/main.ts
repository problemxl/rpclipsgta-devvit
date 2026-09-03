/**
 * r/RPClipsGTA one-button auto-escalating warn/ban Devvit app.
 *
 * A mod presses "Escalate" on a post or comment, picks one of the 12 rules
 * (plus an optional reason), and the app:
 *  1. counts the target author's prior mod actions in PocketBase,
 *  2. picks the escalation ladder step (0 priors → warning, 1/2/3 → 3/7/30
 *     day bans, 4+ → permanent ban),
 *  3. executes it (warning comment reply vs. ban + notification PM),
 *  4. records the action back into PocketBase (`mod_actions`).
 *
 * Failure handling:
 * - If the execution (comment/ban/PM or the PocketBase lookup) fails, the
 *   mod is notified via toast + PM and NOTHING is recorded.
 * - If the execution succeeded but the PocketBase write failed, the mod is
 *   notified via toast + PM that the action is applied but unrecorded, so
 *   they can backfill the record (otherwise the ladder under-counts).
 */

import { Devvit, SettingScope } from '@devvit/public-api';

import {
  buildBanParams,
  buildModActionFields,
  buildWarningCommentText,
  resolveTargetIdFromContext,
  targetFromComment,
  targetFromPost,
} from './actions/escalate.js';
import { escalate } from './lib/escalation.js';
import { countModActions, createModAction, pbLogin } from './lib/pocketbase.js';
import { ruleByNumber, RULES } from './lib/rules.js';

// =============================================================================
// ⚠️⚠️⚠️  EDIT ME BEFORE UPLOAD  ⚠️⚠️⚠️
//
// PB_HOST must be the PUBLIC hostname of the PocketBase server.
//
// Devvit apps execute on Reddit's servers: `localhost` / LAN / 127.0.0.1
// addresses are unreachable from there. Additionally, fetch domains are
// STATIC — they are baked into the app bundle at upload time from this
// constant (see API_NOTES.md §a). They cannot be set per-installation via
// app settings, and wildcards are not supported. Changing the PocketBase
// host means editing this constant and RE-UPLOADING the app.
//
// Bare hostname only: no protocol, no port, no path. Example:
//   const PB_HOST = 'pb.example.com';
// =============================================================================
const PB_HOST = 'pb.rpclips.example.com';

Devvit.configure({
  redditAPI: true,
  http: { domains: [PB_HOST] },
});

// PocketBase credentials are app-scoped SECRETS, set via the CLI:
//   devvit settings set pocketbase-url
//   devvit settings set pocketbase-email
//   devvit settings set pocketbase-password
Devvit.addSettings([
  {
    type: 'string',
    name: 'pocketbase-url',
    label: 'PocketBase base URL',
    helpText: `Full https:// URL of the PocketBase server (must use the public host baked into the app: ${PB_HOST}).`,
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: 'string',
    name: 'pocketbase-email',
    label: 'PocketBase superuser email',
    scope: SettingScope.App,
    isSecret: true,
  },
  {
    type: 'string',
    name: 'pocketbase-password',
    label: 'PocketBase superuser password',
    scope: SettingScope.App,
    isSecret: true,
  },
]);

const escalateForm = Devvit.createForm(
  {
    title: 'Escalate',
    description:
      'Automatically warns or bans the author based on how many mod actions they ' +
      'already have on record: 0 priors → warning, then 3 / 7 / 30 day bans, then permanent.',
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
        helpText: 'Included in the warning comment / ban message and the mod action record.',
      },
    ],
  },
  // Thin handler: all logic lives in runEscalation below.
  async (event, context) => {
    await runEscalation(event.values, context);
  }
);

Devvit.addMenuItem({
  label: 'Escalate',
  description: 'Warn or ban the author per the escalation ladder',
  location: ['post', 'comment'],
  forUserType: 'moderator',
  onPress: (event, context) => {
    // The `showForm(formKey, data)` payload is NOT readable in onSubmit in
    // 0.14.2 — it is passed along for forward-compat only. The submit handler
    // re-derives the target from the context ids instead.
    context.ui.showForm(escalateForm, { targetId: event.targetId });
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
    // Swallow: the more important PM paths below have their own reporting.
  }
}

/** Trim whitespace and trailing slashes so `${baseUrl}/api/...` never doubles up. */
function normalizeBaseUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : undefined;
}

/** Host comparison lenient about a leading `www.`, like configure() is. */
function isAllowedPbHost(baseUrl: string): boolean {
  const host = new URL(baseUrl).host.replace(/^www\./, '');
  return host === PB_HOST;
}

/**
 * The whole escalate flow for one form submission. Throws are caught inside;
 * the mod is always informed of the outcome.
 */
async function runEscalation(
  values: { rule?: string[]; reason?: string },
  context: Devvit.Context
): Promise<void> {
  // -- Form input -----------------------------------------------------------
  const rule = ruleByNumber(Number(values.rule?.[0])); // select values are string[]
  if (!rule) {
    safeToast(context, 'No rule selected — action aborted.');
    return;
  }
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';

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
    // -- Resolve the target thing (comment vs post) --------------------------
    const target = targetId.startsWith('t1_')
      ? targetFromComment(await context.reddit.getCommentById(targetId))
      : targetFromPost(await context.reddit.getPostById(targetId));

    // -- PocketBase: credentials + prior count -------------------------------
    const baseUrl = normalizeBaseUrl(await context.settings.get<string>('pocketbase-url'));
    const email = await context.settings.get<string>('pocketbase-email');
    const password = await context.settings.get<string>('pocketbase-password');
    if (!baseUrl || !email || !password) {
      safeToast(
        context,
        'PocketBase settings are not configured ' +
          '(devvit settings set pocketbase-url / pocketbase-email / pocketbase-password). Action aborted.'
      );
      return;
    }
    let pbUrl: URL;
    try {
      pbUrl = new URL(baseUrl);
    } catch {
      safeToast(context, `"${baseUrl}" is not a valid https:// URL — fix the pocketbase-url setting. Action aborted.`);
      return;
    }
    if (pbUrl.protocol !== 'https:' || !isAllowedPbHost(baseUrl)) {
      safeToast(
        context,
        `PocketBase host must be https://${PB_HOST} (the domain baked into this app) — ` +
          'otherwise the fetch is blocked. Fix the pocketbase-url setting. Action aborted.'
      );
      return;
    }

    const token = await pbLogin(fetch, baseUrl, email, password);
    const priors = await countModActions(fetch, baseUrl, token, target.authorName);
    const step = escalate(priors);

    // -- Execute the ladder step ---------------------------------------------
    if (step.action === 'warn') {
      // Warns are a COMMENT REPLY on the target thing, NOT a private message.
      const warning = await context.reddit.submitComment({
        id: target.thingId,
        text: buildWarningCommentText({
          rule,
          reason: reason || undefined,
          kind: target.kind,
          authorName: target.authorName,
        }),
        runAs: 'APP',
      });
      try {
        // 0.14.2 exposes Comment.distinguish(makeSticky?) — distinguish as a
        // mod (not sticky). If the app account lacks mod rights or the API
        // hiccups, log it and continue: the warning text stands on its own.
        await warning.distinguish();
      } catch (err) {
        console.warn(`[escalate] could not distinguish warning comment ${warning.id}: ${err}`);
      }
    } else {
      // Bans: duration per ladder (key omitted entirely when permanent),
      // notification `message` PM to the banned user, modlog `note`.
      await context.reddit.banUser(buildBanParams({ step, rule, target, priors, reason }));
      // One-line summary PM to the acting mod: ban confirmations are worth a
      // durable record, toasts are ephemeral.
      await context.reddit
        .sendPrivateMessage({
          to: modUsername,
          subject: `[escalate] ${step.label} applied to u/${target.authorName}`,
          text:
            `${step.label} applied to u/${target.authorName} — R${rule.number} ${rule.name}` +
            `${reason ? ` — ${reason}` : ''} (priors: ${priors}). Target: ${target.thingId}.`,
        })
        .catch(() => undefined); // best-effort; toast below still fires
    }

    // -- Record the action in PocketBase --------------------------------------
    const fields = buildModActionFields({ step, rule, target, modUsername, reason });
    try {
      await createModAction(fetch, baseUrl, token, fields);
    } catch (err) {
      // Execution succeeded but the write failed: the ladder will UNDER-COUNT
      // this user until the record is backfilled. Tell the acting mod.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[escalate] PocketBase write failed after ${step.label}: ${detail}`);
      safeToast(context, `${step.label} applied, but the PocketBase write FAILED — action NOT recorded. ${detail}`);
      await context.reddit
        .sendPrivateMessage({
          to: modUsername,
          subject: `[escalate] ACTION NOT RECORDED: ${step.label} on u/${target.authorName}`,
          text:
            `The ${step.label} on u/${target.authorName} (${target.thingId}) was applied on Reddit, ` +
            `but writing the mod_actions record to PocketBase failed:\n\n${detail}\n\n` +
            'Create the record manually, otherwise the escalation ladder will under-count this user.',
        })
        .catch(() => undefined); // best-effort
      return;
    }

    safeToast(context, `${step.label} applied to u/${target.authorName} (priors: ${priors}) and recorded.`);
  } catch (err) {
    // Execution itself failed (target resolution, submission/ban, PB
    // lookup): surface it and record NOTHING.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[escalate] action failed: ${detail}`);
    safeToast(context, `Escalation failed — nothing was executed or recorded. ${detail}`);
    if (modUsername) {
      await context.reddit
        .sendPrivateMessage({
          to: modUsername,
          subject: '[escalate] action failed',
          text:
            `The escalation on ${targetId} failed before anything was executed or recorded:\n\n${detail}`,
        })
        .catch(() => undefined); // best-effort
    }
  }
}

export default Devvit;
