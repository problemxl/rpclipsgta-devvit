/** Framework-free Twitch Helix client and sidebar Markdown renderer. */

export interface TwitchStream {
  readonly user_login: string;
  readonly user_name: string;
  readonly title: string;
  readonly viewer_count: number;
}

export interface TwitchToken {
  readonly access_token: string;
  readonly expires_in: number;
  readonly token_type: string;
}

export interface TwitchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type TwitchFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<TwitchResponse>;

export interface TwitchDeps {
  readonly fetch: TwitchFetch;
  readonly getToken: () => Promise<string | undefined>;
  readonly setToken: (token: TwitchToken) => Promise<void>;
  readonly clearToken: () => Promise<void>;
}

export interface FetchTopStreamsOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly gameId: string;
  readonly language?: string;
  readonly limit: number;
}

interface TwitchErrorBody {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly token_type?: unknown;
  readonly data?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly status?: unknown;
}

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const STREAMS_URL = 'https://api.twitch.tv/helix/streams';
const REQUEST_TIMEOUT_MS = 10_000;

function errorMessage(body: TwitchErrorBody, fallback: string): string {
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  if (typeof body.status === 'number') return `${fallback} (status ${body.status})`;
  return fallback;
}

async function readBody(response: TwitchResponse): Promise<TwitchErrorBody> {
  try {
    const body = await response.json();
    return body !== null && typeof body === 'object' ? (body as TwitchErrorBody) : {};
  } catch {
    return {};
  }
}

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function requestToken(
  deps: TwitchDeps,
  clientId: string,
  clientSecret: string
): Promise<TwitchToken> {
  const query = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
  });
  const response = await deps.fetch(`${TOKEN_URL}?${query.toString()}`, {
    method: 'POST',
    signal: timeoutSignal(),
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(
      `Twitch token request failed: ${errorMessage(body, `HTTP ${response.status}`)}`
    );
  }

  if (
    typeof body.access_token !== 'string' ||
    !body.access_token.trim() ||
    typeof body.expires_in !== 'number' ||
    typeof body.token_type !== 'string'
  ) {
    throw new Error('Twitch token response was missing required fields');
  }
  const token: TwitchToken = {
    access_token: body.access_token as string,
    expires_in: body.expires_in as number,
    token_type: body.token_type as string,
  };
  await deps.setToken(token);
  return token;
}

async function tokenForRequest(
  deps: TwitchDeps,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const cached = await deps.getToken();
  if (cached?.trim()) return cached;
  return (await requestToken(deps, clientId, clientSecret)).access_token;
}

async function requestStreams(
  deps: TwitchDeps,
  token: string,
  options: FetchTopStreamsOptions
): Promise<TwitchResponse> {
  const query = new URLSearchParams({
    game_id: options.gameId,
    first: String(options.limit),
  });
  if (options.language?.trim()) query.set('language', options.language.trim());
  return deps.fetch(`${STREAMS_URL}?${query.toString()}`, {
    headers: {
      'Client-Id': options.clientId,
      Authorization: `Bearer ${token}`,
    },
    signal: timeoutSignal(),
  });
}

/** Fetch the most-viewed streams, refreshing an expired token exactly once. */
export async function fetchTopStreams(
  deps: TwitchDeps,
  options: FetchTopStreamsOptions
): Promise<TwitchStream[]> {
  let token = await tokenForRequest(deps, options.clientId, options.clientSecret);
  let response = await requestStreams(deps, token, options);

  if (response.status === 401) {
    await deps.clearToken();
    token = (await requestToken(deps, options.clientId, options.clientSecret)).access_token;
    response = await requestStreams(deps, token, options);
  }

  const body = await readBody(response);
  if (!response.ok) {
    throw new Error(
      `Twitch streams request failed: ${errorMessage(body, `HTTP ${response.status}`)}`
    );
  }
  if (!Array.isArray((body as { data?: unknown }).data)) {
    throw new Error('Twitch streams response was missing data');
  }
  return (body as { data: TwitchStream[] }).data;
}

function plainText(value: string, maxLength: number): string {
  return value
    .replace(/[\[\]*_~`#>\\|]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

function displayName(stream: TwitchStream): string {
  return plainText(stream.user_name || stream.user_login, 80) || stream.user_login;
}

/** Render a compact, safe Markdown sidebar body. */
export function renderSidebarMarkdown(
  streams: readonly TwitchStream[],
  options: { readonly generatedAt: Date }
): string {
  const lines = ['## Top 10 GTA RP streamers on Twitch', ''];
  if (streams.length === 0) {
    lines.push('No GTA RP streams are live right now.');
  } else {
    streams.slice(0, 10).forEach((stream, index) => {
      const login = encodeURIComponent(stream.user_login);
      const title = plainText(stream.title, 60);
      const titleSuffix = title ? ` — ${title}` : '';
      lines.push(
        `${index + 1}. [${displayName(stream)}](https://twitch.tv/${login}) — ${stream.viewer_count.toLocaleString('en-US')} viewers${titleSuffix}`
      );
    });
  }
  const hours = String(options.generatedAt.getUTCHours()).padStart(2, '0');
  const minutes = String(options.generatedAt.getUTCMinutes()).padStart(2, '0');
  lines.push('', `*updated ${hours}:${minutes} UTC*`);
  return lines.join('\n');
}
