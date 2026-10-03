import { describe, expect, it, vi } from 'vitest';

import { punish, buildWarningComment, type PunishDeps } from '../src/actions/punish.js';
import type { HistoryStore, ModActionRecord } from '../src/lib/history.js';

const NOW = 1_000_000_000;
const MONTH = 30 * 24 * 60 * 60 * 1000;

function memoryHistory(initial: ModActionRecord[] = []): HistoryStore {
  const records = [...initial];
  return {
    load: async () => [...records],
    append: async (_username, record) => {
      records.push(record);
      return true;
    },
  };
}

function deps(overrides: Partial<PunishDeps> = {}, initial: ModActionRecord[] = []): PunishDeps {
  return {
    history: memoryHistory(initial),
    // Minimal always-acquiring lock double; lock behavior is covered in the
    // dedicated test commit.
    redis: {
      get: async () => undefined,
      set: async () => 'OK',
      del: async () => undefined,
    },
    submitComment: vi.fn(async () => 't1_warning'),
    banUser: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  };
}

const input = {
  targetUser: 'Target', targetThingId: 't3_post', subredditName: 'RPClipsGTA',
  rule: 2, reason: 'toxic chat', modUser: 'Mod',
};

describe('punish', () => {
  it('warns a fresh user, submits expected text, and records the action', async () => {
    const current = deps();
    const result = await punish(current, input);
    expect(result).toMatchObject({ action: 'warn', label: 'Warning', priors: 0, recorded: true });
    expect(current.submitComment).toHaveBeenCalledWith(expect.objectContaining({
      replyTargetThingId: 't3_post',
      text: expect.stringContaining('R2 — Toxicity'),
    }));
    expect(current.banUser).not.toHaveBeenCalled();
  });

  it('bans after one recent prior with a three-day duration', async () => {
    const current = deps({}, [{ ...inputRecord(1), at: NOW - 1 }]);
    await punish(current, input);
    expect(current.banUser).toHaveBeenCalledWith(expect.objectContaining({
      durationDays: 3,
      reason: 'R2 — Toxicity',
      note: '[devvit] by Mod',
      message: expect.stringContaining('3 day ban'),
    }));
    expect(current.submitComment).not.toHaveBeenCalled();
  });

  it('omits duration for a permanent ban', async () => {
    const current = deps({}, Array.from({ length: 5 }, (_, index) => inputRecord(NOW - index - 1)));
    await punish(current, input);
    expect(current.banUser).toHaveBeenCalledWith(expect.not.objectContaining({ durationDays: expect.anything() }));
  });

  it('continues after a history append failure', async () => {
    const current = deps({ history: { load: async () => [], append: async () => false } });
    await expect(punish(current, input)).resolves.toMatchObject({ recorded: false, action: 'warn' });
    expect(current.submitComment).toHaveBeenCalled();
  });

  it('propagates comment execution failures', async () => {
    const current = deps({ submitComment: vi.fn(async () => { throw new Error('comment failed'); }) });
    await expect(punish(current, input)).rejects.toThrow('comment failed');
  });

  it('decays a seven-month-old prior back to a warning', async () => {
    const current = deps({}, [{ ...inputRecord(NOW - 7 * MONTH) }]);
    await expect(punish(current, input)).resolves.toMatchObject({ action: 'warn', priors: 0 });
    expect(current.submitComment).toHaveBeenCalled();
  });
});

type InputRecord = ModActionRecord;
function inputRecord(at: number): InputRecord {
  return { at, rule: 1, action: 'warn', label: 'Warning', modUser: 'old', targetThingId: 't3_old' };
}

describe('buildWarningComment', () => {
  it('includes reason, rules link, and next-rung wording', () => {
    const text = buildWarningComment({ targetUser: 'u', rule: 2, ruleName: 'Toxicity', reason: 'be kind', rung: 'Warning' });
    expect(text).toContain('be kind');
    expect(text).toContain('https://www.reddit.com/r/RPClipsGTA/wiki/subreddit/rules/');
    expect(text).toContain('next violation may result in a **3 day ban**');
  });

  it('handles an empty reason and the permanent next-rung boundary', () => {
    const text = buildWarningComment({ targetUser: 'u', rule: 2, ruleName: 'Toxicity', reason: '', rung: 'Permanent ban' });
    expect(text).not.toContain('**Reason:**');
    expect(text).toContain('**Permanent ban**');
  });
});
