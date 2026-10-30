/** Pure orchestration for the Twitch-powered sidebar refresh. */

import {
  fetchTopStreams,
  renderSidebarMarkdown,
  type TwitchDeps,
  type TwitchFetch,
} from '../lib/twitch.js';
import {
  refreshSidebarWidget,
  type SidebarWidgetAdd,
  type SidebarWidgetLike,
  type SidebarWidgetUpdate,
} from './sidebar.js';

export const TWITCH_GAME_ID = '32982';
export const TOP_STREAM_LIMIT = 10;
export const DEFAULT_WIDGET_SHORT_NAME = 'Top GTA RP Live Streams';
export const TWITCH_CLIENT_ID_SETTING = 'twitch-client-id';
export const TWITCH_CLIENT_SECRET_SETTING = 'twitch-client-secret';
export const WIDGET_SHORT_NAME_SETTING = 'sidebar-widget-short-name';
export const TWITCH_LANGUAGE_SETTING = 'twitch-language';

export interface SidebarSettings {
  get<T = string | number | boolean | string[] | undefined>(
    name: string
  ): Promise<T | undefined>;
}

export interface SidebarRefreshDeps {
  readonly settings: SidebarSettings;
  readonly fetch: TwitchFetch;
  readonly getToken: () => Promise<string | undefined>;
  readonly setToken: TwitchDeps['setToken'];
  readonly clearToken: TwitchDeps['clearToken'];
  readonly getWidgets: (subredditName: string) => Promise<readonly SidebarWidgetLike[]>;
  readonly addWidget: (widget: SidebarWidgetAdd) => Promise<unknown>;
  readonly updateWidget: (widget: SidebarWidgetUpdate) => Promise<unknown>;
  readonly now?: () => Date;
}

export interface SidebarConfigMissingOutcome {
  readonly status: 'config-missing';
  readonly missing: readonly ('client-id' | 'client-secret')[];
}

export interface SidebarRefreshSuccessOutcome {
  readonly status: 'updated' | 'created';
  readonly widgetShortName: string;
  readonly streamCount: number;
}

export type SidebarRefreshOutcome =
  | SidebarConfigMissingOutcome
  | SidebarRefreshSuccessOutcome;

function nonBlank(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function settingString(
  settings: SidebarSettings,
  name: string
): Promise<string | undefined> {
  const value = await settings.get<string>(name);
  return typeof value === 'string' ? value : undefined;
}

/** Fetch, render, and atomically hand the complete body to the widget seam. */
export async function runSidebarRefresh(
  deps: SidebarRefreshDeps,
  input: { readonly subredditName: string }
): Promise<SidebarRefreshOutcome> {
  const clientId = nonBlank(await settingString(deps.settings, TWITCH_CLIENT_ID_SETTING));
  const clientSecret = nonBlank(
    await settingString(deps.settings, TWITCH_CLIENT_SECRET_SETTING)
  );
  const missing: Array<'client-id' | 'client-secret'> = [];
  if (!clientId) missing.push('client-id');
  if (!clientSecret) missing.push('client-secret');
  if (missing.length > 0) return { status: 'config-missing', missing };

  const widgetSetting = await settingString(deps.settings, WIDGET_SHORT_NAME_SETTING);
  const language = nonBlank(await settingString(deps.settings, TWITCH_LANGUAGE_SETTING));
  const widgetShortName = widgetSetting?.trim() || DEFAULT_WIDGET_SHORT_NAME;
  const twitch: TwitchDeps = {
    fetch: deps.fetch,
    getToken: deps.getToken,
    setToken: deps.setToken,
    clearToken: deps.clearToken,
  };
  let streams;
  try {
    streams = await fetchTopStreams(twitch, {
      clientId,
      clientSecret,
      gameId: TWITCH_GAME_ID,
      language,
      limit: TOP_STREAM_LIMIT,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Twitch refresh failed for r/${input.subredditName}: ${detail}`);
  }
  const text = renderSidebarMarkdown(streams, {
    generatedAt: deps.now?.() ?? new Date(),
  });
  let widget;
  try {
    widget = await refreshSidebarWidget(
      {
        getWidgets: deps.getWidgets,
        addWidget: deps.addWidget,
        updateWidget: deps.updateWidget,
      },
      { subredditName: input.subredditName, widgetShortName, text }
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Sidebar widget refresh failed for r/${input.subredditName}: ${detail}`);
  }
  return {
    status: widget.status,
    widgetShortName,
    streamCount: streams.length,
  };
}
