import { describe, expect, it } from 'vitest';

import {
  DESCRIPTION_END_MARKER,
  DESCRIPTION_START_MARKER,
  refreshDescriptionBlock,
  spliceDescriptionBlock,
} from '../src/actions/description.js';

const AROUND = 'Welcome to the subreddit!\n\nRead the rules below.\n';

function withMarkers(block: string): string {
  return `${AROUND}${DESCRIPTION_START_MARKER}\n${block}\n${DESCRIPTION_END_MARKER}\n\nMore mod text.`;
}

describe('spliceDescriptionBlock', () => {
  it('replaces only the marked block and preserves surrounding text byte-for-byte', () => {
    const current = withMarkers('| old table |');
    const splice = spliceDescriptionBlock(current, '| new table |');
    expect(splice.status).toBe('replaced');
    if (splice.status !== 'replaced') return;
    expect(splice.description).toContain('| new table |');
    expect(splice.description).not.toContain('old table');
    expect(splice.description.startsWith(AROUND)).toBe(true);
    expect(splice.description.endsWith('\n\nMore mod text.')).toBe(true);
    expect(splice.changed).toBe(true);
  });

  it('trims the replacement block so marker lines stay on their own lines', () => {
    const splice = spliceDescriptionBlock(withMarkers('x'), '  | padded |  ');
    expect(splice.status).toBe('replaced');
    if (splice.status !== 'replaced') return;
    expect(splice.description).toContain(`${DESCRIPTION_START_MARKER}\n| padded |\n${DESCRIPTION_END_MARKER}`);
  });

  it('reports unchanged when the splice output is byte-identical', () => {
    const current = withMarkers('| same table |');
    const splice = spliceDescriptionBlock(current, '| same table |');
    expect(splice.status).toBe('replaced');
    if (splice.status !== 'replaced') return;
    expect(splice.changed).toBe(false);
    expect(splice.description).toBe(current);
  });

  it('is a no-op signal when the start marker is missing', () => {
    expect(spliceDescriptionBlock(AROUND, '| t |').status).toBe('missing-markers');
  });

  it('is a no-op signal when only the end marker is missing', () => {
    const current = `${AROUND}${DESCRIPTION_START_MARKER}\n| t |`;
    expect(spliceDescriptionBlock(current, '| t |').status).toBe('missing-markers');
  });

  it('ignores marker text that appears after a missing real end marker', () => {
    const current = `${DESCRIPTION_START_MARKER}\n| t |\n${DESCRIPTION_END_MARKER} copy ${DESCRIPTION_END_MARKER}`;
    const splice = spliceDescriptionBlock(current, '| t |');
    expect(splice.status).toBe('replaced');
    if (splice.status !== 'replaced') return;
    expect(splice.description.endsWith(`${DESCRIPTION_END_MARKER} copy ${DESCRIPTION_END_MARKER}`)).toBe(true);
  });
});

describe('refreshDescriptionBlock', () => {
  function makeDeps(initial: string | undefined) {
    let value = initial;
    const writes: string[] = [];
    return {
      writes,
      getDescription: async () => value,
      setDescription: async (_name: string, description: string) => {
        writes.push(description);
        value = description;
      },
    };
  }

  it('writes the spliced description once and reports updated', async () => {
    const deps = makeDeps(withMarkers('| old |'));
    const status = await refreshDescriptionBlock(deps, {
      subredditName: 's17cjn21gt',
      block: '| new |',
    });
    expect(status).toBe('updated');
    expect(deps.writes).toHaveLength(1);
    expect(deps.writes[0]).toContain('| new |');
  });

  it('skips the write entirely when the splice is unchanged', async () => {
    const deps = makeDeps(withMarkers('| same |'));
    const status = await refreshDescriptionBlock(deps, {
      subredditName: 's17cjn21gt',
      block: '| same |',
    });
    expect(status).toBe('unchanged');
    expect(deps.writes).toHaveLength(0);
  });

  it('never writes when markers are missing', async () => {
    const deps = makeDeps(AROUND);
    const status = await refreshDescriptionBlock(deps, {
      subredditName: 's17cjn21gt',
      block: '| t |',
    });
    expect(status).toBe('missing-markers');
    expect(deps.writes).toHaveLength(0);
  });

  it('treats an undefined description as marker-missing, not empty-string write', async () => {
    const deps = makeDeps(undefined);
    const status = await refreshDescriptionBlock(deps, {
      subredditName: 's17cjn21gt',
      block: '| t |',
    });
    expect(status).toBe('missing-markers');
    expect(deps.writes).toHaveLength(0);
  });

  it('propagates Reddit client errors instead of swallowing them', async () => {
    const status = refreshDescriptionBlock(
      {
        getDescription: async () => {
          throw new Error('boom');
        },
        setDescription: async () => undefined,
      },
      { subredditName: 's17cjn21gt', block: '| t |' }
    );
    await expect(status).rejects.toThrow('boom');
  });
});
