import { describe, expect, it } from 'vitest';

import {
  fetchTopStreams,
  renderSidebarMarkdown,
  type TwitchFetch,
  type TwitchResponse,
  type TwitchToken,
} from '../src/lib/twitch.js';

function response(status: number, body: unknown): TwitchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function deps(
  responses: TwitchResponse[],
  cachedToken?: string
) {
  const calls: Array<{
    url: string;
    init?: Parameters<TwitchFetch>[1];
  }> = [];
  let token = cachedToken;
  const saved: TwitchToken[] = [];
  let cleared = 0;
  return {
    calls,
    saved,
    get cleared() {
      return cleared;
    },
    getToken: async () => token,
    setToken: async (next: TwitchToken) => {
      saved.push(next);
      token = next.access_token;
    },
    clearToken: async () => {
      cleared += 1;
      token = undefined;
    },
    fetch: async (
      url: string,
      init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
    ) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    },
  };
}

const stream = {
  user_login: 'rp_streamer',
  user_name: 'RP Streamer',
  title: 'Late night GTA RP',
  viewer_count: 12345,
};

describe('fetchTopStreams', () => {
  it('fetches a token and the top streams with the expected query and headers', async () => {
    const d = deps([
      response(200, { access_token: 'fresh-token', expires_in: 3600, token_type: 'bearer' }),
      response(200, { data: [stream] }),
    ]);

    await expect(
      fetchTopStreams(d, {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        gameId: '32982',
        language: 'en',
        limit: 10,
      })
    ).resolves.toEqual([stream]);

    expect(d.calls[0].url).toContain('https://id.twitch.tv/oauth2/token');
    expect(d.calls[0].url).toContain('client_id=client-id');
    expect(d.calls[0].url).toContain('client_secret=client-secret');
    expect(d.calls[0].url).toContain('grant_type=client_credentials');
    expect(d.calls[1].url).toContain('https://api.twitch.tv/helix/streams');
    expect(d.calls[1].url).toContain('game_id=32982');
    expect(d.calls[1].url).toContain('first=10');
    expect(d.calls[1].url).toContain('language=en');
    expect(d.calls[0].init?.method).toBe('POST');
    expect(d.calls[1].init?.headers).toEqual({
      'Client-Id': 'client-id',
      Authorization: 'Bearer fresh-token',
    });
    expect(d.saved[0].access_token).toBe('fresh-token');
  });

  it('refreshes a cached token once after a 401 and retries the streams request', async () => {
    const d = deps([
      response(401, { message: 'token expired' }),
      response(200, { access_token: 'replacement', expires_in: 3600, token_type: 'bearer' }),
      response(200, { data: [stream] }),
    ], 'stale-token');

    await expect(
      fetchTopStreams(d, {
        clientId: 'id',
        clientSecret: 'secret',
        gameId: '32982',
        limit: 10,
      })
    ).resolves.toEqual([stream]);

    expect(d.cleared).toBe(1);
    expect(d.calls).toHaveLength(3);
    expect(d.saved[0].access_token).toBe('replacement');
  });

  it('surfaces a non-success token API message', async () => {
    const d = deps([
      response(400, { error: 'invalid_client', message: 'Client authentication failed' }),
    ]);

    await expect(
      fetchTopStreams(d, {
        clientId: 'id',
        clientSecret: 'secret',
        gameId: '32982',
        limit: 10,
      })
    ).rejects.toThrow('Client authentication failed');
  });

  it('surfaces a non-success streams API message', async () => {
    const d = deps([
      response(200, { access_token: 'token', expires_in: 3600, token_type: 'bearer' }),
      response(503, { error: 'service_unavailable', message: 'Streams are unavailable' }),
    ]);

    await expect(
      fetchTopStreams(d, {
        clientId: 'id',
        clientSecret: 'secret',
        gameId: '32982',
        limit: 10,
      })
    ).rejects.toThrow('Streams are unavailable');
  });
});

describe('renderSidebarMarkdown', () => {
  it('renders ranks, login-based links, sanitized capped titles, viewer counts, and a UTC footer', () => {
    const text = renderSidebarMarkdown(
      [
        {
          ...stream,
          title: '  A [bad] *title*_with~markdown and a very long title that goes beyond sixty characters  ',
        },
        {
          user_login: 'second_login',
          user_name: 'Second Name',
          title: 'Second stream',
          viewer_count: 7,
        },
      ],
      { generatedAt: new Date('2024-01-02T03:04:00Z') }
    );

    expect(text).toContain('## Top 10 GTA RP streamers on Twitch');
    expect(text).toContain('1. [RP Streamer](https://twitch.tv/rp_streamer)');
    expect(text).toContain('2. [Second Name](https://twitch.tv/second_login)');
    expect(text).toContain('12,345 viewers');
    expect(text).toContain('7 viewers');
    expect(text).not.toContain('[bad]');
    expect(text).not.toContain('*title*');
    expect(text).toContain('updated 03:04 UTC');
    const titleLine = text.split('\n').find((line: string) => line.startsWith('1. ')) ?? '';
    expect(titleLine.length).toBeLessThan(180);
    const renderedTitle = titleLine.split(' — ').slice(2).join(' — ');
    expect(renderedTitle).not.toMatch(/[\[\]*_~]/);
  });

  it('renders a useful empty-list message and footer', () => {
    const text = renderSidebarMarkdown([], { generatedAt: new Date('2024-01-02T03:04:00Z') });
    expect(text).toContain('No GTA RP streams are live right now.');
    expect(text).toContain('updated 03:04 UTC');
  });
});
