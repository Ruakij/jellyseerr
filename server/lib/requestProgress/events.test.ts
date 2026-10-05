import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import type { CommandEvent } from '@server/api/servarr/signalr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import {
  handleCommand,
  queueEtaMs,
  reconcileJellyfin,
  reconstructProgress,
  refreshServer,
  rememberEpisode,
  requestProgressStats,
  requestStarts,
} from '@server/lib/requestProgress/events';
import { StepStats } from '@server/lib/requestProgress/stepStats';
import progressTracker, {
  ProgressTracker,
  WAITING_FOR_RELEASE,
} from '@server/lib/requestProgress/tracker';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

let history: Partial<HistoryRecord>[] = [];
let queue: Record<string, unknown>[] = [];
let hasFile = false;
let monitored = true;
let lastSearchTime: string | undefined;
let removed = false;
Object.defineProperty(RadarrAPI.prototype, 'getMovie', {
  set() {},
  get: () => async () => {
    if (removed) {
      throw new Error('Not found', { cause: { response: { status: 404 } } });
    }
    return { hasFile, monitored, lastSearchTime };
  },
  configurable: true,
});
for (const Api of [RadarrAPI, SonarrAPI]) {
  for (const [name, impl] of [
    ['getHistory', async () => history],
    [
      'getItemHistory',
      async (id: number) =>
        history.filter((r) => (r.movieId ?? r.seriesId) === id),
    ],
    ['getQueue', async () => queue],
  ] as const) {
    // Instance arrow properties: the getter shadows them, the setter swallows the constructor's.
    Object.defineProperty(Api.prototype, name, {
      set() {},
      get: () => impl,
      configurable: true,
    });
  }
}

mock.method(MediaRequest, 'sendNotification', async () => undefined);

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
  hasFile = false;
  monitored = true;
  lastSearchTime = undefined;
  removed = false;
  return { media, tracker };
}

// handleCommand caches media per command id, so each test sends its own commands.
let commandId = 1;

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
    hasFile = true;

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'grabbed').finishedAt, grab);
    assert.equal(statusOf(tracker, media.id, 'importing').finishedAt, imported);
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
    assert.equal(tracker.entry(media.id, false)!.downloadId, 'D');
  });

  it('ignores history from before the request', async () => {
    const { media, tracker } = await setup();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    history = [
      { eventType: 'grabbed', date: earlier, movieId: 42, downloadId: 'D' },
      { eventType: 'downloadFolderImported', date: earlier, movieId: 42 },
    ];

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'pending');
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'pending');
  });

  it('counts only episodes of the requested seasons', async () => {
    getSettings().sonarr = [
      { id: 0, name: 'Sonarr', hostname: 'localhost', port: 8989, apiKey: 'k' },
    ] as SonarrSettings[];
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1,
        tvdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 34,
      })
    );
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.TV,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: await getRepository(User).findOneByOrFail({ id: 1 }),
        seasons: [new SeasonRequest({ seasonNumber: 2 })],
      })
    );
    const tracker = new ProgressTracker(new StepStats());
    tracker.start({
      mediaId: media.id,
      is4k: false,
      requestId: request.id,
      serverKey: 'sonarr-0',
    });
    const now = Date.now();
    const at = (s: number) => new Date(now + s * 1000).toISOString();
    const episode = (seasonNumber: number) => ({
      seasonNumber,
      episodeNumber: 1,
    });
    history = [
      {
        eventType: 'grabbed',
        date: at(1),
        seriesId: 34,
        downloadId: 'S1',
        sourceTitle: 'Show.S01E01',
        episode: episode(1),
      },
      {
        eventType: 'downloadFolderImported',
        date: at(2),
        seriesId: 34,
        downloadId: 'S1',
        episode: episode(1),
      },
      {
        eventType: 'grabbed',
        date: at(3),
        seriesId: 34,
        downloadId: 'S2',
        sourceTitle: 'Show.S02',
        episode: episode(2),
      },
    ];
    queue = [
      {
        seriesId: 34,
        downloadId: 'S1',
        title: 'Show.S01E01',
        episode: episode(1),
      },
      ...[1, 2].map((episodeNumber) => ({
        seriesId: 34,
        downloadId: 'S2',
        title: 'Show.S02',
        indexer: 'NZBgeek',
        size: 1000,
        sizeleft: 400,
        timeleft: '00:01:30',
        episode: { seasonNumber: 2, episodeNumber },
      })),
    ];

    await refreshServer('sonarr-0', tracker);

    const progress = tracker.get(media.id, false)!;
    const grabbed = statusOf(tracker, media.id, 'grabbed');
    assert.equal(grabbed.finishedAt, at(3));
    assert.equal(grabbed.detail, 'Show.S02');
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'running');
    assert.deepEqual(progress.downloads, [
      {
        title: 'Show.S02',
        indexer: 'NZBgeek',
        size: 1000,
        sizeLeft: 400,
        etaMs: 90_000,
      },
    ]);
  });

  it('fails a blocked import as manual interaction', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    history = [
      { eventType: 'grabbed', date: new Date().toISOString(), movieId: 42 },
    ];
    queue = [
      {
        movieId: 42,
        downloadId: 'D',
        trackedDownloadState: 'importPending',
        trackedDownloadStatus: 'warning',
      },
    ];

    await refreshServer('radarr-0', tracker);

    const step = statusOf(tracker, media.id, 'importing');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'Manual interaction required');
  });

  it('waits for a release after a search without results', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    lastSearchTime = '2026-10-05T12:00:00.000Z';

    await refreshServer('radarr-0', tracker);

    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'running');
    assert.equal(step.detail, WAITING_FOR_RELEASE);
    assert.equal(
      tracker.entry(media.id, false)!.lastSearchedAt,
      Date.parse(lastSearchTime)
    );
  });

  it('goes back to searching when the files disappear after the import', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    tracker.advance(media.id, false, 'playable');

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'searching').status, 'running');
    for (const key of ['grabbed', 'importing', 'inJellyfin', 'playable']) {
      assert.equal(statusOf(tracker, media.id, key).status, 'pending');
    }
  });

  it('fails the run with the Radarr reason once the request failed', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    removed = true;

    await refreshServer('radarr-0', tracker);

    // The request status decides, not the tracker.
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'running');

    tracker.failRequest(media.id, false);

    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'Removed from Radarr');
  });

  it('keeps an unmonitored item with a running download', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    tracker.advance(media.id, false, 'grabbed');
    monitored = false;

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'importing').status, 'running');
  });
});

const radarr = { type: 'radarr', serverId: 0 } as const;
const search = (
  status: CommandEvent['status'],
  extra: Partial<CommandEvent> = {}
): CommandEvent => ({
  type: 'command',
  id: commandId++,
  name: 'MoviesSearch',
  status,
  trigger: 'manual',
  movieIds: [42],
  ...extra,
});

describe('handleCommand', () => {
  it('shows a running search with its indexers, then waits for a release', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const id = commandId++;
    await handleCommand(
      radarr,
      search('started', {
        id,
        message: 'Searching indexers for [Movie]. 3 active indexers',
      }),
      tracker
    );
    assert.equal(
      statusOf(tracker, media.id, 'searching').detail,
      'Searching (3 indexers)'
    );
    assert.equal(tracker.entry(media.id, false)!.lastSearchedAt, undefined);

    await handleCommand(
      radarr,
      search('completed', {
        id,
        message: 'Completed search for 1 movies. 0 reports downloaded.',
        reportsDownloaded: 0,
      }),
      tracker
    );
    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'running');
    assert.equal(step.detail, WAITING_FOR_RELEASE);
    assert.ok(tracker.entry(media.id, false)!.lastSearchedAt);
  });

  it('fails the search on a failed search command', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    await handleCommand(
      radarr,
      search('failed', { message: 'Indexer down' }),
      tracker
    );
    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'Search failed: Indexer down');
  });

  it('restarts the search on an automatic re-search after a failed download', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    history = [
      { eventType: 'grabbed', date: at(1), movieId: 42, downloadId: 'old' },
      {
        eventType: 'downloadFailed',
        date: at(2),
        movieId: 42,
        downloadId: 'old',
      },
    ];
    await refreshServer('radarr-0', tracker);
    assert.equal(
      statusOf(tracker, media.id, 'importing').error,
      'Download failed'
    );

    await handleCommand(
      radarr,
      search('started', { trigger: 'unspecified' }),
      tracker
    );
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'running');
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'pending');

    // The failed download stays in history and must not count for the new attempt.
    await refreshServer('radarr-0', tracker);
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'pending');
    history.push({
      eventType: 'grabbed',
      date: at(3),
      movieId: 42,
      downloadId: 'new',
    });
    await refreshServer('radarr-0', tracker);
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'done');
    assert.equal(tracker.entry(media.id, false)!.downloadId, 'new');
  });

  it('ignores an automatic search on a grabbed item', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    tracker.advance(media.id, false, 'grabbed');
    await handleCommand(
      radarr,
      search('started', { trigger: 'unspecified' }),
      tracker
    );
    await handleCommand(
      radarr,
      search('completed', { trigger: 'unspecified', reportsDownloaded: 0 }),
      tracker
    );
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'running');
  });

  it('maps a Sonarr episode search to its series', async () => {
    getSettings().sonarr = [
      { id: 0, name: 'Sonarr', hostname: 'localhost', port: 8989, apiKey: 'k' },
    ] as SonarrSettings[];
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1,
        tvdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 34,
      })
    );
    const tracker = new ProgressTracker(new StepStats());
    rememberEpisode(0, 10800, 34);
    await handleCommand(
      { type: 'sonarr', serverId: 0 },
      {
        type: 'command',
        id: 5335091,
        name: 'EpisodeSearch',
        status: 'started',
        trigger: 'manual',
        episodeIds: [10800],
      },
      tracker
    );
    assert.equal(tracker.entry(media.id, false)?.serverKey, 'sonarr-0');
  });

  it('starts tracking a waiting media on search start', async () => {
    const { media, tracker } = await setup();
    await handleCommand(
      { type: 'radarr', serverId: 0 },
      {
        type: 'command',
        id: commandId++,
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
        id: commandId++,
        name: 'MoviesSearch',
        status: 'started',
        movieIds: [42],
      },
      tracker
    );
    assert.equal(tracker.entry(media.id, false), undefined);
  });
});

describe('handleCommand media cache', () => {
  it('looks up the media once per command until it ends', async () => {
    const { media, tracker } = await setup({ status: MediaStatus.AVAILABLE });
    const id = commandId++;
    await handleCommand(radarr, search('started', { id }), tracker);
    await getRepository(Media).update(media.id, {
      status: MediaStatus.PROCESSING,
    });

    await handleCommand(radarr, search('started', { id }), tracker);
    assert.equal(tracker.entry(media.id, false), undefined);

    await handleCommand(radarr, search('completed', { id }), tracker);
    await handleCommand(radarr, search('started', { id }), tracker);
    assert.ok(tracker.entry(media.id, false));
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

  it('reopens the Jellyfin step when the item left Jellyfin', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false });
    tracker.advance(media.id, false, 'inJellyfin');

    await reconcileJellyfin(undefined, tracker);

    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
  });
});

describe('reconstructProgress', () => {
  const requestedAt = '2026-10-05T10:00:00.000Z';
  async function setupRequest(status: MediaRequestStatus) {
    const { media } = await setup();
    const stats = new StepStats();
    const record = mock.method(stats, 'record');
    const tracker = new ProgressTracker(stats);
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status,
        media,
        requestedBy: user,
        modifiedBy: user,
        createdAt: new Date(requestedAt),
      })
    );
    return { media, tracker, record };
  }

  it('rebuilds an approved request from history without measuring it', async () => {
    const { media, tracker, record } = await setupRequest(
      MediaRequestStatus.APPROVED
    );
    history = [
      {
        eventType: 'grabbed',
        date: '2026-10-05T10:05:00.000Z',
        movieId: 42,
        downloadId: 'D',
        sourceTitle: 'Movie',
      },
      {
        eventType: 'downloadFolderImported',
        date: '2026-10-05T10:30:00.000Z',
        movieId: 42,
      },
    ];
    hasFile = true;

    await reconstructProgress([{ mediaId: media.id, is4k: false }], tracker);

    const requested = statusOf(tracker, media.id, 'requested');
    assert.equal(requested.startedAt, requestedAt);
    assert.equal(requested.finishedAt, requestedAt);
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
    assert.equal(record.mock.callCount(), 0);
  });

  it('waits for a release when nothing was grabbed', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.APPROVED);

    await reconstructProgress(undefined, tracker);

    const searching = statusOf(tracker, media.id, 'searching');
    assert.equal(searching.status, 'running');
    assert.equal(searching.startedAt, requestedAt);
    assert.equal(searching.detail, WAITING_FOR_RELEASE);
  });

  it('takes a file in Radarr as imported', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.APPROVED);
    hasFile = true;

    await reconstructProgress(undefined, tracker);

    assert.equal(statusOf(tracker, media.id, 'importing').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
  });

  it('shows a pending request as awaiting approval', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.PENDING);

    await reconstructProgress(undefined, tracker);

    assert.equal(statusOf(tracker, media.id, 'requested').status, 'running');
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'pending');
  });

  it('fails a declined request', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.DECLINED);

    await reconstructProgress([{ mediaId: media.id, is4k: false }], tracker);

    const requested = statusOf(tracker, media.id, 'requested');
    assert.equal(requested.status, 'failed');
    assert.equal(requested.error, 'Request declined');
  });

  it('leaves media with a tracked run alone', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.APPROVED);
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const before = tracker.get(media.id, false);

    await reconstructProgress(undefined, tracker);

    assert.deepEqual(tracker.get(media.id, false), before);
  });
});

describe('requestStarts', () => {
  it('lists auto-approved requests sent to the server since a date', async () => {
    getSettings().sonarr = [
      { id: 0, name: 'Sonarr', hostname: 'localhost', port: 8989, apiKey: 'k' },
      {
        id: 1,
        name: 'Sonarr 4K',
        hostname: 'localhost',
        port: 8990,
        apiKey: 'k',
        is4k: true,
      },
    ] as SonarrSettings[];
    const users = getRepository(User);
    const admin = await users.findOneByOrFail({ id: 1 });
    const friend = await users.findOneByOrFail({ email: 'friend@seerr.dev' });
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1,
        tvdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 34,
        serviceId4k: 1,
        externalServiceId4k: 56,
      })
    );
    const request = (
      createdAt: string,
      status: MediaRequestStatus,
      modifiedBy: User,
      is4k = false
    ) =>
      new MediaRequest({
        type: MediaType.TV,
        status,
        media,
        is4k,
        requestedBy: friend,
        modifiedBy,
        createdAt: new Date(createdAt),
        seasons: [new SeasonRequest({ seasonNumber: 2 })],
      });
    await getRepository(MediaRequest).save([
      request('2026-10-05T10:00:00Z', MediaRequestStatus.APPROVED, friend),
      request('2026-10-05T11:00:00Z', MediaRequestStatus.COMPLETED, friend),
      request('2026-10-04T10:00:00Z', MediaRequestStatus.APPROVED, friend),
      request('2026-10-05T12:00:00Z', MediaRequestStatus.APPROVED, admin),
      request('2026-10-05T13:00:00Z', MediaRequestStatus.PENDING, friend),
      request(
        '2026-10-05T14:00:00Z',
        MediaRequestStatus.APPROVED,
        friend,
        true
      ),
    ]);

    const since = new Date('2026-10-05T00:00:00Z');
    const starts = (await requestStarts('sonarr', 0, since)).sort(
      (a, b) => a.at - b.at
    );
    assert.deepEqual(starts, [
      { at: Date.parse('2026-10-05T10:00:00Z'), arrId: 34, seasons: [2] },
      { at: Date.parse('2026-10-05T11:00:00Z'), arrId: 34, seasons: [2] },
    ]);
    assert.deepEqual(await requestStarts('sonarr', 1, since), [
      { at: Date.parse('2026-10-05T14:00:00Z'), arrId: 56, seasons: [2] },
    ]);
  });
});

describe('requestProgressStats', () => {
  it('lists every configured server with its steps and total', () => {
    getSettings().radarr = [
      { id: 0, name: 'Radarr', hostname: 'localhost', port: 7878, apiKey: 'k' },
    ] as RadarrSettings[];
    getSettings().sonarr = [];
    const [server, ...others] = requestProgressStats().servers;
    assert.equal(others.length, 0);
    assert.equal(server.serverKey, 'radarr-0');
    assert.equal(server.name, 'Radarr');
    assert.deepEqual(Object.keys(server.steps), [
      'searching',
      'grabbed',
      'importing',
      'inJellyfin',
      'playable',
    ]);
    assert.equal(server.total.historyCount, 0);
  });
});

describe('queueEtaMs', () => {
  it('prefers the estimated completion time over timeleft', () => {
    const now = Date.parse('2026-10-05T10:00:00Z');
    assert.equal(
      queueEtaMs(
        {
          estimatedCompletionTime: '2026-10-05T10:00:30Z',
          timeleft: '1:00:00',
        },
        now
      ),
      30_000
    );
    assert.equal(queueEtaMs({ timeleft: '1.02:00:05' }, now), 93_605_000);
    assert.equal(queueEtaMs({}, now), undefined);
  });
});

describe('request status', () => {
  it('fails the tracked run when the request is saved as FAILED', async () => {
    const { media } = await setup();
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const requests = getRepository(MediaRequest);
    const request = await requests.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: user,
        modifiedBy: user,
      })
    );
    progressTracker.start({ mediaId: media.id, is4k: false });

    request.status = MediaRequestStatus.FAILED;
    await requests.save(request);

    const step = progressTracker
      .get(media.id, false)!
      .steps.find((s) => s.key === 'searching')!;
    assert.equal(step.status, 'failed');
    assert.equal(step.error, 'Request failed');
  });
});
