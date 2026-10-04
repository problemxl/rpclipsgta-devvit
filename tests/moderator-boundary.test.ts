import { describe, expect, it, vi } from 'vitest';

import { runAuthorizedModeratorAction } from '../src/actions/moderator-boundary.js';

function reddit(listing: readonly unknown[] | Error) {
  return {
    getModerators: vi.fn(() => ({
      all: async () => {
        if (listing instanceof Error) throw listing;
        return listing;
      },
    })),
  };
}

describe('moderator authorization boundary', () => {
  it('runs the action only after a positive membership lookup', async () => {
    const client = reddit([{}]);
    const action = vi.fn(async () => 'executed');

    await expect(
      runAuthorizedModeratorAction(client, ' TargetSub ', ' ModUser ', action)
    ).resolves.toEqual({ authorized: true, result: 'executed' });
    expect(client.getModerators).toHaveBeenCalledWith({
      subredditName: 'TargetSub',
      username: 'ModUser',
      limit: 1,
      pageSize: 1,
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a non-moderator before any destructive seam', async () => {
    const client = reddit([]);
    const action = vi.fn(async () => 'must-not-run');

    await expect(
      runAuthorizedModeratorAction(client, 'TargetSub', 'ModUser', action)
    ).resolves.toEqual({ authorized: false });
    expect(action).not.toHaveBeenCalled();
  });

  it('fails closed when the Reddit membership lookup errors', async () => {
    const client = reddit(new Error('Reddit unavailable'));
    const action = vi.fn(async () => 'must-not-run');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        runAuthorizedModeratorAction(client, 'TargetSub', 'ModUser', action)
      ).resolves.toEqual({ authorized: false });
      expect(action).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('does not authorize missing actor or target subreddit', async () => {
    const client = reddit([{}]);
    const action = vi.fn(async () => 'must-not-run');

    await expect(runAuthorizedModeratorAction(client, '', 'ModUser', action)).resolves.toEqual({
      authorized: false,
    });
    await expect(runAuthorizedModeratorAction(client, 'TargetSub', undefined, action)).resolves.toEqual({
      authorized: false,
    });
    expect(client.getModerators).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
