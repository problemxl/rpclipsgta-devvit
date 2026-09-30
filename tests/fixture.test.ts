import { describe, expect, it } from 'vitest';

import {
  FIXTURE_TARGETS,
  FixtureInputError,
  buildFixturePost,
  createFixture,
  fixtureTargetFromSelection,
  isClipUrl,
  requireFixtureActor,
} from '../src/actions/fixture.js';

const SOURCE = {
  id: 't3_source123',
  title: 'A clip worth testing',
  url: 'https://clips.twitch.tv/OriginalClip',
  permalink: '/r/rpclipsgta/comments/source123/a_clip_worth_testing/',
};

function makeStore(initial = false) {
  let claimed = initial;
  const calls: Array<{ key: string; value: string; nx?: boolean }> = [];
  return {
    calls,
    async set(key: string, value: string, options?: { nx?: boolean }) {
      calls.push({ key, value, nx: options?.nx });
      if (options?.nx && claimed) return '';
      claimed = true;
      return 'OK';
    },
    async del() {
      claimed = false;
    },
  };
}

describe('fixture target and input validation', () => {
  it('exposes exactly the dev and QA targets', () => {
    expect(FIXTURE_TARGETS.map((target) => target.subreddit)).toEqual([
      'S17Cjn21GT',
      'rpclipsgta_mod_dev',
    ]);
  });

  it('accepts one configured target and rejects arbitrary or multi-select values', () => {
    expect(fixtureTargetFromSelection(['dev'])?.subreddit).toBe('S17Cjn21GT');
    expect(fixtureTargetFromSelection(['qa'])?.subreddit).toBe('rpclipsgta_mod_dev');
    expect(fixtureTargetFromSelection(['prod'])).toBeUndefined();
    expect(fixtureTargetFromSelection(['dev', 'qa'])).toBeUndefined();
    expect(fixtureTargetFromSelection([])).toBeUndefined();
  });

  it('requires an acting moderator identity', () => {
    expect(() => requireFixtureActor(undefined)).toThrow('acting moderator');
    expect(requireFixtureActor('  ModUser ')).toBe('ModUser');
  });

  it('recognizes Twitch and Kick clip URLs but not Reddit or arbitrary links', () => {
    expect(isClipUrl('https://clips.twitch.tv/OriginalClip')).toBe(true);
    expect(isClipUrl('https://clips.twitch.tv/embed?clip=OriginalClip')).toBe(true);
    expect(isClipUrl('https://www.twitch.tv/channel/clip/OriginalClip')).toBe(true);
    expect(isClipUrl('https://kick.com/channel/clips/clip_01ABC')).toBe(true);
    expect(isClipUrl('https://reddit.com/r/rpclipsgta/comments/source123/')).toBe(false);
    expect(isClipUrl('https://example.com/clip.mp4')).toBe(false);
  });

  it('preserves the original clip URL and includes source traceability in a bounded title', () => {
    const post = buildFixturePost(SOURCE, FIXTURE_TARGETS[0]);

    expect(post.url).toBe(SOURCE.url);
    expect(post.title).toContain('[DEV FIXTURE]');
    expect(post.title).toContain('source:t3_source123');
    expect(post.title.length).toBeLessThanOrEqual(300);
    expect(post.subredditName).toBe('S17Cjn21GT');
  });

  it('rejects a target object outside the allowlist', () => {
    expect(() =>
      buildFixturePost(SOURCE, {
        ...FIXTURE_TARGETS[0],
        subreddit: 'rpclipsgta',
      } as unknown as typeof FIXTURE_TARGETS[number])
    ).toThrow('not an allowed test subreddit');
  });

  it('reports missing source URLs and non-clip URLs clearly', () => {
    expect(() => buildFixturePost({ ...SOURCE, url: '' }, FIXTURE_TARGETS[0])).toThrow(
      'does not contain a Twitch or Kick clip URL'
    );
    expect(() =>
      buildFixturePost(
        { ...SOURCE, url: 'https://example.com/not-a-clip' },
        FIXTURE_TARGETS[0]
      )
    ).toThrow(FixtureInputError);
  });
});

describe('createFixture', () => {
  it('deduplicates a repeated source and target without submitting again', async () => {
    const store = makeStore();
    const submitted: unknown[] = [];
    const edited: Array<{ text: string }> = [];
    const reddit = {
      async submitPost(options: unknown) {
        submitted.push(options);
        return {
          id: 't3_fixture123',
          permalink: '/r/S17Cjn21GT/comments/fixture123/',
          async edit(options: { text: string }) {
            edited.push(options);
          },
        };
      },
    };

    const first = await createFixture({
      source: SOURCE,
      target: FIXTURE_TARGETS[0],
      actor: 'ModUser',
      reddit,
      dedupe: store,
    });
    const second = await createFixture({
      source: SOURCE,
      target: FIXTURE_TARGETS[0],
      actor: 'ModUser',
      reddit,
      dedupe: store,
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, duplicate: true });
    expect(submitted).toHaveLength(1);
    expect(edited[0].text).toContain('t3_source123');
    expect(edited[0].text).toContain(SOURCE.permalink);
  });

  it('releases the dedupe claim when Reddit submission fails', async () => {
    const store = makeStore();
    const reddit = {
      async submitPost() {
        throw new Error('Reddit rejected the post');
      },
    };

    await expect(
      createFixture({
        source: SOURCE,
        target: FIXTURE_TARGETS[1],
        actor: 'ModUser',
        reddit,
        dedupe: store,
      })
    ).rejects.toThrow('Reddit rejected the post');
    expect(store.calls).toHaveLength(1);
    expect(store.calls[0].nx).toBe(true);
  });

  it('rejects missing authorization before touching Reddit or dedupe state', async () => {
    const store = makeStore();
    const reddit = { submitPost: async () => ({ id: 't3_never' }) };

    await expect(
      createFixture({
        source: SOURCE,
        target: FIXTURE_TARGETS[0],
        actor: '',
        reddit,
        dedupe: store,
      })
    ).rejects.toThrow('acting moderator');
    expect(store.calls).toHaveLength(0);
  });
});
