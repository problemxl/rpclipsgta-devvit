import { describe, expect, it } from 'vitest';

import {
  buildBanParams,
  buildModActionFields,
  buildWarningCommentText,
  CommentLike,
  PostLike,
  resolveTargetIdFromContext,
  ruleLabel,
  targetFromComment,
  targetFromPost,
} from '../src/actions/escalate.js';
import { escalate } from '../src/lib/escalation.js';
import { RULES } from '../src/lib/rules.js';

const TOXICITY = RULES[1]; // R2 — Toxicity

const POST: PostLike = {
  id: 't3_abc123',
  authorName: 'spammer99',
  permalink: '/r/RPClipsGTA/comments/abc123/some_clip/',
  subredditName: 'RPClipsGTA',
};

const COMMENT: CommentLike = {
  id: 't1_xyz789',
  authorName: 'spammer99',
  permalink: '/r/RPClipsGTA/comments/abc123/some_clip/xyz789/',
  subredditName: 'RPClipsGTA',
  postId: 't3_abc123',
};

const postTarget = targetFromPost(POST);
const commentTarget = targetFromComment(COMMENT);

describe('targetFromPost / targetFromComment', () => {
  it('maps a post to a post target with itself as the parent post', () => {
    expect(postTarget).toEqual({
      kind: 'post',
      thingId: 't3_abc123',
      authorName: 'spammer99',
      permalink: '/r/RPClipsGTA/comments/abc123/some_clip/',
      subredditName: 'RPClipsGTA',
      parentPostId: 't3_abc123',
    });
  });

  it('maps a comment to a comment target with its parent post id', () => {
    expect(commentTarget.kind).toBe('comment');
    expect(commentTarget.thingId).toBe('t1_xyz789');
    expect(commentTarget.parentPostId).toBe('t3_abc123');
  });

  it('falls back to an empty parent post id when the comment has none', () => {
    const orphan = targetFromComment({ ...COMMENT, postId: '' });
    expect(orphan.parentPostId).toBe('');
  });
});

describe('resolveTargetIdFromContext', () => {
  it('prefers the comment id when both ids are set (comment menu press)', () => {
    expect(resolveTargetIdFromContext('t1_xyz789', 't3_abc123')).toBe('t1_xyz789');
  });

  it('falls back to the post id', () => {
    expect(resolveTargetIdFromContext(undefined, 't3_abc123')).toBe('t3_abc123');
  });

  it('returns undefined when neither id is present', () => {
    expect(resolveTargetIdFromContext(undefined, undefined)).toBeUndefined();
  });
});

describe('ruleLabel', () => {
  it('formats as R<number> — <name>', () => {
    expect(ruleLabel(TOXICITY)).toBe('R2 — Toxicity');
  });
});

describe('buildWarningCommentText', () => {
  it('mentions the author, the thing kind, the rule label and ban escalation', () => {
    const text = buildWarningCommentText({
      rule: TOXICITY,
      kind: 'comment',
      authorName: 'spammer99',
    });

    expect(text).toContain('u/spammer99');
    expect(text).toContain('comment');
    expect(text).toContain('R2 — Toxicity');
    expect(/ban/i.test(text)).toBe(true);
  });

  it('says "post" for post targets and "comment" for comment targets', () => {
    const forPost = buildWarningCommentText({ rule: TOXICITY, kind: 'post', authorName: 'a' });
    const forComment = buildWarningCommentText({ rule: TOXICITY, kind: 'comment', authorName: 'a' });
    expect(forPost).toContain('your post');
    expect(forPost).not.toContain('your comment');
    expect(forComment).toContain('your comment');
  });

  it('includes the reason when given and omits the reason line otherwise', () => {
    const withReason = buildWarningCommentText({
      rule: TOXICITY,
      reason: 'Be civil',
      kind: 'post',
      authorName: 'a',
    });
    expect(withReason).toContain('Reason: Be civil');

    const withoutReason = buildWarningCommentText({ rule: TOXICITY, kind: 'post', authorName: 'a' });
    expect(withoutReason).not.toContain('Reason:');
  });
});

describe('buildBanParams', () => {
  it('builds a temporary ban with a duration, notification message and modlog note', () => {
    const params = buildBanParams({
      step: escalate(1), // 3 day ban
      rule: TOXICITY,
      target: commentTarget,
      priors: 1,
      reason: 'beeping at mods',
    });

    expect(params.username).toBe('spammer99');
    expect(params.subredditName).toBe('RPClipsGTA');
    expect(params.duration).toBe(3);
    expect(params.context).toBe(commentTarget.permalink);
    expect(params.message).toContain('3 day(s)');
    expect(params.message).toContain('R2 — Toxicity');
    expect(params.message).toContain('beeping at mods');
    expect(params.note).toContain('R2 — Toxicity');
    expect(params.note).toContain('priors: 1');
    expect(params.note).toContain('beeping at mods');
    expect(params.reason).toBe('R2 — Toxicity — beeping at mods');
  });

  it('OMITS the duration key entirely for permanent bans', () => {
    const params = buildBanParams({
      step: escalate(4), // permanent
      rule: TOXICITY,
      target: postTarget,
      priors: 4,
      reason: '',
    });

    expect('duration' in params).toBe(false);
    expect(params.message).toContain('permanently');
    expect(params.note).not.toContain('reason:');
    expect(params.reason).toBe('R2 — Toxicity');
  });
});

describe('buildModActionFields', () => {
  const now = new Date('2025-06-01T12:00:00.000Z');

  it('builds a warn record on a post with duration_days 0 and devvit source fields', () => {
    const fields = buildModActionFields({
      step: escalate(0), // warn
      rule: TOXICITY,
      target: postTarget,
      modUsername: 'realmod',
      reason: 'toxic clip title',
      now,
    });

    expect(fields).toEqual({
      action: 'warn',
      rule: 2,
      duration_days: 0,
      target_user: 'spammer99',
      mod_user: 'realmod',
      command_comment_id: '',
      thing_id: 't3_abc123',
      permalink: '/r/RPClipsGTA/comments/abc123/some_clip/',
      reason: 'toxic clip title',
      rule_name: 'Toxicity',
      action_date: '2025-06-01T12:00:00.000Z',
      source: 'devvit',
      source_ref: 'devvit:t3_abc123',
      reddit_post_id: 't3_abc123',
      reddit_comment_id: '',
    });
  });

  it('builds a ban record on a comment: real duration, parent post id, comment id', () => {
    const fields = buildModActionFields({
      step: escalate(2), // 7 day ban
      rule: TOXICITY,
      target: commentTarget,
      modUsername: 'realmod',
      reason: '',
      now,
    });

    expect(fields.action).toBe('ban');
    expect(fields.duration_days).toBe(7);
    expect(fields.thing_id).toBe('t1_xyz789');
    expect(fields.reddit_comment_id).toBe('t1_xyz789');
    expect(fields.reddit_post_id).toBe('t3_abc123'); // parent post
    expect(fields.reason).toBe('');
  });

  it('records 0 duration_days for permanent bans', () => {
    const fields = buildModActionFields({
      step: escalate(4), // permanent
      rule: TOXICITY,
      target: postTarget,
      modUsername: 'realmod',
      now,
    });
    expect(fields.duration_days).toBe(0);
  });

  it('defaults action_date to the current time as ISO', () => {
    const before = new Date();
    const fields = buildModActionFields({
      step: escalate(0),
      rule: TOXICITY,
      target: postTarget,
      modUsername: 'realmod',
    });
    const after = new Date();

    const ts = new Date(fields.action_date);
    expect(fields.action_date).toBe(ts.toISOString());
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
