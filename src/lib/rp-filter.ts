/**
 * Heuristic GTA RP classification for Twitch stream titles.
 *
 * Twitch has no GTA Roleplay category: RP streams live under "Grand Theft
 * Auto V" (game_id 32982) alongside GTA Online and story mode streams. The
 * distinguishing signal is the stream title — RP streamers conventionally
 * name their server or platform (NoPixel, FiveM, GTA World, "WL", "RP", …),
 * which is also the technique the Twitch dev community uses to find RP
 * servers by title.
 *
 * Policy is a strict whitelist: a stream is roleplay only when its title
 * carries an RP marker. Unmarked titles are excluded — for a sidebar
 * labeled "Top 10 GTA RP streamers", a false positive (GTA Online grinder)
 * is worse than a false negative (an RP streamer who omits every marker),
 * and the top of the GTA V category is dominated by marked RP streams, so
 * the pool stays full in practice.
 */

import type { TwitchStream } from './twitch.js';

/**
 * Title markers that identify a GTA RP stream. Checked first and case
 * insensitively; any single match classifies the stream as roleplay.
 */
const RP_TITLE_PATTERNS: readonly RegExp[] = [
  // Generic roleplay markers.
  /\brp\b/i, // "GTA RP", "RP server", "serious rp"
  /role\s?-?play/i, // "roleplay", "role-play", "role play"
  /wlrp|uwrp/i, // one-word server families ("WLRP")
  /whitelisted|\bwl\b/i, // whitelisted servers; "WL"
  // Servers and platforms.
  /no\s?pixel/i, // NoPixel, "Nopixel V"
  /\bnp\b/i, // NP — NoPixel shorthand
  /fivem|five\s?m\b/i, // FiveM mod platform (not "five minute")
  /rage\s?mp|ragemp/i, // RAGE MP platform
  /gta\s?world|gta:?w\b/i, // GTA World / GTA:W
  /eclipse\s?rp/i, // Eclipse RP (bare "eclipse" is a GTA street name)
  /mafia\s?city/i,
  /legacy\s?rp/i,
  /new\s?day\s?rp/i,
  /purple\s?rp/i,
  /\bdoj\b/i, // DOJ servers
];

/** True when the title carries a GTA RP marker. */
export function isRoleplayTitle(title: string): boolean {
  return RP_TITLE_PATTERNS.some((pattern) => pattern.test(title));
}

/**
 * The RP subset of a viewer-sorted stream list, order (and therefore viewer
 * ranking) preserved.
 */
export function filterRoleplayStreams(
  streams: readonly TwitchStream[]
): TwitchStream[] {
  return streams.filter((stream) => isRoleplayTitle(stream.title));
}
