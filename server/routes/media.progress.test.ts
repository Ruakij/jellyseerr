import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { get, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, mock } from 'node:test';

import ServarrBase from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RequestProgressRun } from '@server/entity/RequestProgressRun';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Permission } from '@server/lib/permissions';
import { storeRun } from '@server/lib/requestProgress/history';
import progressTracker from '@server/lib/requestProgress/tracker';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import mediaRoutes from './media';

setupTestDb();

// Stands in for the session middleware: the user id comes from the X-User header.
function testApp() {
  const app = express();
  app.use(async (req, _res, next) => {
    const id = Number(req.headers['x-user']);
    if (id) {
      req.user = await getRepository(User).findOneByOrFail({ id });
    }
    next();
  });
  app.use('/media', mediaRoutes);
  app.use(
    (
      err: { status: number },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => res.status(err.status).end()
  );
  return app;
}

async function openStream(path: string, user?: number) {
  const server = testApp().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const req = get(`http://127.0.0.1:${port}${path}`, {
    headers: user ? { 'x-user': String(user) } : {},
  });
  const [res] = (await once(req, 'response')) as [IncomingMessage];
  res.setEncoding('utf8');
  const events: string[] = [];
  res.on('data', (chunk: string) =>
    events.push(...chunk.split('\n\n').filter((e) => e.startsWith('event:')))
  );
  const next = async () => {
    while (events.length === 0) await once(res, 'data');
    return events.shift()!;
  };
  const close = async () => {
    req.destroy();
    server.close();
    await once(server, 'close');
  };
  return { res, next, close };
}

const parse = (chunk: string) => {
  const [event, data] = chunk.trim().split('\n');
  assert.equal(event, 'event: progress');
  return JSON.parse(data.slice('data: '.length));
};

describe('GET /media/:mediaId/progress', () => {
  it('streams the current state and every change, and detaches on close', async () => {
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const listeners = progressTracker.listenerCount('change');
    const stream = await openStream(`/media/${media.id}/progress?is4k=false`);
    assert.equal(stream.res.headers['content-type'], 'text/event-stream');
    assert.equal(stream.res.headers['x-accel-buffering'], 'no');

    const initial = parse(await stream.next());
    assert.equal(initial.mediaId, media.id);
    assert.deepEqual(
      initial.steps.map((s: { status: string }) => s.status),
      ['pending', 'pending', 'pending', 'pending', 'pending', 'done']
    );

    progressTracker.start({ mediaId: media.id, is4k: true });
    progressTracker.start({ mediaId: media.id, is4k: false, requestId: 3 });
    const update = parse(await stream.next());
    assert.equal(update.is4k, false);
    assert.deepEqual(
      update.requests.map((r: { id: number }) => r.id),
      [3]
    );

    await stream.close();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(progressTracker.listenerCount('change'), listeners);
  });

  it('reconstructs a request the tracker never saw from Radarr', async () => {
    const requestedAt = Date.parse('2026-10-05T10:00:00Z');
    for (const [name, impl] of [
      [
        'getItemHistory',
        async () => [
          {
            id: 1,
            date: '2026-10-05T09:00:00Z',
            eventType: 'grabbed',
            downloadId: 'OLD',
            movieId: 42,
            sourceTitle: 'Old',
            data: {},
          },
          {
            id: 2,
            date: '2026-10-05T10:05:00Z',
            eventType: 'grabbed',
            downloadId: 'D',
            movieId: 42,
            sourceTitle: 'Movie.2026.1080p',
            data: {},
          },
        ],
      ],
      ['getQueue', async () => []],
      ['getMovie', async () => ({ hasFile: false })],
    ] as const) {
      Object.defineProperty(RadarrAPI.prototype, name, {
        set() {},
        get: () => impl,
        configurable: true,
      });
    }
    mock.method(MediaRequest, 'sendNotification', async () => undefined);
    getSettings().radarr = [
      { id: 0, name: 'Radarr', hostname: 'localhost', port: 7878, apiKey: 'k' },
    ] as RadarrSettings[];
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    // The database restarts its ids per test, the global tracker keeps the entries of media 1.
    await getRepository(Media).save(
      Object.assign(new Media(), { tmdbId: 3, mediaType: MediaType.MOVIE })
    );
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 2,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 42,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: user,
        modifiedBy: user,
        createdAt: new Date(requestedAt),
      })
    );

    assert.equal(progressTracker.entry(media.id, false), undefined);
    const stream = await openStream(`/media/${media.id}/progress?is4k=false`);
    let progress = parse(await stream.next());
    while (
      !progress.steps.find((s: { key: string }) => s.key === 'grabbed').detail
    ) {
      progress = parse(await stream.next());
    }
    await stream.close();

    const step = (key: string) =>
      progress.steps.find((s: { key: string }) => s.key === key);
    assert.equal(
      step('requested').startedAt,
      new Date(requestedAt).toISOString()
    );
    assert.equal(step('searching').finishedAt, '2026-10-05T10:05:00.000Z');
    assert.equal(step('grabbed').detail, 'Movie.2026.1080p');
    assert.equal(step('grabbed').status, 'running');
  });

  it('falls back to the stored final run of a request', async () => {
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    // Above the ids of the global tracker entries of the other tests.
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        id: 50,
        tmdbId: 8,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      })
    );
    const request = (createdAt: string) =>
      getRepository(MediaRequest).save(
        new MediaRequest({
          type: MediaType.MOVIE,
          status: MediaRequestStatus.COMPLETED,
          media,
          requestedBy: user,
          modifiedBy: user,
          createdAt: new Date(createdAt),
        })
      );
    const first = await request('2026-10-01T10:00:00Z');
    const second = await request('2026-10-03T10:00:00Z');
    const run = (requestId: number, at: string) =>
      storeRun(
        {
          mediaId: media.id,
          is4k: false,
          requests: [{ id: requestId, step: 'playable', status: 'done' }],
          steps: [],
          estimatePercentile: 90,
          finishedAt: at,
        },
        [requestId]
      );
    await run(first.id, '2026-10-01T12:00:00.000Z');
    await run(first.id, '2026-10-02T12:00:00.000Z');
    await run(second.id, '2026-10-04T12:00:00.000Z');
    assert.equal(await getRepository(RequestProgressRun).count(), 2);

    const fetch = async (query: string) => {
      const stream = await openStream(
        `/media/${media.id}/progress?is4k=false${query}`,
        user.id
      );
      const progress = parse(await stream.next());
      await stream.close();
      return progress;
    };
    const latest = await fetch('');
    assert.equal(latest.finishedAt, '2026-10-04T12:00:00.000Z');
    assert.equal(latest.search.allowed, false);
    const older = await fetch(`&requestId=${first.id}`);
    assert.equal(older.finishedAt, '2026-10-02T12:00:00.000Z');
    assert.equal(older.requests[0].id, first.id);

    const loaded = await getRepository(Media).findOneOrFail({
      where: { id: media.id },
      relations: { requests: true },
    });
    assert.ok(loaded.requests.every((r) => r.hasProgressRun === true));
  });

  it('returns 404 for unknown media', async () => {
    const app = express();
    app.use('/media', mediaRoutes);
    app.use(
      (
        err: { status: number },
        _req: express.Request,
        res: express.Response,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _next: express.NextFunction
      ) => res.status(err.status).end()
    );
    const server = app.listen(0);
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const [res] = (await once(
      get(`http://127.0.0.1:${port}/media/999/progress`),
      'response'
    )) as [IncomingMessage];
    assert.equal(res.statusCode, 404);
    res.resume();
    server.close();
  });
});

async function postSearch(mediaId: number, user: number) {
  const server = testApp().listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const req = httpRequest(
    `http://127.0.0.1:${port}/media/${mediaId}/progress/search?is4k=false`,
    { method: 'POST', headers: { 'x-user': String(user) } }
  );
  req.end();
  const [res] = (await once(req, 'response')) as [IncomingMessage];
  res.resume();
  server.close();
  return res;
}

describe('POST /media/:mediaId/progress/search', () => {
  it('lets managers search any time, REQUEST_SEARCH once per cooldown and nobody else', async () => {
    getSettings().radarr = [
      { id: 0, name: 'Radarr', hostname: 'localhost', port: 7878, apiKey: 'k' },
    ] as RadarrSettings[];
    const commands = mock.method(
      ServarrBase.prototype,
      'runCommand',
      async () => undefined
    );
    const monitor = mock.method(
      RadarrAPI.prototype,
      'monitorMovie',
      async () => undefined
    );
    const users = getRepository(User);
    const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
    const user = (name: string, permissions: number) =>
      users.save(
        Object.assign(new User(), {
          email: `${name}@seerr.dev`,
          username: name,
          avatar: '',
          permissions,
        })
      );
    const searcher = await user(
      'searcher',
      Permission.REQUEST | Permission.REQUEST_SEARCH
    );
    const manager = await user('manager', Permission.MANAGE_REQUESTS);
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 4,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 42,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: friend,
        modifiedBy: friend,
      })
    );

    assert.equal((await postSearch(media.id, friend.id)).statusCode, 403);
    assert.equal((await postSearch(media.id, searcher.id)).statusCode, 204);
    assert.deepEqual(commands.mock.calls[0].arguments, [
      'MoviesSearch',
      { movieIds: [42] },
    ]);
    assert.deepEqual(monitor.mock.calls[0].arguments, [42]);
    const limited = await postSearch(media.id, searcher.id);
    assert.equal(limited.statusCode, 429);
    const retryAfter = Number(limited.headers['retry-after']);
    assert.ok(retryAfter > 890 && retryAfter <= 900, String(retryAfter));
    assert.equal((await postSearch(media.id, manager.id)).statusCode, 204);
    assert.equal((await postSearch(media.id, manager.id)).statusCode, 204);
    assert.equal((await postSearch(media.id, 1)).statusCode, 204);
    assert.equal(commands.mock.callCount(), 4);

    const searchFor = async (id: number) => {
      const stream = await openStream(
        `/media/${media.id}/progress?is4k=false`,
        id
      );
      const { search } = parse(await stream.next());
      await stream.close();
      return search;
    };
    const limitedSearch = await searchFor(searcher.id);
    assert.equal(limitedSearch.allowed, true);
    assert.ok(Date.parse(limitedSearch.retryAfter) > Date.now());
    const managerSearch = await searchFor(manager.id);
    assert.equal(managerSearch.allowed, true);
    assert.equal(managerSearch.retryAfter, undefined);
    assert.equal(managerSearch.running, false);
    progressTracker.start({ mediaId: media.id, is4k: false });
    progressTracker.setSearch(media.id, false, { searchCommandId: 7 });
    assert.equal((await searchFor(manager.id)).running, true);
    assert.equal((await searchFor(friend.id)).allowed, false);
    commands.mock.restore();
    monitor.mock.restore();
  });

  it('searches whole seasons without files and the missing aired episodes', async () => {
    getSettings().sonarr = [
      { id: 0, name: 'Sonarr', hostname: 'localhost', port: 8989, apiKey: 'k' },
    ] as SonarrSettings[];
    const commands = mock.method(
      ServarrBase.prototype,
      'runCommand',
      async () => undefined
    );
    const aired = '2026-01-01T00:00:00Z';
    const episode = (
      id: number,
      seasonNumber: number,
      hasFile: boolean,
      airDateUtc = aired
    ) => ({ id, seasonNumber, hasFile, airDateUtc });
    const episodes = mock.method(
      SonarrAPI.prototype,
      'getEpisodes',
      async () => [
        episode(1, 1, false),
        episode(2, 1, false),
        episode(3, 2, true),
        episode(4, 2, false),
        episode(5, 2, false, '2099-01-01T00:00:00Z'),
        episode(6, 3, false),
      ]
    );
    const monitor = mock.method(
      SonarrAPI.prototype,
      'monitorSeasons',
      async () => undefined
    );
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 5,
        tvdbId: 6,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 34,
      })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: admin,
        modifiedBy: admin,
        seasons: [1, 2].map(
          (seasonNumber) => new SeasonRequest({ seasonNumber })
        ),
      })
    );

    assert.equal((await postSearch(media.id, admin.id)).statusCode, 204);
    assert.deepEqual(
      commands.mock.calls.map((c) => c.arguments),
      [
        ['SeasonSearch', { seriesId: 34, seasonNumber: 1 }],
        ['EpisodeSearch', { episodeIds: [4] }],
      ]
    );
    const [seriesId, seasons] = monitor.mock.calls[0].arguments;
    assert.deepEqual([seriesId, seasons], [34, [1, 2]]);
    commands.mock.restore();
    episodes.mock.restore();
    monitor.mock.restore();
  });

  it('returns 404 without an open request', async () => {
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 7,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      })
    );
    assert.equal((await postSearch(media.id, 1)).statusCode, 404);
  });
});
