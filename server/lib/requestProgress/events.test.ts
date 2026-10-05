import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  handleCommand,
  reconcileJellyfin,
  refreshServer,
} from '@server/lib/requestProgress/events';
import { StepStats } from '@server/lib/requestProgress/stepStats';
import { ProgressTracker } from '@server/lib/requestProgress/tracker';
import type { RadarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

let history: Partial<HistoryRecord>[] = [];
let queue: Record<string, unknown>[] = [];
for (const [name, impl] of [
  ['getHistory', async () => history],
  ['getQueue', async () => queue],
] as const) {
  // Instance arrow properties: the getter shadows them, the setter swallows the constructor's.
  Object.defineProperty(RadarrAPI.prototype, name, {
    set() {},
    get: () => impl,
    configurable: true,
  });
}

setupTestDb();

async function setup(overrides: Partial<Media> = {}) {
  getSettings().radarr = [
    { id: 0, name: 'Radarr', hostname: 'localhost', port: 7878, apiKey: 'k' },
  ] as RadarrSettings[];
  const media = Object.assign(new Media(), {
    tmdbId: 550,
    mediaType: MediaType.MOVIE,
    status: MediaStatus.PROCESSING,
    serviceId: 0,
    externalServiceId: 42,
    ...overrides,
  });
  await getRepository(Media).save(media);
  const tracker = new ProgressTracker(new StepStats());
  history = [];
  queue = [];
  return { media, tracker };
}

const statusOf = (tracker: ProgressTracker, id: number, key: string) =>
  tracker.get(id, false)!.steps.find((s) => s.key === key)!;

describe('refreshServer', () => {
  it('advances grab and import from history', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const grab = new Date(Date.now() + 1000).toISOString();
    const imported = new Date(Date.now() + 8000).toISOString();
    history = [
      { eventType: 'downloadFolderImported', date: imported, movieId: 42 },
      { eventType: 'grabbed', date: grab, movieId: 42, downloadId: 'D' },
      { eventType: 'grabbed', date: grab, movieId: 7, downloadId: 'other' },
    ];

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'grabbed').finishedAt, grab);
    assert.equal(statusOf(tracker, media.id, 'importing').finishedAt, imported);
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
    assert.equal(tracker.entry(media.id, false)!.downloadId, 'D');
  });

  it('fails a blocked import as manual interaction', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    history = [
      { eventType: 'grabbed', date: new Date().toISOString(), movieId: 42 },
    ];
    queue = [{ movieId: 42, trackedDownloadState: 'importBlocked' }];

    await refreshServer('radarr-0', tracker);

    const step = statusOf(tracker, media.id, 'importing');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'Manual interaction required');
  });

  it('fails with no results when the search completed without a grab', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    await handleCommand(
      { type: 'radarr', serverId: 0 },
      {
        type: 'command',
        id: 1,
        name: 'MoviesSearch',
        status: 'completed',
        movieIds: [42],
      },
      tracker
    );

    await refreshServer('radarr-0', tracker);

    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'No results');
  });
});

describe('handleCommand', () => {
  it('starts tracking a waiting media on search start', async () => {
    const { media, tracker } = await setup();
    await handleCommand(
      { type: 'radarr', serverId: 0 },
      {
        type: 'command',
        id: 1,
        name: 'MoviesSearch',
        status: 'started',
        movieIds: [42],
      },
      tracker
    );
    assert.equal(tracker.entry(media.id, false)?.serverKey, 'radarr-0');
  });

  it('does not track available media', async () => {
    const { media, tracker } = await setup({ status: MediaStatus.AVAILABLE });
    await handleCommand(
      { type: 'radarr', serverId: 0 },
      {
        type: 'command',
        id: 1,
        name: 'MoviesSearch',
        status: 'started',
        movieIds: [42],
      },
      tracker
    );
    assert.equal(tracker.entry(media.id, false), undefined);
  });
});

describe('reconcileJellyfin', () => {
  it('marks linked media in Jellyfin and available media playable', async () => {
    const { media, tracker } = await setup({
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'abc',
    });
    tracker.start({ mediaId: media.id, is4k: false });

    await reconcileJellyfin(undefined, tracker);

    const progress = tracker.get(media.id, false)!;
    assert.ok(progress.steps.every((s) => s.status === 'done'));
    assert.match(progress.playUrl ?? '', /id=abc/);
  });
});
