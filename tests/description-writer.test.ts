import { describe, expect, it } from 'vitest';

import {
  buildDescriptionOnlyRequest,
  readSubredditDescription,
  writeSubredditDescription,
  type RawSubredditsPlugin,
  type SubredditAboutData,
} from '../src/actions/description-writer.js';

const ABOUT: SubredditAboutData = {
  id: 't5_testsub',
  displayName: 'TestSub',
  title: 'A test subreddit',
  subredditType: 'public',
  over18: false,
  submissionType: 'any',
  description: '[](#top-streamers-start)\n| stale |\n[](#top-streamers-end)',
  publicDescription: 'Existing short blurb under 500 chars.',
  acceptFollowers: true,
  allowDiscovery: false,
  allowImages: true,
  restrictPosting: false,
  spoilersEnabled: true,
  commentScoreHideMins: 7,
  collapseDeletedComments: true,
};

function makePlugin(about: SubredditAboutData = ABOUT) {
  const siteAdminRequests: Array<Record<string, unknown>> = [];
  const plugin: RawSubredditsPlugin = {
    SubredditAbout: async (request) => {
      expect(request).toEqual({ subreddit: 'testsub' });
      return { data: about };
    },
    SiteAdmin: async (request) => {
      siteAdminRequests.push(request);
      return {};
    },
  };
  return { plugin, siteAdminRequests };
}

describe('buildDescriptionOnlyRequest', () => {
  it('passes the existing publicDescription through byte-for-byte', () => {
    const request = buildDescriptionOnlyRequest(ABOUT, 'new description');
    expect(request.publicDescription).toBe(ABOUT.publicDescription);
    expect(request.description).toBe('new description');
  });

  it('sources identity fields from the About payload', () => {
    const request = buildDescriptionOnlyRequest(ABOUT, 'd');
    expect(request.sr).toBe('t5_testsub');
    expect(request.name).toBe('TestSub');
    expect(request.title).toBe('A test subreddit');
    expect(request.type).toBe('public');
    expect(request.over18).toBe(false);
    expect(request.linkType).toBe('any');
  });

  it('carries About-sourced settings so nothing else changes', () => {
    const request = buildDescriptionOnlyRequest(ABOUT, 'd');
    expect(request.acceptFollowers).toBe(true);
    expect(request.allowDiscovery).toBe(false);
    expect(request.allowImages).toBe(true);
    expect(request.restrictPosting).toBe(false);
    expect(request.spoilersEnabled).toBe(true);
    expect(request.commentScoreHideMins).toBe(7);
    expect(request.collapseDeletedComments).toBe(true);
  });

  it('normalizes an unknown submission type instead of passing it through', () => {
    const request = buildDescriptionOnlyRequest(
      { ...ABOUT, submissionType: 'bogus' },
      'd'
    );
    expect(request.linkType).toBe('any');
  });

  it('falls back to the display name when title is missing', () => {
    const request = buildDescriptionOnlyRequest({ ...ABOUT, title: undefined }, 'd');
    expect(request.title).toBe('TestSub');
  });

  it('rejects an About payload without id or displayName', () => {
    expect(() => buildDescriptionOnlyRequest({ ...ABOUT, id: undefined }, 'd')).toThrow(
      'missing id or displayName'
    );
    expect(() =>
      buildDescriptionOnlyRequest({ ...ABOUT, displayName: undefined }, 'd')
    ).toThrow('missing id or displayName');
  });

  it('keeps an empty string publicDescription when About has none', () => {
    const request = buildDescriptionOnlyRequest(
      { ...ABOUT, publicDescription: undefined },
      'd'
    );
    expect(request.publicDescription).toBe('');
  });
});

describe('readSubredditDescription', () => {
  it('returns the About description', async () => {
    const { plugin } = makePlugin();
    await expect(readSubredditDescription({ subreddits: plugin }, 'testsub')).resolves.toBe(
      ABOUT.description
    );
  });

  it('returns undefined when the payload has no description', async () => {
    const { plugin } = makePlugin({ ...ABOUT, description: undefined });
    await expect(readSubredditDescription({ subreddits: plugin }, 'testsub')).resolves.toBe(
      undefined
    );
  });
});

describe('writeSubredditDescription', () => {
  it('issues exactly one SiteAdmin request built from live About data', async () => {
    const { plugin, siteAdminRequests } = makePlugin();
    await writeSubredditDescription(
      { subreddits: plugin },
      { subredditName: 'testsub', description: 'next description' }
    );
    expect(siteAdminRequests).toHaveLength(1);
    expect(siteAdminRequests[0].description).toBe('next description');
    expect(siteAdminRequests[0].publicDescription).toBe(ABOUT.publicDescription);
  });

  it('propagates a missing About payload as an error', async () => {
    const plugin: RawSubredditsPlugin = {
      SubredditAbout: async () => ({ data: undefined }),
      SiteAdmin: async () => ({}),
    };
    await expect(
      writeSubredditDescription(
        { subreddits: plugin },
        { subredditName: 'testsub', description: 'd' }
      )
    ).rejects.toThrow('About response missing data');
  });

  it('propagates SiteAdmin failures', async () => {
    const plugin: RawSubredditsPlugin = {
      SubredditAbout: async () => ({ data: ABOUT }),
      SiteAdmin: async () => {
        throw new Error('reddit denied');
      },
    };
    await expect(
      writeSubredditDescription(
        { subreddits: plugin },
        { subredditName: 'testsub', description: 'd' }
      )
    ).rejects.toThrow('reddit denied');
  });
});
