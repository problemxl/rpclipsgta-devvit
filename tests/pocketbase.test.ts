import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  countModActions,
  createModAction,
  FetchLike,
  ModActionFields,
  pbLogin,
} from '../src/lib/pocketbase.js';

const BASE = 'https://pb.example.com';
const TOKEN = 'test-auth-token';

/** A configurable fetch mock recording calls and returning queued responses. */
function makeFetchMock(status = 200, body: unknown = {}): { calls: string[]; fetch: FetchLike } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetch: fetchImpl };
}

describe('pbLogin', () => {
  it('posts credentials to the superusers auth endpoint and returns the token', async () => {
    const { calls, fetch } = makeFetchMock(200, { token: 'pb-token-123', record: { id: 'abc' } });

    const token = await pbLogin(fetch, BASE, 'mod@example.com', 'hunter2');

    expect(token).toBe('pb-token-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      `POST ${BASE}/api/collections/_superusers/auth-with-password ` +
        JSON.stringify({ identity: 'mod@example.com', password: 'hunter2' })
    );
  });

  it('throws with the status on non-2xx responses', async () => {
    const { fetch } = makeFetchMock(401, { code: 401, message: 'Failed to authenticate.' });

    await expect(pbLogin(fetch, BASE, 'mod@example.com', 'wrong')).rejects.toThrow(/401/);
  });

  it('throws when the response has no token', async () => {
    const { fetch } = makeFetchMock(200, {});

    await expect(pbLogin(fetch, BASE, 'mod@example.com', 'hunter2')).rejects.toThrow(/token/i);
  });
});

describe('countModActions', () => {
  it('GETs the records endpoint with a URL-encoded filter and returns totalItems', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url, init });
      return new Response(JSON.stringify({ page: 1, totalItems: 7, items: [] }), { status: 200 });
    };

    const count = await countModActions(fetchImpl, BASE, TOKEN, 'spammer99');

    expect(count).toBe(7);
    expect(captured).toHaveLength(1);
    const { url, init } = captured[0];
    expect(url.startsWith(`${BASE}/api/collections/mod_actions/records?`)).toBe(true);
    const query = new URL(url).searchParams;
    expect(query.get('perPage')).toBe('1');
    expect(query.get('filter')).toBe(`(target_user='spammer99')`);
    expect(decodeURIComponent(url)).toContain(`(target_user='spammer99')`);
    expect(url).toContain(encodeURIComponent(`(target_user='spammer99')`));
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe(TOKEN);
  });

  it('URL-encodes special characters in the target username', async () => {
    const captured: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      captured.push(url);
      return new Response(JSON.stringify({ totalItems: 0, items: [] }), { status: 200 });
    };

    await countModActions(fetchImpl, BASE, TOKEN, `weird'name`);

    expect(captured[0]).toContain(encodeURIComponent(`(target_user='weird'name')`));
  });

  it('throws with the status on non-2xx responses', async () => {
    const { fetch } = makeFetchMock(403, {});

    await expect(countModActions(fetch, BASE, TOKEN, 'spammer99')).rejects.toThrow(/403/);
  });
});

describe('createModAction', () => {
  const fields: ModActionFields = {
    action: 'ban',
    rule: 2,
    duration_days: 3,
    target_user: 'spammer99',
    mod_user: 'realmod',
    command_comment_id: 't1_abc123',
    thing_id: 't3_def456',
    permalink: '/r/RPClipsGTA/comments/def456/some_post/',
    reason: 'Toxicity in chat',
    rule_name: 'Toxicity',
    action_date: '2025-01-01T00:00:00.000Z',
    source: 'menu',
    source_ref: 'Mod action',
    reddit_post_id: 't3_def456',
    reddit_comment_id: '',
  };

  it('POSTs the exact payload to the records endpoint with the auth header', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url, init });
      return new Response(JSON.stringify({ id: 'rec1' }), { status: 200 });
    };

    await createModAction(fetchImpl, BASE, TOKEN, fields);

    expect(captured).toHaveLength(1);
    const { url, init } = captured[0];
    expect(url).toBe(`${BASE}/api/collections/mod_actions/records`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe(TOKEN);
    expect(JSON.parse(init?.body as string)).toEqual(fields);
  });

  it('throws with the status on non-2xx responses', async () => {
    const { fetch } = makeFetchMock(400, { code: 400, message: 'Validation error.' });

    await expect(createModAction(fetch, BASE, TOKEN, fields)).rejects.toThrow(/400/);
  });
});
