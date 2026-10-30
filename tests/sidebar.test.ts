import { describe, expect, it } from 'vitest';

import {
  refreshSidebarWidget,
  type SidebarWidgetLike,
} from '../src/actions/sidebar.js';

function widget(overrides: Partial<SidebarWidgetLike>): SidebarWidgetLike {
  return { id: 'widget-1', name: 'Top GTA RP Live Streams', ...overrides };
}

describe('refreshSidebarWidget', () => {
  it('updates an existing textarea by short name and passes the exact text through', async () => {
    const updates: unknown[] = [];
    const text = '# exact\n[markdown]';
    const result = await refreshSidebarWidget(
      {
        getWidgets: async () => [widget({ text: 'old text' })],
        updateWidget: async (request) => {
          updates.push(request);
        },
        addWidget: async () => {
          throw new Error('should not add');
        },
      },
      { subredditName: 'rpclipsgta', widgetShortName: 'Top GTA RP Live Streams', text }
    );

    expect(result).toEqual({ status: 'updated', shortName: 'Top GTA RP Live Streams' });
    expect(updates).toEqual([
      {
        type: 'textarea',
        subreddit: 'rpclipsgta',
        id: 'widget-1',
        shortName: 'Top GTA RP Live Streams',
        text,
      },
    ]);
  });

  it('creates a textarea when no widget has the configured short name', async () => {
    const additions: unknown[] = [];
    const result = await refreshSidebarWidget(
      {
        getWidgets: async () => [widget({ name: 'Other widget', text: 'unrelated' })],
        updateWidget: async () => {
          throw new Error('should not update');
        },
        addWidget: async (request) => {
          additions.push(request);
        },
      },
      { subredditName: 'rpclipsgta', widgetShortName: 'Top GTA RP Live Streams', text: 'body' }
    );

    expect(result.status).toBe('created');
    expect(additions).toEqual([
      {
        type: 'textarea',
        subreddit: 'rpclipsgta',
        shortName: 'Top GTA RP Live Streams',
        text: 'body',
      },
    ]);
  });

  it('ignores non-textarea widgets and CustomWidget-shaped widgets', async () => {
    const additions: unknown[] = [];
    await refreshSidebarWidget(
      {
        getWidgets: async () => [
          widget({ name: 'Other widget', text: undefined }),
          widget({ name: 'Another widget', text: 'custom body', css: '.custom {}' }),
        ],
        updateWidget: async () => {
          throw new Error('should not update');
        },
        addWidget: async (request) => {
          additions.push(request);
        },
      },
      { subredditName: 'rpclipsgta', widgetShortName: 'Top GTA RP Live Streams', text: 'body' }
    );

    expect(additions).toHaveLength(1);
  });

  it('refuses to touch a colliding non-textarea widget', async () => {
    const updates: unknown[] = [];
    const additions: unknown[] = [];
    await expect(
      refreshSidebarWidget(
        {
          getWidgets: async () => [widget({ text: 'custom body', css: '.custom {}' })],
          updateWidget: async (request) => updates.push(request),
          addWidget: async (request) => additions.push(request),
        },
        { subredditName: 'rpclipsgta', widgetShortName: 'Top GTA RP Live Streams', text: 'body' }
      )
    ).rejects.toThrow('already used by a non-textarea');
    expect(updates).toEqual([]);
    expect(additions).toEqual([]);
  });
});
