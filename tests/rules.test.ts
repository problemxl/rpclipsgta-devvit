import { describe, expect, it } from 'vitest';

import { ruleByNumber, RULES } from '../src/lib/rules.js';

describe('rules', () => {
  it('contains exactly 12 rules', () => {
    expect(RULES).toHaveLength(12);
  });

  it('numbers rules sequentially from 1 to 12', () => {
    expect(RULES.map((rule) => rule.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('has non-empty names for every rule', () => {
    for (const rule of RULES) {
      expect(rule.name.length).toBeGreaterThan(0);
    }
  });

  it('matches the canonical rule names', () => {
    const expected = [
      'Reddit Rules',
      'Toxicity',
      'No call to action',
      'Low Effort content',
      'Whitelisted domains',
      'Duplicate Post',
      'Self-promotion / Advertising',
      'Non GTA RP content',
      'Suggestions for streamers or servers',
      'Flairs and tags',
      'Off-topic content',
      'Banned Streamer',
    ];
    expect(RULES.map((rule) => rule.name)).toEqual(expected);
  });

  describe('ruleByNumber', () => {
    it('finds each rule by its number', () => {
      for (const rule of RULES) {
        expect(ruleByNumber(rule.number)).toEqual(rule);
      }
    });

    it('returns undefined for numbers outside 1-12', () => {
      expect(ruleByNumber(0)).toBeUndefined();
      expect(ruleByNumber(13)).toBeUndefined();
      expect(ruleByNumber(-1)).toBeUndefined();
    });
  });
});
