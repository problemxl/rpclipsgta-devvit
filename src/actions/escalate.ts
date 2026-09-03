/**
 * Pure helpers for the one-button auto-escalating warn/ban flow.
 *
 * Everything in this module is framework-free (no `@devvit/*` imports) so it
 * can be unit-tested with vitest without the Devvit runtime. `src/main.ts`
 * wires these helpers into the mod menu / form handlers and keeps its own
 * code thin.
 */

import type { LadderStep } from '../lib/escalation.js';
import type { ModActionFields } from '../lib/pocketbase.js';
import type { Rule } from '../lib/rules.js';

/** Which kind of thing the mod action targets. */
export type TargetKind = 'post' | 'comment';

/**
 * Minimal structural shape of a resolved Reddit post (`Post` from
 * @devvit/reddit satisfies this; redeclared to keep the module import-free).
 */
export interface PostLike {
  /** Thing id including prefix: `t3_...`. */
  readonly id: string;
  /** Username without the leading `u/`. */
  readonly authorName: string;
  /** Path relative to https://www.reddit.com. */
  readonly permalink: string;
  readonly subredditName: string;
}

/** Minimal structural shape of a resolved Reddit comment. */
export interface CommentLike extends PostLike {
  /** Parent post thing id, `t3_...`. */
  readonly postId: string;
}

/** Fully resolved target of a mod action. */
export interface TargetInfo {
  kind: TargetKind;
  /** Thing id including prefix: `t3_...` for posts, `t1_...` for comments. */
  thingId: string;
  /** Username of the target user, without the leading `u/`. */
  authorName: string;
  permalink: string;
  subredditName: string;
  /**
   * Parent post id (`t3_...`). Same as `thingId` for posts; the comment's
   * `postId` for comments, or `''` if unobtainable.
   */
  parentPostId: string;
}

/** Build a {@link TargetInfo} from a resolved post. */
export function targetFromPost(post: PostLike): TargetInfo {
  return {
    kind: 'post',
    thingId: post.id,
    authorName: post.authorName,
    permalink: post.permalink,
    subredditName: post.subredditName,
    parentPostId: post.id,
  };
}

/** Build a {@link TargetInfo} from a resolved comment. */
export function targetFromComment(comment: CommentLike): TargetInfo {
  return {
    kind: 'comment',
    thingId: comment.id,
    authorName: comment.authorName,
    permalink: comment.permalink,
    subredditName: comment.subredditName,
    parentPostId: comment.postId || '',
  };
}

/**
 * Pick the mod-menu target id out of the submit-time context ids.
 *
 * `showForm(formKey, data)` pass-through data is NOT exposed on the form
 * submit event in @devvit/public-api 0.14.2, so the target is re-derived
 * from `context.commentId` / `context.postId`. A comment id (`t1_...`)
 * takes precedence: when the menu was pressed on a comment, both ids can be
 * set, and the comment is the intended target.
 *
 * @returns the target thing id, or `undefined` if neither id is present.
 */
export function resolveTargetIdFromContext(
  commentId: string | undefined,
  postId: string | undefined
): string | undefined {
  return commentId ?? postId ?? undefined;
}

/** `R<number> — <name>`, the canonical rule label used everywhere. */
export function ruleLabel(rule: Rule): string {
  return `R${rule.number} — ${rule.name}`;
}

/**
 * Build the text of the warning COMMENT submitted as a reply on the target
 * thing (warns are never sent as a private message). Mentions the rule
 * name, the optional reason, and that repeat offenses escalate to bans.
 */
export function buildWarningCommentText(params: {
  rule: Rule;
  reason?: string;
  kind: TargetKind;
  authorName: string;
}): string {
  const { rule, reason, kind, authorName } = params;
  const lines: string[] = [
    `Hi u/${authorName}, this is an automated moderator warning about your ${kind}.`,
    '',
    `It breaks **${ruleLabel(rule)}**.`,
  ];
  if (reason) {
    lines.push('', `Reason: ${reason}`);
  }
  lines.push(
    '',
    'Please review the subreddit rules before posting again. Repeat offenses escalate automatically: further violations lead to temporary bans, then a permanent ban.'
  );
  return lines.join('\n');
}

/**
 * Options for `context.reddit.banUser` (structurally identical to
 * `BanUserOptions` from @devvit/reddit; redeclared so this module stays free
 * of Devvit imports).
 */
export interface BanParams {
  username: string;
  subredditName: string;
  /**
   * Ban length in DAYS. For permanent bans the key is OMITTED entirely —
   * per the typings, `duration?: number` means absence is permanent;
   * `0` is not a documented "permanent" value.
   */
  duration?: number;
  /** Ban notification private message sent to the banned user. */
  message: string;
  /** Private mod-log note: rule, reason and prior count. */
  note: string;
  /** Mod-log reason (rule + optional reason). */
  reason: string;
  /** Permalink of the content that caused the ban. */
  context: string;
}

/**
 * Build the `banUser` parameters for a ban rung of the ladder, including the
 * ban notification `message` (a PM to the banned user — that part stays) and
 * the modlog `note` (rule + reason + prior count).
 */
export function buildBanParams(params: {
  step: LadderStep;
  rule: Rule;
  target: TargetInfo;
  /** Number of prior mod actions (as counted from PocketBase). */
  priors: number;
  reason?: string;
}): BanParams {
  const { step, rule, target, priors, reason } = params;
  const label = ruleLabel(rule);
  const withReason = reason ? `${label} — ${reason}` : label;

  return {
    username: target.authorName,
    subredditName: target.subredditName,
    // Omit `duration` entirely for permanent bans (durationDays === 0).
    ...(step.durationDays > 0 ? { duration: step.durationDays } : {}),
    message:
      `You have been banned from r/${target.subredditName}` +
      `${step.durationDays > 0 ? ` for ${step.durationDays} day(s)` : ' permanently'}.\n\n` +
      `Reason: ${withReason}`,
    note:
      `Auto-escalation: ${step.label} | ${label} | priors: ${priors}` +
      `${reason ? ` | reason: ${reason}` : ''}`,
    reason: withReason,
    context: target.permalink,
  };
}

/**
 * Build the PocketBase `mod_actions` record for the executed action.
 *
 * Field conventions (kept compatible with the Python-side recorder):
 * - `duration_days` is `0` for warnings (the live `!w` recorder uses 0 for
 *   warnings too — only imported warnings carry real durations) and for
 *   permanent bans.
 * - `source` is always `'devvit'` and `source_ref` is `devvit:<thingId>`.
 * - `command_comment_id` is `''` (no chat command triggered this).
 * - `reddit_post_id` / `reddit_comment_id` split the target thing into its
 *   post/comment parts (`''` where not applicable).
 */
export function buildModActionFields(params: {
  step: LadderStep;
  rule: Rule;
  target: TargetInfo;
  /** Username of the acting moderator, without the leading `u/`. */
  modUsername: string;
  reason?: string;
  /** Clock injection for tests; defaults to `new Date()`. */
  now?: Date;
}): ModActionFields {
  const { step, rule, target, modUsername, reason } = params;
  return {
    action: step.action,
    rule: rule.number,
    duration_days: step.action === 'warn' ? 0 : step.durationDays,
    target_user: target.authorName,
    mod_user: modUsername,
    command_comment_id: '',
    thing_id: target.thingId,
    permalink: target.permalink,
    reason: reason ?? '',
    rule_name: rule.name,
    action_date: (params.now ?? new Date()).toISOString(),
    source: 'devvit',
    source_ref: `devvit:${target.thingId}`,
    reddit_post_id: target.kind === 'post' ? target.thingId : target.parentPostId,
    reddit_comment_id: target.kind === 'comment' ? target.thingId : '',
  };
}
