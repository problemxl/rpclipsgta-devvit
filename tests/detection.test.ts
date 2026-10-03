import { describe, expect, it } from 'vitest';

import {
  BANNED_STREAMERS,
  detectContentViolations,
  isDuplicateUrl,
  normalizeUrlForDuplication,
  WHITELISTED_DOMAINS,
  type SubmissionInput,
} from '../src/lib/detection.js';

function link(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    title: 'A good clip title',
    url: 'https://clips.twitch.tv/ClipOne',
    body: '',
    isTextPost: false,
    ...overrides,
  };
}

function rules(submission: SubmissionInput): number[] {
  return detectContentViolations(submission).map((violation) => violation.rule);
}

describe('detection constants', () => {
  it('contains the eight wiki rule 5 domains and normalized rule 12 names', () => {
    expect(WHITELISTED_DOMAINS).toEqual([
      'clips.twitch.tv',
      'twitch.tv',
      'facebook.com',
      'fb.watch',
      'kick.com',
      'streamable.com',
      'youtube.com',
      'imgur.com',
    ]);
    expect(BANNED_STREAMERS).toEqual(['koil', 'dasmehdi', 'zombie_barricades']);
  });
});

describe('detectContentViolations', () => {
  it.each([
    ['an arbitrary domain', 'https://example.com/clip'],
    ['an invalid URL', 'not a URL'],
    ['a deceptive suffix domain', 'https://twitch.tv.evil.example/clip'],
  ])('detects %s as a rule 5 violation', (_label, url) => {
    expect(rules(link({ url }))).toContain(5);
  });

  it('strips www and permits allowlisted subdomains', () => {
    expect(rules(link({ url: 'https://WWW.YOUTUBE.COM/watch?v=abc' }))).not.toContain(5);
    expect(rules(link({ url: 'https://clips.sub.youtube.com/watch?v=abc' }))).not.toContain(5);
    expect(rules(link({ url: 'https://sub.twitch.tv/clip/abc' }))).not.toContain(4);
  });

  it.each([
    'https://twitch.tv/videos/123',
    'https://www.twitch.tv/channel/video/123',
    'https://kick.com/videos/123',
  ])('rejects VOD URL %s under rule 5', (url) => {
    const violation = detectContentViolations(link({ url })).find((item) => item.rule === 5);
    expect(violation?.reason).toBe('VOD links are prohibited as submissions');
  });

  it('requires a non-empty bracket group on Streamable titles', () => {
    expect(rules(link({ url: 'https://streamable.com/abc', title: 'funny clip' }))).toContain(5);
    expect(rules(link({ url: 'https://www.streamable.com/abc', title: '[Kiva] funny clip' }))).not.toContain(5);
    expect(rules(link({ url: 'https://streamable.com/abc', title: '[   ] funny clip' }))).toContain(5);
  });

  it('does not domain-check text posts, while still applying text checks', () => {
    expect(
      rules({
        title: 'Context post',
        url: 'https://not-allowed.example/clip',
        body: 'First sentence. Second sentence.',
        isTextPost: true,
      })
    ).not.toContain(5);
  });

  it('detects text posts under two sentences using non-empty sentence segments', () => {
    expect(rules(link({ isTextPost: true, url: '', body: 'Only one sentence.' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'First! — Second?' }))).not.toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: '  ...  ' }))).toContain(4);
  });

  it('detects twitch channel links but not clip links', () => {
    const violation = detectContentViolations(
      link({ url: 'https://www.twitch.tv/some_channel/' })
    ).find((item) => item.rule === 4);
    expect(violation?.reason).toBe('link is a twitch channel, not a clip');
    expect(rules(link({ url: 'https://www.twitch.tv/some_channel/clip/ClipOne' }))).not.toContain(4);
    expect(rules(link({ url: 'https://clips.twitch.tv/SomeClip' }))).not.toContain(4);
  });

  it('detects titles with no letters as emote-only rule 4 titles', () => {
    expect(rules(link({ title: '  😂 !!!  ' }))).toContain(4);
    expect(rules(link({ title: '😂 Great clip' }))).not.toContain(4);
  });

  it.each(['KoIl', 'dasMEHDI', 'Zombie Barricades', 'zombie-barricades'])(
    'detects banned streamer %s in a title as remove-only rule 12',
    (name) => {
      const violation = detectContentViolations(link({ title: `${name} clip` })).find(
        (item) => item.rule === 12
      );
      expect(violation).toMatchObject({ rule: 12, action: 'remove' });
    }
  );

  it('detects banned streamer forms in the URL and keeps the exact rule 12 reason', () => {
    const violation = detectContentViolations(
      link({ url: 'https://clips.twitch.tv/koil-stream' })
    ).find((item) => item.rule === 12);
    expect(violation).toEqual({
      rule: 12,
      reason: 'submission mentions a banned streamer',
      action: 'remove',
    });
  });

  it('returns all matches for the orchestrator to prioritize', () => {
    expect(
      detectContentViolations(
        link({ url: 'https://evil.example/koil', title: '😂' })
      ).map((violation) => violation.rule)
    ).toEqual([5, 4, 12]);
  });
});

describe('duplicate URL normalization for rule 6', () => {
  it('normalizes host casing, www, trailing slash, hash, and tracking parameters', () => {
    expect(
      normalizeUrlForDuplication(
        'HTTPS://WWW.YouTube.com/watch/?v=abc&utm_source=reddit&fbclid=123#comments'
      )
    ).toBe('https://youtube.com/watch?v=abc');
  });

  it('keeps non-tracking query parameters', () => {
    expect(normalizeUrlForDuplication('https://example.com/a?x=1&utm_medium=x&y=2')).toBe(
      'https://example.com/a?x=1&y=2'
    );
  });

  it('compares equivalent normalized URLs and rejects different URLs or null state', () => {
    expect(
      isDuplicateUrl(
        'https://www.example.com/clip/?gclid=x#time',
        'https://example.com/clip'
      )
    ).toBe(true);
    expect(isDuplicateUrl('https://example.com/one', 'https://example.com/two')).toBe(false);
    expect(isDuplicateUrl('https://example.com/one', null)).toBe(false);
  });
});
