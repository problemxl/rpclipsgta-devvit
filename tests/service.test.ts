import { describe, expect, it } from 'vitest';

import { callEscalate, EscalatePayload, EscalateResult, FetchLike } from '../src/lib/service.js';

const BASE = 'https://escalate.example.com';
const TOKEN = 'shared-secret-token';

const PAYLOAD: EscalatePayload = {
  target_user: 'spammer99',
  target_id: 't1_xyz789',
  rule: 2,
  reason: 'toxic chat',
  mod_user: 'realmod',
};

const RESULT: EscalateResult = {
  action: 'ban',
  duration_days: 7,
  label: '7 day ban',
  comment_id: '',
  priors: 2,
  rule_name: 'Toxicity',
  recorded: true,
};

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

describe('callEscalate', () => {
  it('POSTs the exact payload to /devvit/escalate with the token + json headers', async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      captured.push({ url, init });
      return new Response(JSON.stringify(RESULT), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await callEscalate(fetchImpl, BASE, TOKEN, PAYLOAD);

    expect(captured).toHaveLength(1);
    const { url, init } = captured[0];
    expect(url).toBe(`${BASE}/devvit/escalate`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Escalate-Token']).toBe(TOKEN);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(PAYLOAD);
  });

  it('trims trailing slashes off the base URL', async () => {
    const captured: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      captured.push(url);
      return new Response(JSON.stringify(RESULT), { status: 200 });
    };

    await callEscalate(fetchImpl, `${BASE}/`, TOKEN, PAYLOAD);

    expect(captured[0]).toBe(`${BASE}/devvit/escalate`);
  });

  it('parses the full success response', async () => {
    const warnResult: EscalateResult = {
      action: 'warn',
      duration_days: 0,
      label: 'Warning',
      comment_id: 't1_abc123',
      priors: 0,
      rule_name: 'Toxicity',
      recorded: true,
    };
    const { fetch } = makeFetchMock(200, warnResult);

    const result = await callEscalate(fetch, BASE, TOKEN, PAYLOAD);

    expect(result).toEqual(warnResult);
  });

  it('propagates a 401 with the service detail', async () => {
    const { fetch } = makeFetchMock(401, { detail: 'invalid escalation token' });

    await expect(callEscalate(fetch, BASE, TOKEN, PAYLOAD)).rejects.toThrow(
      /401.*invalid escalation token/
    );
  });

  it('propagates a 400 with the service detail', async () => {
    const { fetch } = makeFetchMock(400, { detail: 'unknown rule: 99' });

    await expect(callEscalate(fetch, BASE, 'wrong-token', PAYLOAD)).rejects.toThrow(
      /400.*unknown rule: 99/
    );
  });

  it('throws with the status even when the error body is not JSON', async () => {
    const fetchImpl: FetchLike = async () =>
      new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      });

    await expect(callEscalate(fetchImpl, BASE, TOKEN, PAYLOAD)).rejects.toThrow(
      /Escalation service returned 500/
    );
  });
});
