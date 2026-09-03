import { describe, expect, it } from 'vitest';

import {
  buildFailureToast,
  buildSuccessToast,
  CommentLike,
  PostLike,
  resolveTargetIdFromContext,
  ruleLabel,
  targetFromComment,
  targetFromPost,
} from '../src/actions/escalate.js';
import type { EscalateResult } from '../src/lib/service.js';
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

const BAN_RESULT: EscalateResult = {
  action: 'ban',
  duration_days: 7,
  label: '7 day ban',
  comment_id: '',
  priors: 2,
  rule_name: 'Toxicity',
  recorded: true,
};

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

describe('buildSuccessToast', () => {
  it('formats a warn with the rule label', () => {
    const toast = buildSuccessToast({
      result: {
        action: 'warn',
        duration_days: 0,
        label: 'Warning',
        comment_id: 't1_abc123',
        priors: 0,
        rule_name: 'Toxicity',
        recorded: true,
      },
      targetUser: 'spammer99',
      rule: TOXICITY,
    });

    expect(toast).toBe('Warned u/spammer99 (R2 — Toxicity)');
  });

  it('formats a temporary ban with the ladder label from the service', () => {
    const toast = buildSuccessToast({
      result: BAN_RESULT,
      targetUser: 'spammer99',
      rule: TOXICITY,
    });

    expect(toast).toBe('Banned u/spammer99 — 7 day ban');
  });

  it('formats a permanent ban from its label', () => {
    const toast = buildSuccessToast({
      result: { ...BAN_RESULT, duration_days: 0, label: 'Permanent ban', priors: 4 },
      targetUser: 'spammer99',
      rule: TOXICITY,
    });

    expect(toast).toBe('Banned u/spammer99 — Permanent ban');
  });

  it('appends "(not recorded)" when the service could not write the record', () => {
    const toast = buildSuccessToast({
      result: { ...BAN_RESULT, recorded: false },
      targetUser: 'spammer99',
      rule: TOXICITY,
    });

    expect(toast).toBe('Banned u/spammer99 — 7 day ban (not recorded)');
  });

  it('appends "(not recorded)" to warns too', () => {
    const toast = buildSuccessToast({
      result: {
        action: 'warn',
        duration_days: 0,
        label: 'Warning',
        comment_id: 't1_abc123',
        priors: 0,
        rule_name: 'Toxicity',
        recorded: false,
      },
      targetUser: 'spammer99',
      rule: TOXICITY,
    });

    expect(toast).toBe('Warned u/spammer99 (R2 — Toxicity) (not recorded)');
  });
});

describe('buildFailureToast', () => {
  it('keeps the message short and includes the error detail', () => {
    const toast = buildFailureToast('Escalation service returned 401 Unauthorized: bad token');

    expect(toast).toBe('Escalation failed: Escalation service returned 401 Unauthorized: bad token');
  });
});
