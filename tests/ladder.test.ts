import { describe, expect, it } from 'vitest';

import { effectivePriors, LADDER, pickRung } from '../src/lib/ladder.js';

const MONTH = 30 * 24 * 60 * 60 * 1000;
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

  it('starts with a warning for no priors', () => {
    expect(effectivePriors([], NOW)).toBe(0);
    expect(pickRung([], NOW).label).toBe('Warning');
  });

  it.each([
    [1, '3 day ban'],
    [2, '7 day ban'],
    [3, '14 day ban'],
    [4, '30 day ban'],
    [5, 'Permanent ban'],
    [7, 'Permanent ban'],
  ])('maps %s recent priors to %s', (count, label) => {
    const priors = Array.from({ length: count }, (_, index) => NOW - (index + 1));
    expect(effectivePriors(priors, NOW)).toBe(count);
    expect(pickRung(priors, NOW).label).toBe(label);
  });

  it('decays one prior after a 3.5 month quiet stretch', () => {
    const prior = NOW - 3.5 * MONTH;
    expect(effectivePriors([prior], NOW)).toBe(0);
    expect(pickRung([prior], NOW).label).toBe('Warning');
  });

  it('uses the latest prior as the decay anchor', () => {
    const priors = [NOW - 4 * MONTH, NOW - 10 * MONTH];
    expect(effectivePriors(priors, NOW)).toBe(1);
    expect(pickRung(priors, NOW).label).toBe('3 day ban');
  });

  it('decays two levels after seven quiet months', () => {
    const prior = NOW - 7 * MONTH;
    expect(effectivePriors([prior], NOW)).toBe(0);
    expect(pickRung([prior], NOW).label).toBe('Warning');
  });

  it('decays at exactly three months', () => {
    expect(effectivePriors([NOW - 3 * MONTH], NOW)).toBe(0);
  });
});
