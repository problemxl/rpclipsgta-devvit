import { describe, expect, it } from 'vitest';

import { filterRoleplayStreams, isRoleplayTitle } from '../src/lib/rp-filter.js';
import type { TwitchStream } from '../src/lib/twitch.js';

function stream(title: string, viewerCount = 100): TwitchStream {
  return { user_login: title.toLowerCase().replace(/\W+/g, '_'), user_name: 'N', title, viewer_count: viewerCount };
}

describe('isRoleplayTitle', () => {
  it.each([
    ['GTA RP | NoPixel V | serious cop roleplay', true],
    ['nopixel v | wl only | downtown pd', true],
    ['FiveM server night with the crew', true],
    ['RAGE MP street races + RP', true],
    ['GTA World: court hearing at 8', true],
    ['Eclipse RP fresh start', true],
    ['Whitelisted server,serious rp', true],
    ['LIVE: NP heist planning', true],
    ['GTA Online CEO grinding — 2x cash', false],
    ['Story mode 100% completion run', false],
    ['Just driving around Los Santos', false],
    ['GTA Online: Diamond Casino heist finale', false],
    ['story mode mission 42 no commentary', false],
  ])('%s → %s', (title, expected) => {
    expect(isRoleplayTitle(title)).toBe(expected);
  });

  it('does not match RP as a substring of another word', () => {
    // "orpheus" contains "rp" but not as a standalone token.
    expect(isRoleplayTitle('orpheus pack opening')).toBe(false);
  });

  it('does not treat "five minute" as FiveM', () => {
    expect(isRoleplayTitle('five minute heist challenge')).toBe(false);
  });
});

describe('filterRoleplayStreams', () => {
  it('keeps only RP-marked streams and preserves viewer order', () => {
    const pool = [
      stream('GTA Online grinding', 50000),
      stream('NoPixel V | cops', 30000),
      stream('just cruising', 20000),
      stream('FiveM RP night', 10000),
    ];
    expect(filterRoleplayStreams(pool)).toEqual([
      expect.objectContaining({ title: 'NoPixel V | cops' }),
      expect.objectContaining({ title: 'FiveM RP night' }),
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterRoleplayStreams([stream('GTA Online'), stream('story mode')])).toEqual([]);
  });

  it('handles an empty pool', () => {
    expect(filterRoleplayStreams([])).toEqual([]);
  });
});
