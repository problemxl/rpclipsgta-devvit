import { describe, expect, it } from 'vitest';

import { effectivePriors, LADDER, pickRung } from '../src/lib/ladder.js';

const DAY = 24 * 60 * 60 * 1000;
const MONTH = 30 * DAY;
const NOW = 1_000_000_000;

 describe('ladder', () => {
  it('pins the wiki rung labels and actions', () => {
    expect(LADDER.map((rung) => rung.label)).toEqual([
      'Warning',
      '3 day ban',
      '7 day ban',
      '14 day ban',
      '30 day ban',
      'Permanent ban',
    ]);
    expect(LADDER.map((rung) => rung.action)).toEqual([
      'warn', 'ban', 'ban', 'ban', 'ban', 'ban',
    ]);
  });

  it('starts with a warning for no history', () => {
    expect(effectivePriors(0, undefined, NOW)).toBe(0);
    expect(effectivePriors(0, NOW - 1, NOW)).toBe(0);
    expect(pickRung(0, undefined, NOW).label).toBe('Warning');
  });

  it('treats a summary without a latest action as fresh, whatever the total', () => {
    // latestAt undefined means "no readable history": no decay anchor exists,
    // so the count cannot be trusted and presents as zero priors.
    expect(effectivePriors(5, undefined, NOW)).toBe(0);
    expect(pickRung(5, undefined, NOW).label).toBe('Warning');
  });

  it.each([
    [1, '3 day ban'],
    [2, '7 day ban'],
    [3, '14 day ban'],
    [4, '30 day ban'],
    [5, 'Permanent ban'],
    [7, 'Permanent ban'],
  ])('maps %s recent priors to %s', (count, label) => {
    expect(effectivePriors(count, NOW - (count + 1), NOW)).toBe(count);
    expect(pickRung(count, NOW - (count + 1), NOW).label).toBe(label);
  });

  it('decays one prior after a 3.5 month quiet stretch', () => {
    expect(effectivePriors(1, NOW - 3.5 * MONTH, NOW)).toBe(0);
    expect(pickRung(1, NOW - 3.5 * MONTH, NOW).label).toBe('Warning');
  });

  it('uses the latest prior as the decay anchor', () => {
    // Two retained priors whose newest is four months old: one full 90-day
    // quiet stretch has passed, so one level decays.
    expect(effectivePriors(2, NOW - 4 * MONTH, NOW)).toBe(1);
    expect(pickRung(2, NOW - 4 * MONTH, NOW).label).toBe('3 day ban');
  });

  it('decays two levels after seven quiet months', () => {
    expect(effectivePriors(2, NOW - 7 * MONTH, NOW)).toBe(0);
    expect(pickRung(2, NOW - 7 * MONTH, NOW).label).toBe('Warning');
  });

  it('decays at exactly three months but keeps the prior one ms earlier', () => {
    expect(effectivePriors(1, NOW - 3 * MONTH, NOW)).toBe(0);
    expect(effectivePriors(1, NOW - 3 * MONTH + 1, NOW)).toBe(1);
  });

  it('floors decayed totals at zero across years of quiet', () => {
    // Full lifetime retention keeps all rows forever; decay alone must cap
    // the effective count, never go negative.
    expect(effectivePriors(3, NOW - 5 * 365 * DAY, NOW)).toBe(0);
    expect(pickRung(3, NOW - 5 * 365 * DAY, NOW).label).toBe('Warning');
  });
});
