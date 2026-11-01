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
  isCrosspostableSubreddit: true,
  disableContributorRequests: true,
  freeFormReports: true,
  headerTitle: 'Header',
  keyColor: '#123456',
  originalContentTagEnabled: true,
  hideAds: true,
  showMedia: true,
  showMediaPreview: true,
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

  it.each(['link', 'self', 'other'] as const)(
    'passes the Reddit submission type %s through verbatim', (submissionType) => {
      const request = buildDescriptionOnlyRequest({ ...ABOUT, submissionType }, 'd');
      expect(request.linkType).toBe(submissionType);
    }
  );

  it('carries About-sourced settings so nothing else changes', () => {
    const request = buildDescriptionOnlyRequest(ABOUT, 'd');
    expect(request.acceptFollowers).toBe(true);
    expect(request.allowDiscovery).toBe(false);
    expect(request.allowImages).toBe(true);
    expect(request.restrictPosting).toBe(false);
    expect(request.spoilersEnabled).toBe(true);
    expect(request.commentScoreHideMins).toBe(7);
    expect(request.collapseDeletedComments).toBe(true);
    expect(request.allowPostCrossposts).toBe(true);
    expect(request.disableContributorRequests).toBe(true);
    expect(request.freeFormReports).toBe(true);
    expect(request.headerTitle).toBe('Header');
    expect(request.keyColor).toBe('#123456');
    expect(request.originalContentTagEnabled).toBe(true);
    expect(request.hideAds).toBe(true);
    expect(request.showMedia).toBe(true);
    expect(request.showMediaPreview).toBe(true);
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

  it('rejects an About payload with no publicDescription instead of clearing it', () => {
    expect(() =>
      buildDescriptionOnlyRequest({ ...ABOUT, publicDescription: undefined }, 'd')
    ).toThrow('missing publicDescription');
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

  it('prefixes SiteAdmin failures as description writes', async () => {
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
    ).rejects.toThrow('[description-write] SiteAdmin failed for r/testsub: reddit denied');
  });

  it('prefixes About failures as description reads', async () => {
    const plugin: RawSubredditsPlugin = {
      SubredditAbout: async () => {
        throw new Error('reddit read denied');
      },
      SiteAdmin: async () => ({}),
    };
    await expect(readSubredditDescription({ subreddits: plugin }, 'testsub')).rejects.toThrow(
      '[description-read] SubredditAbout failed for r/testsub: reddit read denied'
    );
  });

  it('forwards the supplied metadata to both raw plugin calls', async () => {
    const metadata = { actor: 'ambient-request' };
    const calls: unknown[] = [];
    const plugin: RawSubredditsPlugin = {
      SubredditAbout: async (_request, receivedMetadata) => {
        calls.push(receivedMetadata);
        return { data: ABOUT };
      },
      SiteAdmin: async (_request, receivedMetadata) => {
        calls.push(receivedMetadata);
      },
    };
    await readSubredditDescription({ subreddits: plugin, metadata }, 'testsub');
    await writeSubredditDescription(
      { subreddits: plugin, metadata },
      { subredditName: 'testsub', description: 'd' }
    );
    expect(calls).toEqual([metadata, metadata, metadata]);
  });
});
