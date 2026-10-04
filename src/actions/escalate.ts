/**
 * Pure helpers for the escalate flow.
 *
 * Everything in this module is framework-free (no `@devvit/*` imports) so it
 * can be unit-tested with vitest without the Devvit runtime. `src/main.ts`
 * wires these helpers into the mod menu / form handlers.
 *
 * The app resolves the target and delegates execution to the in-app ladder.
 * This module keeps target resolution and toast text builders framework-free.
 */

import type { PunishResult } from './punish.js';
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
 * Success toast for a completed escalation. Warns show the rule
 * (`Warned u/x (R2 — Toxicity)`), bans show the ladder label
 * (`Banned u/x — 7 day ban`). A Reddit success whose pending history marker
 * could not be finalized is called out as `finalized:false`; it must never
 * look like an ordinary completed success because retry remains blocked.
 */
export function buildSuccessToast(params: {
  result: PunishResult;
  /** Username of the target user, without the leading `u/`. */
  targetUser: string;
  /** The rule the acting mod selected in the form. */
  rule: Rule;
}): string {
  const { result, targetUser, rule } = params;
  const summary =
    result.action === 'warn'
      ? `Warned u/${targetUser} (${ruleLabel(rule)})`
      : `Banned u/${targetUser} — ${result.label}`;
  if (result.finalized === false) {
    const record = result.pendingRecordId ? ` Record: ${result.pendingRecordId}.` : '';
    return `${summary} [finalized:false] Reddit action applied; history finalization failed.${record} Do not retry; reconcile the pending record.`;
  }
  return result.recorded ? summary : `${summary} (not recorded)`;
}

/** Short failure toast for an execution failure. */
export function buildFailureToast(detail: string): string {
  return `Escalation failed: ${detail}`;
}
