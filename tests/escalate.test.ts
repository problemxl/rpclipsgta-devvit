import { describe, expect, it } from 'vitest';

import {
  buildFailureToast,
  buildSuccessToast,
  type CommentLike,
  type PostLike,
  resolveTargetIdFromContext,
  ruleLabel,
  targetFromComment,
  targetFromPost,
} from '../src/actions/escalate.js';
import type { PunishResult } from '../src/actions/punish.js';
import { RULES } from '../src/lib/rules.js';

const TOXICITY = RULES[1];
const POST: PostLike = {
  id: 't3_abc123', authorName: 'spammer99',
  permalink: '/r/RPClipsGTA/comments/abc123/some_clip/', subredditName: 'RPClipsGTA',
};
const COMMENT: CommentLike = {
  id: 't1_xyz789', authorName: 'spammer99',
  permalink: '/r/RPClipsGTA/comments/abc123/some_clip/xyz789/', subredditName: 'RPClipsGTA',
  postId: 't3_abc123',
};
const BAN_RESULT: PunishResult = {
  action: 'ban', durationDays: 7, label: '7 day ban', commentId: '', priors: 2,
  ruleName: 'Toxicity', recorded: true, finalized: true,
};

describe('target helpers', () => {
  it('maps a post to itself as the parent', () => {
    expect(targetFromPost(POST)).toEqual({
      kind: 'post', thingId: 't3_abc123', authorName: 'spammer99',
      permalink: POST.permalink, subredditName: 'RPClipsGTA', parentPostId: 't3_abc123',
    });
  });

  it('maps a comment to its parent post', () => {
    expect(targetFromComment(COMMENT)).toMatchObject({
      kind: 'comment', thingId: 't1_xyz789', parentPostId: 't3_abc123',
    });
  });

  it('uses an empty parent id for an orphan comment', () => {
    expect(targetFromComment({ ...COMMENT, postId: '' }).parentPostId).toBe('');
  });
});

describe('resolveTargetIdFromContext', () => {
  it('prefers a comment id', () => expect(resolveTargetIdFromContext('t1_x', 't3_y')).toBe('t1_x'));
  it('falls back to a post id', () => expect(resolveTargetIdFromContext(undefined, 't3_y')).toBe('t3_y'));
  it('returns undefined without ids', () => expect(resolveTargetIdFromContext(undefined, undefined)).toBeUndefined());
});

describe('toast builders', () => {
  it('formats rule labels', () => expect(ruleLabel(TOXICITY)).toBe('R2 — Toxicity'));
  it('formats a warning', () => {
    expect(buildSuccessToast({
      result: { action: 'warn', durationDays: 0, label: 'Warning', commentId: 't1_x', priors: 0, ruleName: 'Toxicity', recorded: true, finalized: true },
      targetUser: 'spammer99', rule: TOXICITY,
    })).toBe('Warned u/spammer99 (R2 — Toxicity)');
  });
  it('formats a temporary ban', () => {
    expect(buildSuccessToast({ result: BAN_RESULT, targetUser: 'spammer99', rule: TOXICITY })).toBe('Banned u/spammer99 — 7 day ban');
  });
  it('formats a permanent ban', () => {
    expect(buildSuccessToast({ result: { ...BAN_RESULT, durationDays: 0, label: 'Permanent ban', priors: 4 }, targetUser: 'spammer99', rule: TOXICITY })).toBe('Banned u/spammer99 — Permanent ban');
  });
  it('marks actions whose history was not recorded', () => {
    expect(buildSuccessToast({ result: { ...BAN_RESULT, recorded: false }, targetUser: 'spammer99', rule: TOXICITY })).toContain('(not recorded)');
  });
  it('marks unrecorded warnings too', () => {
    expect(buildSuccessToast({
      result: { action: 'warn', durationDays: 0, label: 'Warning', commentId: 't1_x', priors: 0, ruleName: 'Toxicity', recorded: false, finalized: true },
      targetUser: 'spammer99', rule: TOXICITY,
    })).toBe('Warned u/spammer99 (R2 — Toxicity) (not recorded)');
  });
  it('marks Reddit success with an unfinalized pending record prominently', () => {
    expect(buildSuccessToast({
      result: { ...BAN_RESULT, finalized: false },
      targetUser: 'spammer99', rule: TOXICITY,
    })).toContain('[finalized:false]');
    expect(buildSuccessToast({
      result: { ...BAN_RESULT, finalized: false },
      targetUser: 'spammer99', rule: TOXICITY,
    })).toContain('Do not retry');
  });
  it('keeps failure details short', () => expect(buildFailureToast('Reddit rejected the action')).toBe('Escalation failed: Reddit rejected the action'));
});
