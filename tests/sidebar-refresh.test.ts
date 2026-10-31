import { describe, expect, it } from 'vitest';

import {
  runSidebarRefresh,
  TWITCH_CLIENT_ID_SETTING,
  TWITCH_CLIENT_SECRET_SETTING,
} from '../src/actions/sidebar-refresh.js';
import type { DescriptionDeps } from '../src/actions/description.js';
import type { TwitchResponse } from '../src/lib/twitch.js';

function response(status: number, body: unknown): TwitchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function base(settings: Record<string, string | undefined>, responses: TwitchResponse[]) {
  const calls: string[] = [];
  const writes: string[] = [];
  return {
    calls,
    writes,
    deps: {
      settings: { get: async <T>(name: string) => settings[name] as T | undefined },
      fetch: async (url: string) => {
        calls.push(`fetch:${url}`);
        const next = responses.shift();
        if (!next) throw new Error('unexpected fetch');
        return next;
      },
      getToken: async () => undefined,
      setToken: async () => undefined,
      clearToken: async () => undefined,
      getWidgets: async () => {
        calls.push('widgets');
        return [{ id: 'id', name: 'Top GTA RP Live Streams', text: 'old' }];
      },
      addWidget: async () => {
        writes.push('add');
      },
      updateWidget: async (request: { text: string }) => {
        writes.push(`update:${request.text}`);
      },
      now: () => new Date('2024-01-02T03:04:00Z'),
      description: undefined as DescriptionDeps | undefined,
    },
  };
}

describe('runSidebarRefresh', () => {
  it('returns config-missing without calling Twitch when credentials are blank', async () => {
    const d = base({ [TWITCH_CLIENT_ID_SETTING]: ' ', [TWITCH_CLIENT_SECRET_SETTING]: '' }, []);
    await expect(runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' })).resolves.toEqual({
      status: 'config-missing',
      missing: ['client-id', 'client-secret'],
    });
    expect(d.calls).toEqual([]);
    expect(d.writes).toEqual([]);
  });

  it('wires fetch, render, and widget update in order', async () => {
    const d = base(
      { [TWITCH_CLIENT_ID_SETTING]: 'id', [TWITCH_CLIENT_SECRET_SETTING]: 'secret' },
      [
        response(200, { access_token: 'token', expires_in: 3600, token_type: 'bearer' }),
        response(200, {
          data: [
            { user_login: 'rp', user_name: 'RP', title: 'Live', viewer_count: 12 },
          ],
        }),
      ]
    );
    await expect(runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' })).resolves.toMatchObject({
      status: 'updated',
      streamCount: 1,
    });
    expect(d.calls[0]).toMatch(/^fetch:/);
    expect(d.calls[1]).toMatch(/^fetch:/);
    expect(d.calls[2]).toBe('widgets');
    expect(d.writes[0]).toContain('update:## Top 10 GTA RP streamers on Twitch');
    expect(d.writes[0]).toContain('updated 03:04 UTC');
  });

  it('propagates Twitch failures without touching widgets', async () => {
    const d = base(
      { [TWITCH_CLIENT_ID_SETTING]: 'id', [TWITCH_CLIENT_SECRET_SETTING]: 'secret' },
      [response(500, { message: 'Twitch is unavailable' })]
    );
    await expect(runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' })).rejects.toThrow(
      'Twitch is unavailable'
    );
    expect(d.calls).toEqual(['fetch:https://id.twitch.tv/oauth2/token?client_id=id&client_secret=secret&grant_type=client_credentials']);
    expect(d.writes).toEqual([]);
  });

  it('also refreshes the old-Reddit description block when the seam is present', async () => {
    const d = base(
      { [TWITCH_CLIENT_ID_SETTING]: 'id', [TWITCH_CLIENT_SECRET_SETTING]: 'secret' },
      [
        response(200, { access_token: 'token', expires_in: 3600, token_type: 'bearer' }),
        response(200, {
          data: [
            { user_login: 'rp', user_name: 'RP', title: 'Live', viewer_count: 12 },
          ],
        }),
      ]
    );
    const descriptionWrites: string[] = [];
    d.deps.description = {
      getDescription: async () =>
        `Welcome.\n[](#top-streamers-start)\n| stale |\n[](#top-streamers-end)\nBye.`,
      setDescription: async (_name: string, next: string) => {
        descriptionWrites.push(next);
      },
    };
    const outcome = await runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' });
    expect(outcome).toMatchObject({ status: 'updated', streamCount: 1, description: 'updated' });
    expect(descriptionWrites).toHaveLength(1);
    expect(descriptionWrites[0]).toContain('[](#top-streamers-start)');
    // Description block uses compact bare-link rows (the derived
    // public_description has a hard 500-char cap), not the widget's table.
    expect(descriptionWrites[0]).toContain('1. https://twitch.tv/rp — 12');
    expect(descriptionWrites[0]).not.toContain('| [RP](');
    expect(descriptionWrites[0]).toContain('Welcome.');
    expect(descriptionWrites[0]).toContain('Bye.');
    expect(descriptionWrites[0]).not.toContain('stale');
  });

  it('reports missing-markers and never writes the description without both markers', async () => {
    const d = base(
      { [TWITCH_CLIENT_ID_SETTING]: 'id', [TWITCH_CLIENT_SECRET_SETTING]: 'secret' },
      [
        response(200, { access_token: 'token', expires_in: 3600, token_type: 'bearer' }),
        response(200, {
          data: [
            { user_login: 'rp', user_name: 'RP', title: 'Live', viewer_count: 12 },
          ],
        }),
      ]
    );
    const descriptionWrites: string[] = [];
    d.deps.description = {
      getDescription: async () => 'No markers here at all.',
      setDescription: async (_name: string, next: string) => {
        descriptionWrites.push(next);
      },
    };
    const outcome = await runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' });
    expect(outcome).toMatchObject({ status: 'updated', description: 'missing-markers' });
    expect(descriptionWrites).toHaveLength(0);
    // Widget still updated: one surface failing to opt in never blocks the other.
    expect(d.writes[0]).toContain('update:## Top 10 GTA RP streamers on Twitch');
  });

  it('surfaces description write failures as errors that name the surface', async () => {
    const d = base(
      { [TWITCH_CLIENT_ID_SETTING]: 'id', [TWITCH_CLIENT_SECRET_SETTING]: 'secret' },
      [
        response(200, { access_token: 'token', expires_in: 3600, token_type: 'bearer' }),
        response(200, {
          data: [
            { user_login: 'rp', user_name: 'RP', title: 'Live', viewer_count: 12 },
          ],
        }),
      ]
    );
    d.deps.description = {
      getDescription: async () => '[](#top-streamers-start)\nx\n[](#top-streamers-end)',
      setDescription: async () => {
        throw new Error('reddit write denied');
      },
    };
    await expect(runSidebarRefresh(d.deps, { subredditName: 'rpclipsgta' })).rejects.toThrow(
      'Sidebar description refresh failed for r/rpclipsgta: reddit write denied'
    );
  });
});
