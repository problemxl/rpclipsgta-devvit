import { describe, expect, it } from 'vitest';

import {
  FIXTURE_SOURCE_SUBREDDIT,
  FIXTURE_TARGETS,
  FixtureInputError,
  buildFixturePost,
  createFixture,
  fixtureTargetFromSelection,
  isAllowedFixtureSourceSubreddit,
  isAuthorizedFixtureActor,
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
  let value: string | undefined = initial ? '{"status":"created"}' : undefined;
  const calls: Array<{ key: string; value: string; nx?: boolean }> = [];
  return {
    calls,
    async get() {
      return value;
    },
    async set(
      key: string,
      next: string,
      options?: { nx?: boolean; xx?: boolean; expiration?: Date }
    ) {
      calls.push({ key, value: next, nx: options?.nx });
      if (options?.nx && claimed) return '';
      claimed = true;
      value = next;
      return 'OK';
    },
    async del() {
      claimed = false;
      value = undefined;
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

  it('allows only the production subreddit as a fixture source', () => {
    expect(isAllowedFixtureSourceSubreddit(FIXTURE_SOURCE_SUBREDDIT)).toBe(true);
    expect(isAllowedFixtureSourceSubreddit('S17Cjn21GT')).toBe(false);
  });

  it('checks moderator membership instead of trusting a username', async () => {
    const calls: unknown[] = [];
    const reddit = {
      getModerators(options: unknown) {
        calls.push(options);
        return { all: async () => [] };
      },
      getUserByUsername: async () => ({ isAdmin: false }),
    };
    await expect(
      isAuthorizedFixtureActor(reddit, 'rpclipsgta', 'not-a-mod')
    ).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('fails closed when moderator lookup errors', async () => {
    const reddit = {
      getModerators: () => ({ all: async () => { throw new Error('lookup failed'); } }),
      getUserByUsername: async () => undefined,
    };
    await expect(isAuthorizedFixtureActor(reddit, 'rpclipsgta', 'mod')).resolves.toBe(false);
  });

  it('accepts an explicitly returned moderator', async () => {
    const reddit = {
      getModerators: () => ({ all: async () => [{}] }),
      getUserByUsername: async () => undefined,
    };
    await expect(
      isAuthorizedFixtureActor(reddit, 'rpclipsgta', 'mod')
    ).resolves.toBe(true);
  });

  it('recognizes Twitch and Kick clip URLs but not Reddit or arbitrary links', () => {
    expect(isClipUrl('https://clips.twitch.tv/OriginalClip')).toBe(true);
    expect(isClipUrl('https://clips.twitch.tv/embed?clip=OriginalClip')).toBe(true);
    expect(isClipUrl('https://www.twitch.tv/channel/clip/OriginalClip')).toBe(true);
    expect(isClipUrl('https://kick.com/channel/clips/clip_01ABC')).toBe(true);
    expect(isClipUrl('https://kick.com/channel?clip=clip_01ABC')).toBe(true);
    expect(isClipUrl('https://kick.com.evil.example/channel/clips/clip_01ABC')).toBe(
      false
    );
    expect(isClipUrl('https://reddit.com/r/rpclipsgta/comments/source123/')).toBe(false);
    expect(isClipUrl('https://example.com/clip.mp4')).toBe(false);
  });

  it('preserves the original clip URL and includes source traceability in a bounded title', () => {
    const post = buildFixturePost(SOURCE, FIXTURE_TARGETS[0]);

    expect(post.url).toBe(SOURCE.url);
    expect(post.title).toContain('[DEV FIXTURE]');
    expect(post.title).toContain('source:t3_source123');
    expect(post.title.length).toBeLessThanOrEqual(300);
    expect(post.title).toContain(SOURCE.permalink);
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

  it('rejects malformed source traceability data', () => {
    expect(() =>
      buildFixturePost({ ...SOURCE, id: 'source123' }, FIXTURE_TARGETS[0])
    ).toThrow('invalid Reddit traceability');
    expect(() =>
      buildFixturePost({ ...SOURCE, permalink: 'https://example.com/source123' }, FIXTURE_TARGETS[0])
    ).toThrow('invalid Reddit traceability');
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
    const reddit = {
      async submitPost(options: unknown) {
        submitted.push(options);
        return {
          id: 't3_fixture123',
          permalink: '/r/S17Cjn21GT/comments/fixture123/',
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
    expect(second.created).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.record?.status).toBe('created');
    expect(second.record?.fixturePostId).toBe('t3_fixture123');
    expect(store.calls.some((call) => call.value.includes('"status":"created"'))).toBe(
      true
    );
    expect(submitted).toHaveLength(1);
  });

  it('fails closed for a malformed SET NX reply before submitting', async () => {
    const store = makeStore();
    store.set = async () => 'YES' as never;
    const submitted: unknown[] = [];

    const result = await createFixture({
      source: SOURCE,
      target: FIXTURE_TARGETS[0],
      actor: 'ModUser',
      reddit: {
        async submitPost(options: unknown) {
          submitted.push(options);
          return { id: 't3_never' };
        },
      },
      dedupe: store,
    });

    expect(result).toMatchObject({ created: false, duplicate: true });
    expect(submitted).toEqual([]);
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
    expect(store.calls[0].nx).toBe(true);
    expect(store.calls).toHaveLength(1);
    expect(await store.get()).toBeUndefined();

    const retrySubmitted: unknown[] = [];
    await expect(
      createFixture({
        source: SOURCE,
        target: FIXTURE_TARGETS[1],
        actor: 'ModUser',
        reddit: {
          async submitPost(options: unknown) {
            retrySubmitted.push(options);
            return { id: 't3_retry' };
          },
        },
        dedupe: store,
      })
    ).resolves.toMatchObject({ created: true });
    expect(retrySubmitted).toHaveLength(1);
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
