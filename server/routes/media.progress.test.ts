import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, mock } from 'node:test';

import RadarrAPI from '@server/api/servarr/radarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import progressTracker from '@server/lib/requestProgress/tracker';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import mediaRoutes from './media';

setupTestDb();

async function openStream(path: string) {
  const app = express();
  app.use('/media', mediaRoutes);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const req = get(`http://127.0.0.1:${port}${path}`);
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
    assert.equal(update.requestId, 3);

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
    assert.equal(step('importing').status, 'running');
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
