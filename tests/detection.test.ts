import { describe, expect, it } from 'vitest';

import {
  BANNED_STREAMERS,
  actionForRule,
  detectContentViolations,
  isDuplicateUrl,
  normalizeUrlForDuplication,
  parseSubmissionUrl,
  isWhitelistedHost,
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

describe('detection action policy', () => {
  it.each([
    [1, 'remove-and-escalate'],
    [2, 'remove-and-escalate'],
    [3, 'remove-and-escalate'],
    [4, 'remove-and-escalate'],
    [5, 'remove'],
    [6, 'remove'],
    [7, 'remove-and-escalate'],
    [8, 'remove-and-escalate'],
    [9, 'remove-and-escalate'],
    [10, 'remove'],
    [11, 'remove'],
    [12, 'remove'],
  ] as const)('maps R%s to %s', (rule, action) => {
    expect(actionForRule(rule)).toBe(action);
  });

  it('uses the same policy map on detected violations', () => {
    const cases = [
      [link({ url: 'https://bad.example/clip' }), 5, 'remove'],
      [link({ title: '😂 !!!' }), 4, 'remove-and-escalate'],
      [link({ title: 'Koil clip' }), 12, 'remove'],
    ] as const;

    for (const [submission, rule, action] of cases) {
      expect(detectContentViolations(submission).find((violation) => violation.rule === rule))
        .toMatchObject({ rule, action });
    }
  });
});

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

  it('strips one www but rejects allowlisted subdomains', () => {
    expect(rules(link({ url: 'https://WWW.YOUTUBE.COM/watch?v=abc' }))).not.toContain(5);
    expect(rules(link({ url: 'https://uploads.youtube.com/watch?v=abc' }))).toContain(5);
    expect(rules(link({ url: 'https://sub.twitch.tv/clip/abc' }))).toContain(5);
    expect(isWhitelistedHost('www.youtube.com')).toBe(true);
    expect(isWhitelistedHost('uploads.youtube.com')).toBe(false);
  });

  it.each([
    'https://twitch.tv/videos/123',
    'https://www.twitch.tv/channel/video/123',
    'https://twitch.tv/channel/videos/123/',
    'https://twitch.tv/channel/videos/123?t=123',
    'https://kick.com/videos/123',
    'https://kick.com/channel/videos/123/',
    'https://kick.com/channel/videos/123?t=123',
  ])('rejects VOD URL %s under rule 5', (url) => {
    const violation = detectContentViolations(link({ url })).find((item) => item.rule === 5);
    expect(violation?.reason).toBe('VOD links are prohibited as submissions');
  });

  it.each([
    'https://twitch.tv/channel/video/1234/nearby',
    'https://twitch.tv/channel/videos',
    'https://kick.com/channel/video/123',
    'https://kick.com/channel/videos/123/extra',
  ])('does not classify nearby path %s as a VOD', (url) => {
    expect(detectContentViolations(link({ url })).find(
      (item) => item.reason === 'VOD links are prohibited as submissions'
    )).toBeUndefined();
  });

  it('requires a letter-containing bracket group at the title start on Streamable', () => {
    expect(rules(link({ url: 'https://streamable.com/abc', title: 'funny clip' }))).toContain(5);
    expect(rules(link({ url: 'https://www.streamable.com/abc', title: '[Kiva] funny clip' }))).not.toContain(5);
    expect(rules(link({ url: 'https://streamable.com/abc', title: '[   ] funny clip' }))).toContain(5);
    expect(rules(link({ url: 'https://streamable.com/abc', title: '[!!!] title' }))).toContain(5);
    expect(rules(link({ url: 'https://streamable.com/abc', title: 'text [spoiler]' }))).toContain(5);
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

  it('detects text posts under two sentences using hardened sentence counting', () => {
    expect(rules(link({ isTextPost: true, url: '', body: 'Only one sentence.' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'Mr. X robbed the bank. It went poorly.' }))).not.toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'Version 2.0 is out' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'Check https://youtube.com/x now. Nice.' }))).not.toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'See https://example.com/x. Next sentence.' }))).not.toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'Check [this clip](https://clips.twitch.tv/x) out. It was wild.' }))).not.toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: '[link](https://x.y) only.' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'line one\nline two' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'one. .' }))).toContain(4);
    expect(rules(link({ isTextPost: true, url: '', body: 'First! — Second?' }))).not.toContain(4);
  });

  it('detects twitch channel links but not clip links', () => {
    const violation = detectContentViolations(
      link({ url: 'https://www.twitch.tv/some_channel/' })
    ).find((item) => item.rule === 4);
    expect(violation?.reason).toBe('link is a twitch channel, not a clip');
    expect(rules(link({ url: 'https://www.twitch.tv/some_channel/clip/ClipOne' }))).not.toContain(4);
    expect(rules(link({ url: 'https://clips.twitch.tv/SomeClip' }))).not.toContain(4);
    expect(rules(link({ url: 'https://twitch.tv/x/clip/y' }))).not.toContain(5);
    expect(rules(link({ url: 'https://twitch.tv/x/some/arbitrary/path' }))).toContain(5);
    expect(rules(link({ url: 'https://twitch.tv/x/y' }))).toContain(5);
    expect(detectContentViolations(link({ url: 'https://twitch.tv/x/some/arbitrary/path' })).find(
      (item) => item.rule === 5
    )?.reason).toContain('clips.twitch.tv');
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

  it('scans only title and decoded URL path for rule 12 with custom boundaries', () => {
    expect(rules(link({ url: 'https://youtube.com/watch?v=abc&utm_campaign=koil' }))).not.toContain(12);
    expect(rules(link({ title: 'KOIL highlights' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/koil_clips/123' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/das%4DEHDI/x' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/bad%zz/koil/123' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/koilicious/1' }))).not.toContain(12);
    expect(rules(link({ url: 'https://clips.twitch.tv/koil-stream' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/zombie_barricades/1' }))).toContain(12);
    expect(rules(link({ url: 'https://youtube.com/zombie-barricades/1' }))).toContain(12);
  });

  it('returns at most one violation for each rule', () => {
    const violations = detectContentViolations(link({
      url: 'https://twitch.tv/channel/videos/123',
      title: '[!!!] 😂',
    }));
    expect(violations.filter((item) => item.rule === 5)).toHaveLength(1);
    expect(new Set(violations.map((item) => item.rule)).size).toBe(violations.length);
  });

  it('returns all matches for the orchestrator to prioritize', () => {
    expect(
      detectContentViolations(
        link({ url: 'https://evil.example/koil', title: '😂' })
      ).map((violation) => violation.rule)
    ).toEqual([5, 4, 12]);
  });
});

describe('URL parsing for rule 5', () => {
  it('requires HTTP(S) and treats malformed URLs as non-whitelisted', () => {
    expect(parseSubmissionUrl('ftp://youtube.com/x')).toEqual({ ok: false });
    expect(parseSubmissionUrl('not a url')).toEqual({ ok: false });
    expect(rules(link({ url: 'ftp://youtube.com/x' }))).toContain(5);
    expect(rules(link({ url: 'not a url' }))).toContain(5);
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
