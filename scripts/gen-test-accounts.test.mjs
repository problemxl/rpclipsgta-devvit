import { describe, expect, it } from 'vitest';

import {
  parseCommandArgs,
  parseRedditVerificationLinks,
} from './gen-test-accounts.mjs';

describe('Guerrilla Mail helper parsing', () => {
  it('returns only exact HTTPS Reddit links and decodes HTML query separators', () => {
    const body = `
      <a href="https://www.reddit.com/verification/abc?token=one&amp;foo=two">verify</a>
      https://reddit.com/verify/abc?token=one&amp;foo=two.
      https://reddit.com.evil.example/verification/phish
      https://evilreddit.com/verification/phish
      https://example.com/?next=https://reddit.com/verification/phish
    `;

    expect(parseRedditVerificationLinks(body)).toEqual([
      'https://www.reddit.com/verification/abc?token=one&foo=two',
      'https://reddit.com/verify/abc?token=one&foo=two',
    ]);
  });

  it('deduplicates links found in both HTML and text forms', () => {
    const link = 'https://www.reddit.com/verification/abc?token=one';
    expect(parseRedditVerificationLinks(`<a href="${link}">${link}</a>`)).toEqual([link]);
  });
});

describe('command-line parsing', () => {
  it('accepts documented count and both wait syntaxes', () => {
    expect(parseCommandArgs(['gen', '4'])).toEqual({ command: 'gen', count: 4 });
    expect(parseCommandArgs(['check', '--wait', '5'])).toEqual({ command: 'check', waitSeconds: 5 });
    expect(parseCommandArgs(['check', '--wait=5'])).toEqual({ command: 'check', waitSeconds: 5 });
  });

  it('rejects malformed or unknown arguments instead of silently changing behavior', () => {
    expect(() => parseCommandArgs(['gen', '0'])).toThrow('count must be an integer from 1 to 10');
    expect(() => parseCommandArgs(['check', '--wait=wat'])).toThrow('wait must be a non-negative integer');
    expect(() => parseCommandArgs(['check', '--unknown'])).toThrow('unknown argument');
  });
});
