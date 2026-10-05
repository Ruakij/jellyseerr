import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import type { AxiosInstance } from 'axios';

import RadarrAPI from '@server/api/servarr/radarr';

function buildRadarr(): RadarrAPI {
  return new RadarrAPI({ url: 'http://localhost:7878/api/v3', apiKey: 'test' });
}

function getAxios(radarr: RadarrAPI): AxiosInstance {
  return (radarr as unknown as { axios: AxiosInstance }).axios;
}

describe('RadarrAPI removeMovie', () => {
  afterEach(() => mock.restoreAll());

  it('removes the movie when it exists in the library', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await radarr.removeMovie(550);

    assert.strictEqual(del.mock.callCount(), 1);
    assert.strictEqual(del.mock.calls[0].arguments[0], '/movie/7');
  });

  it('does nothing when the movie is not in the library', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 0, title: 'Fight Club' }],
    }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.doesNotReject(() => radarr.removeMovie(550));
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('rejects when the tmdbId is unknown to the lookup', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(() => radarr.removeMovie(550), /Movie not found/);
    assert.strictEqual(del.mock.callCount(), 0);
  });

  it('ignores a 404 when the movie was already removed in Radarr', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 404 } };
    });

    await assert.doesNotReject(() => radarr.removeMovie(550));
  });

  it('rethrows errors other than 404', async () => {
    const radarr = buildRadarr();
    mock.method(RadarrAPI.prototype, 'getMovieByTmdbId', async () => ({
      id: 7,
      title: 'Test Movie',
    }));
    mock.method(getAxios(radarr), 'delete', async () => {
      throw { response: { status: 500 } };
    });

    await assert.rejects(() => radarr.removeMovie(550));
  });

  it('rethrows a 404 from the lookup instead of treating it as removed', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 404 } };
    });
    const del = mock.method(getAxios(radarr), 'delete', async () => ({}));

    await assert.rejects(
      () => radarr.removeMovie(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 404
    );
    assert.strictEqual(del.mock.callCount(), 0);
  });
});

describe('RadarrAPI getMovieByTmdbId', () => {
  afterEach(() => mock.restoreAll());

  it('rethrows a 401 from the lookup with the status intact', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => {
      throw { response: { status: 401 } };
    });

    await assert.rejects(
      () => radarr.getMovieByTmdbId(550),
      (e: unknown) =>
        (e as { response?: { status?: number } }).response?.status === 401
    );
  });

  it('throws "Movie not found" when the lookup returns no results', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({ data: [] }));

    await assert.rejects(() => radarr.getMovieByTmdbId(550), {
      message: 'Movie not found',
    });
  });
});

describe('ServarrBase getHistory', () => {
  afterEach(() => mock.restoreAll());

  it('requests a page sorted by date with the numeric event type', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: { records: [{ id: 1 }] },
    }));

    const records = await radarr.getHistory({ eventType: 'grabbed' });

    assert.deepEqual(records, [{ id: 1 }]);
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/history',
      {
        params: {
          page: 1,
          pageSize: 200,
          sortKey: 'date',
          sortDirection: 'descending',
          eventType: 1,
          includeEpisode: true,
        },
      },
    ]);
  });

  it('pages back until a record is older than since', async () => {
    const radarr = buildRadarr();
    const pages = [
      [
        { id: 1, date: '2026-10-05T12:00:00Z' },
        { id: 2, date: '2026-10-05T11:00:00Z' },
      ],
      [
        { id: 3, date: '2026-10-05T10:00:00Z' },
        { id: 4, date: '2026-10-04T10:00:00Z' },
      ],
    ];
    const get = mock.method(
      getAxios(radarr),
      'get',
      async (_: string, { params }: { params: { page: number } }) => ({
        data: { totalRecords: 600, records: pages[params.page - 1] },
      })
    );

    const records = await radarr.getHistory({
      eventType: 'grabbed',
      since: new Date('2026-10-05T00:00:00Z'),
    });

    assert.deepEqual(
      records.map((r) => r.id),
      [1, 2, 3]
    );
    assert.equal(get.mock.callCount(), 2);
    assert.deepEqual(get.mock.calls[1].arguments, [
      '/history',
      {
        params: {
          page: 2,
          pageSize: 250,
          sortKey: 'date',
          sortDirection: 'descending',
          eventType: 1,
          includeEpisode: true,
        },
      },
    ]);
  });

  it('stops paging at the limit or the last page', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: {
        totalRecords: 3,
        records: [1, 2, 3].map((id) => ({ id, date: '2026-10-05T12:00:00Z' })),
      },
    }));
    const since = new Date('2026-10-05T00:00:00Z');

    assert.equal((await radarr.getHistory({ since, limit: 2 })).length, 2);
    assert.equal((await radarr.getHistory({ since })).length, 3);
    assert.equal(get.mock.callCount(), 2);
  });
});

describe('ServarrBase getItemHistory', () => {
  afterEach(() => mock.restoreAll());

  it('requests the history of one movie', async () => {
    const radarr = buildRadarr();
    const get = mock.method(getAxios(radarr), 'get', async () => ({
      data: [{ id: 1 }],
    }));

    assert.deepEqual(await radarr.getItemHistory(42), [{ id: 1 }]);
    assert.deepEqual(get.mock.calls[0].arguments, [
      '/history/movie',
      { params: { movieId: 42, includeEpisode: true } },
    ]);
  });
});

describe('RadarrAPI monitorMovie', () => {
  afterEach(() => mock.restoreAll());

  it('sets an unmonitored movie to monitored', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: { id: 42, monitored: false },
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.monitorMovie(42);

    assert.deepEqual(put.mock.calls[0].arguments, [
      '/movie',
      { id: 42, monitored: true },
    ]);
  });

  it('leaves a monitored movie alone', async () => {
    const radarr = buildRadarr();
    mock.method(getAxios(radarr), 'get', async () => ({
      data: { id: 42, monitored: true },
    }));
    const put = mock.method(getAxios(radarr), 'put', async () => ({}));

    await radarr.monitorMovie(42);

    assert.equal(put.mock.callCount(), 0);
  });
});
