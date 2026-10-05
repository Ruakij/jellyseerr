import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSignalRMessage, retryDelayMs } from '@server/api/servarr/signalr';

describe('parseSignalRMessage', () => {
  it('parses a Radarr movie search command', () => {
    assert.deepStrictEqual(
      parseSignalRMessage({
        name: 'command',
        body: {
          action: 'updated',
          resource: {
            id: 42,
            name: 'MoviesSearch',
            commandName: 'Movies Search',
            status: 'completed',
            result: 'successful',
            message: 'Completed',
            body: { movieIds: [7], sendUpdatesToClient: true },
          },
        },
      }),
      {
        type: 'command',
        id: 42,
        name: 'MoviesSearch',
        status: 'completed',
        result: 'successful',
        message: 'Completed',
        movieIds: [7],
        seriesId: undefined,
        seasonNumber: undefined,
        episodeIds: undefined,
      }
    );
  });

  it('parses a Sonarr season search command', () => {
    const event = parseSignalRMessage({
      name: 'command',
      body: {
        action: 'updated',
        resource: {
          id: 3,
          name: 'SeasonSearch',
          status: 'started',
          body: { seriesId: 12, seasonNumber: 2 },
        },
      },
    });
    assert.equal(event?.type, 'command');
    assert.equal(event.type === 'command' && event.seriesId, 12);
    assert.equal(event.type === 'command' && event.seasonNumber, 2);
  });

  it('ignores non-search commands and unknown statuses', () => {
    const cmd = (name: string, status: string) => ({
      name: 'command',
      body: { action: 'updated', resource: { id: 1, name, status } },
    });
    assert.equal(
      parseSignalRMessage(cmd('RefreshMonitoredDownloads', 'started')),
      undefined
    );
    assert.equal(parseSignalRMessage(cmd('MoviesSearch', 'weird')), undefined);
  });

  it('maps all queue messages to a queue event', () => {
    for (const name of ['queue', 'queue/status', 'queue/details']) {
      assert.deepStrictEqual(
        parseSignalRMessage({ name, body: { action: 'sync' } }),
        { type: 'queue' }
      );
    }
  });

  it('parses movie, series and file changes', () => {
    assert.deepStrictEqual(
      parseSignalRMessage({
        name: 'movie',
        body: { action: 'updated', resource: { id: 7, tmdbId: 550 } },
      }),
      { type: 'movie', action: 'updated', id: 7, tmdbId: 550 }
    );
    assert.deepStrictEqual(
      parseSignalRMessage({
        name: 'series',
        body: { action: 'deleted', resource: { id: 12 } },
      }),
      { type: 'series', action: 'deleted', id: 12, tvdbId: undefined }
    );
    assert.deepStrictEqual(
      parseSignalRMessage({
        name: 'moviefile',
        body: { action: 'updated', resource: { id: 9, movieId: 7 } },
      }),
      { type: 'movieFile', action: 'updated', id: 9, movieId: 7 }
    );
    assert.deepStrictEqual(
      parseSignalRMessage({
        name: 'episodefile',
        body: {
          action: 'deleted',
          resource: { id: 5, seriesId: 12, seasonNumber: 1 },
        },
      }),
      {
        type: 'episodeFile',
        action: 'deleted',
        id: 5,
        seriesId: 12,
        seasonNumber: 1,
      }
    );
  });

  it('never throws on unexpected shapes', () => {
    const inputs: unknown[] = [
      undefined,
      null,
      42,
      'movie',
      [],
      { name: 'health', body: { action: 'sync' } },
      { name: 'movie' },
      { name: 'movie', body: null },
      { name: 'movie', body: { action: 'sync', resource: { id: 1 } } },
      { name: 'movie', body: { action: 'updated', resource: { id: '1' } } },
      { name: 'command', body: { resource: { id: 1, body: 'x' } } },
      {
        name: 'command',
        body: {
          resource: {
            id: 1,
            name: 'MoviesSearch',
            status: 'started',
            body: { movieIds: ['a'] },
          },
        },
      },
    ];
    for (const input of inputs.slice(0, -1)) {
      assert.equal(parseSignalRMessage(input), undefined);
    }
    const last = parseSignalRMessage(inputs.at(-1));
    assert.equal(last?.type === 'command' && last.movieIds, undefined);
  });
});

describe('retryDelayMs', () => {
  it('backs off exponentially up to a minute', () => {
    assert.equal(retryDelayMs(0), 1000);
    assert.equal(retryDelayMs(3), 8000);
    assert.equal(retryDelayMs(20), 60_000);
  });
});
