import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import progressTracker from '@server/lib/requestProgress/tracker';
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
  res.on('data', (chunk: string) => events.push(chunk));
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
