/**
 * Framework-free old-Reddit sidebar description block management.
 *
 * Old Reddit renders the subreddit description as its sidebar; textarea
 * widgets do not exist there. The app maintains a marker-delimited block
 * inside the description and replaces only the text between the markers, so
 * moderator-written description content is preserved byte-for-byte.
 *
 * If the markers are absent the description is never written: a moderator
 * must add the two marker lines once via Community Settings.
 */

/** Invisible anchor that opens the app-managed description block. */
export const DESCRIPTION_START_MARKER = '[](#top-streamers-start)';

/** Invisible anchor that closes the app-managed description block. */
export const DESCRIPTION_END_MARKER = '[](#top-streamers-end)';

export type DescriptionSplice =
  | { readonly status: 'missing-markers' }
  | {
      readonly status: 'replaced';
      /** The full next description, including untouched surrounding text. */
      readonly description: string;
      /** False when the splice produced byte-identical output (no write needed). */
      readonly changed: boolean;
    };

export interface DescriptionDeps {
  getDescription(subredditName: string): Promise<string | undefined>;
  setDescription(subredditName: string, description: string): Promise<void>;
}

export type DescriptionRefreshStatus = 'updated' | 'unchanged' | 'missing-markers';

/**
 * Splice `block` between the markers in `current`.
 *
 * Everything outside the markers — including all other moderator content — is
 * copied through unchanged. A missing start or end marker is a no-op signal,
 * never an implicit write.
 */
export function spliceDescriptionBlock(current: string, block: string): DescriptionSplice {
  const start = current.indexOf(DESCRIPTION_START_MARKER);
  if (start < 0) return { status: 'missing-markers' };
  const end = current.indexOf(DESCRIPTION_END_MARKER, start + DESCRIPTION_START_MARKER.length);
  if (end < 0) return { status: 'missing-markers' };
  const before = current.slice(0, start);
  const after = current.slice(end + DESCRIPTION_END_MARKER.length);
  const next = `${before}${DESCRIPTION_START_MARKER}\n${block.trim()}\n${DESCRIPTION_END_MARKER}${after}`;
  return { status: 'replaced', description: next, changed: next !== current };
}

/**
 * Refresh the marker block in the subreddit description. Errors from the
 * Reddit client propagate to the caller; marker absence and no-op splices are
 * reported as statuses instead.
 */
export async function refreshDescriptionBlock(
  deps: DescriptionDeps,
  input: { readonly subredditName: string; readonly block: string }
): Promise<DescriptionRefreshStatus> {
  const current = (await deps.getDescription(input.subredditName)) ?? '';
  const splice = spliceDescriptionBlock(current, input.block);
  if (splice.status === 'missing-markers') return 'missing-markers';
  if (!splice.changed) return 'unchanged';
  await deps.setDescription(input.subredditName, splice.description);
  return 'updated';
}
