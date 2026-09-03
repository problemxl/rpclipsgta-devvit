import { describe, expect, it } from 'vitest';

import { escalate, LADDER } from '../src/lib/escalation.js';

describe('escalation ladder', () => {
  it('maps every prior-count step to the expected action', () => {
    expect(escalate(0).action).toBe('warn');
    expect(escalate(1).action).toBe('ban');
    expect(escalate(2).action).toBe('ban');
    expect(escalate(3).action).toBe('ban');
    expect(escalate(4).action).toBe('ban');
  });

  it('uses the correct durations in days', () => {
    expect(escalate(0).durationDays).toBe(0);
    expect(escalate(1).durationDays).toBe(3);
    expect(escalate(2).durationDays).toBe(7);
    expect(escalate(3).durationDays).toBe(30);
    expect(escalate(4).durationDays).toBe(0); // permanent
  });

  it('produces the exact human-readable labels', () => {
    expect(escalate(0).label).toBe('Warning');
    expect(escalate(1).label).toBe('3 day ban');
    expect(escalate(2).label).toBe('7 day ban');
    expect(escalate(3).label).toBe('30 day ban');
    expect(escalate(4).label).toBe('Permanent ban');
  });

  it('clamps counts below zero to the first rung (warning)', () => {
    expect(escalate(-1)).toEqual(LADDER[0]);
    expect(escalate(-100)).toEqual(LADDER[0]);
  });

  it('clamps counts above the last rung to a permanent ban', () => {
    expect(escalate(5)).toEqual(LADDER[LADDER.length - 1]);
    expect(escalate(100)).toEqual(LADDER[LADDER.length - 1]);
    expect(escalate(100).label).toBe('Permanent ban');
  });

  it('is defined by a 5-rung ladder 0..4', () => {
    expect(LADDER).toHaveLength(5);
    expect(LADDER.map((step) => step.priorCount)).toEqual([0, 1, 2, 3, 4]);
    // Warnings never carry a duration; permanent bans are duration 0.
    expect(LADDER.filter((s) => s.action === 'warn').every((s) => s.durationDays === 0)).toBe(true);
    expect(LADDER[LADDER.length - 1].durationDays).toBe(0);
  });
});
