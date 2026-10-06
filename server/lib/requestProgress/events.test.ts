import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
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
import { RequestProgressRun } from '@server/entity/RequestProgressRun';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import availabilitySync from '@server/lib/availabilitySync';
import { DEBOUNCE_MS } from '@server/lib/requestProgress/debounce';
import {
  FULL_SYNC_DEBOUNCE_MS,
  REMOVAL_DEBOUNCE_MS,
  SERVER_REFRESH_MAX_WAIT_MS,
  handleCommand,
  loadUnits,
  onJellyfinRemoved,
  onSignalRMessage,
  pollJellyfin,
  queueEtaMs,
  reconcileJellyfin,
  reconstructProgress,
  refreshServer,
  rememberEpisode,
  requestProgressStats,
  requestStarts,
  storeRuns,
  syncRequests,
  watchJellyfin,
} from '@server/lib/requestProgress/events';
import { storeRun } from '@server/lib/requestProgress/history';
import { StepStats } from '@server/lib/requestProgress/stepStats';
import progressTracker, {
  ProgressTracker,
  WAITING_FOR_RELEASE,
  WAITING_FOR_RSS,
} from '@server/lib/requestProgress/tracker';
import { jellyfinItemScanner } from '@server/lib/scanners/jellyfin';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import type { RadarrSettings, SonarrSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import { In } from 'typeorm';

let history: Partial<HistoryRecord>[] = [];
let queue: Record<string, unknown>[] = [];
let hasFile = false;
let monitored = true;
let lastSearchTime: string | undefined;
let removed = false;
let isAvailable = true;
let releases: { digitalRelease?: string; physicalRelease?: string } = {};
// Radarr ids whose history and movie the fakes served, in order.
const reads = { history: [] as number[], state: [] as number[] };
Object.defineProperty(RadarrAPI.prototype, 'getMovie', {
  set() {},
  get:
    () =>
    async ({ id }: { id: number }) => {
      reads.state.push(id);
      if (removed) {
        throw new Error('Not found', { cause: { response: { status: 404 } } });
      }
      return { hasFile, monitored, lastSearchTime, isAvailable, ...releases };
    },
  configurable: true,
});
let sonarrSeasons: {
  seasonNumber: number;
  statistics: { episodeFileCount: number; episodeCount: number };
}[] = [];
let sonarrEpisodes: Record<string, unknown>[] = [];
for (const [name, impl] of [
  ['getSeriesById', async () => ({ monitored, seasons: sonarrSeasons })],
  ['getEpisodes', async () => sonarrEpisodes],
] as const) {
  Object.defineProperty(SonarrAPI.prototype, name, {
    set() {},
    get: () => impl,
    configurable: true,
  });
}
for (const Api of [RadarrAPI, SonarrAPI]) {
  for (const [name, impl] of [
    ['getHistory', async () => history],
    [
      'getItemHistory',
      async (id: number) => {
        reads.history.push(id);
        return history.filter((r) => (r.movieId ?? r.seriesId) === id);
      },
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
  isAvailable = true;
  releases = {};
  reads.history = [];
  reads.state = [];
  return { media, tracker };
}

// handleCommand caches media per command id, so each test sends its own commands.
let commandId = 1;

const statusOf = (tracker: ProgressTracker, id: number, key: string) =>
  tracker.get(id, false)!.steps.find((s) => s.key === key)!;

/** Moves the single unit of a movie to `step` done (`grabbed`: assigned a download). */
function reach(
  tracker: ProgressTracker,
  mediaId: number,
  step: 'grabbed' | 'playable',
  at = Date.now()
) {
  tracker.grab(mediaId, false, { downloadId: 'D', unitIds: [0], at });
  if (step === 'grabbed') return;
  tracker.imported(mediaId, false, { downloadId: 'D', unitIds: [0], at });
  tracker.setJellyfin(mediaId, false, {
    present: () => true,
    at,
  });
}

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

    // History has no download end; the import ends the download too.
    assert.equal(statusOf(tracker, media.id, 'grabbed').startedAt, grab);
    assert.equal(statusOf(tracker, media.id, 'grabbed').finishedAt, imported);
    assert.equal(statusOf(tracker, media.id, 'importing').finishedAt, imported);
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
    assert.equal(tracker.entry(media.id, false)!.units.get(0)?.downloadId, 'D');
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
        status: MediaRequestStatus.APPROVED,
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
    const aired = new Date(now - 86_400_000).toISOString();
    const ep = (id: number, seasonNumber: number, episodeNumber: number) => ({
      episodeId: id,
      episode: { seasonNumber, episodeNumber },
    });
    history = [
      {
        eventType: 'grabbed',
        date: at(1),
        seriesId: 34,
        downloadId: 'S1',
        sourceTitle: 'Show.S01E01',
        ...ep(101, 1, 1),
      },
      {
        eventType: 'downloadFolderImported',
        date: at(2),
        seriesId: 34,
        downloadId: 'S1',
        ...ep(101, 1, 1),
      },
      ...[201, 202].map((id) => ({
        eventType: 'grabbed' as const,
        date: at(3),
        seriesId: 34,
        downloadId: 'S2',
        sourceTitle: 'Show.S02',
        ...ep(id, 2, id - 200),
      })),
    ];
    queue = [
      {
        seriesId: 34,
        downloadId: 'S1',
        title: 'Show.S01E01',
        ...ep(101, 1, 1),
      },
      ...[201, 202].map((id) => ({
        seriesId: 34,
        downloadId: 'S2',
        title: 'Show.S02',
        indexer: 'NZBgeek',
        size: 1000,
        sizeleft: 400,
        timeleft: '00:01:30',
        trackedDownloadState: 'downloading',
        ...ep(id, 2, id - 200),
      })),
    ];
    sonarrSeasons = [];
    const episodeOf = (
      id: number,
      seasonNumber: number,
      episodeNumber: number
    ) => ({
      id,
      seasonNumber,
      episodeNumber,
      hasFile: false,
      monitored: true,
      airDateUtc: aired,
    });
    sonarrEpisodes = [
      { ...episodeOf(101, 1, 1), hasFile: true },
      episodeOf(201, 2, 1),
      episodeOf(202, 2, 2),
      // Not aired yet: no unit.
      {
        ...episodeOf(203, 2, 3),
        airDateUtc: new Date(now + 86_400_000).toISOString(),
      },
      // Airs earlier, but not requested.
      {
        ...episodeOf(102, 1, 2),
        airDateUtc: new Date(now + 3_600_000).toISOString(),
      },
    ];

    await refreshServer('sonarr-0', tracker);

    const progress = tracker.get(media.id, false)!;
    assert.equal(progress.releaseDate, sonarrEpisodes[3].airDateUtc);
    const grabbed = statusOf(tracker, media.id, 'grabbed');
    assert.equal(grabbed.status, 'running');
    assert.equal(grabbed.startedAt, at(3));
    assert.equal(grabbed.detail, 'Show.S02');
    assert.deepEqual(grabbed.counts, {
      done: 0,
      active: 2,
      failed: 0,
      total: 2,
    });
    assert.equal(grabbed.progress, 0.6);
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'pending');
    assert.deepEqual(progress.downloads, [
      {
        title: 'Show.S02',
        indexer: 'NZBgeek',
        size: 1000,
        sizeLeft: 400,
        etaMs: 90_000,
      },
    ]);
    assert.deepEqual(
      progress.timeline?.map((e) => [e.kind, e.units]),
      [
        ['requested', undefined],
        ['grabbed', ['S02E01-E02']],
      ]
    );

    // The pack finished; its first episode is imported.
    for (const item of queue) item.trackedDownloadState = 'importing';
    history.push({
      eventType: 'downloadFolderImported',
      date: at(4),
      seriesId: 34,
      downloadId: 'S2',
      ...ep(201, 2, 1),
    });
    sonarrEpisodes[1].hasFile = true;
    await refreshServer('sonarr-0', tracker);

    const importing = statusOf(tracker, media.id, 'importing');
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'done');
    assert.equal(importing.status, 'running');
    assert.deepEqual(importing.counts, {
      done: 1,
      active: 1,
      failed: 0,
      total: 2,
    });
    assert.equal(importing.progress, 0.5);
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
    lastSearchTime = new Date(Date.now() + 1000).toISOString();

    await refreshServer('radarr-0', tracker);

    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'running');
    assert.equal(step.detail, WAITING_FOR_RSS);
    assert.equal(step.waiting, 'rss');
    assert.equal(step.waitingSince, lastSearchTime);
    assert.equal(step.searchStartedAt, undefined);
    assert.equal(
      tracker.entry(media.id, false)!.lastSearchedAt,
      Date.parse(lastSearchTime)
    );

    isAvailable = false;
    const day = (d: number) =>
      new Date(Date.now() + d * 86_400_000).toISOString();
    // The digital release is past, the physical one is next.
    releases = { digitalRelease: day(-1), physicalRelease: day(30) };
    await refreshServer('radarr-0', tracker);
    const unreleased = statusOf(tracker, media.id, 'searching');
    assert.equal(unreleased.detail, WAITING_FOR_RELEASE);
    assert.equal(unreleased.waiting, 'release');
    assert.equal(
      tracker.get(media.id, false)!.releaseDate,
      releases.physicalRelease
    );
  });

  it('goes back to searching when the files disappear after the import', async () => {
    const { media, tracker } = await setup();
    const at = Date.now() - 60_000;
    tracker.start({
      mediaId: media.id,
      is4k: false,
      serverKey: 'radarr-0',
      at,
    });
    reach(tracker, media.id, 'playable', at);

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
    reach(tracker, media.id, 'grabbed');
    monitored = false;

    await refreshServer('radarr-0', tracker);

    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
  });
});

describe('refreshServer scope', () => {
  it('reads history and state only for named, queued and moving runs', async () => {
    const { media, tracker } = await setup();
    const [finished, queued] = await getRepository(Media).save(
      [43, 44].map((arrId) =>
        Object.assign(new Media(), {
          tmdbId: 1000 + arrId,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PROCESSING,
          serviceId: 0,
          externalServiceId: arrId,
        })
      )
    );
    for (const m of [media, finished, queued]) {
      tracker.start({ mediaId: m.id, is4k: false, serverKey: 'radarr-0' });
    }
    for (const m of [finished, queued]) reach(tracker, m.id, 'playable');
    queue = [{ movieId: 44, downloadId: 'Q', title: 'Q', size: 0 }];

    await refreshServer('radarr-0', tracker, {});
    assert.deepEqual(reads.history.sort(), [42, 44]);
    assert.deepEqual(reads.state.sort(), [42, 44]);

    reads.history = [];
    reads.state = [];
    queue = [];
    await refreshServer('radarr-0', tracker, { arrIds: [43] });
    assert.deepEqual(reads.history.sort(), [42, 43]);
    assert.deepEqual(reads.state.sort(), [42, 43]);
  });
});

/** A movie run whose search found nothing, so it waits for RSS. */
async function dormantRun(tracker: ProgressTracker, mediaId: number) {
  tracker.start({ mediaId, is4k: false, serverKey: 'radarr-0' });
  lastSearchTime = new Date(Date.now() + 1000).toISOString();
  await refreshServer('radarr-0', tracker);
  assert.equal(tracker.dormant(tracker.entry(mediaId, false)!), true);
  reads.history = [];
  reads.state = [];
}

describe('dormant runs', () => {
  it('reads nothing of a waiting run on a queue event for another item', async () => {
    const { media, tracker } = await setup();
    await dormantRun(tracker, media.id);
    assert.equal(tracker.get(media.id, false)!.dormant, true);
    const other = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1043,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 43,
      })
    );
    tracker.start({ mediaId: other.id, is4k: false, serverKey: 'radarr-0' });
    queue = [{ movieId: 43, downloadId: 'O', title: 'O', size: 0 }];

    await refreshServer('radarr-0', tracker, {});

    assert.deepEqual(reads.history, [43]);
    assert.deepEqual(reads.state, [43]);
  });

  it('wakes once its item shows up in the queue', async () => {
    const { media, tracker } = await setup();
    await dormantRun(tracker, media.id);
    queue = [
      {
        movieId: 42,
        downloadId: 'D',
        title: 'Movie',
        size: 100,
        sizeleft: 50,
        trackedDownloadState: 'downloading',
      },
    ];

    await refreshServer('radarr-0', tracker, {});

    assert.deepEqual(reads.history, [42]);
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
    assert.equal(tracker.get(media.id, false)!.dormant, undefined);
  });

  it('wakes on a grab the event names', async () => {
    const { media, tracker } = await setup();
    await dormantRun(tracker, media.id);
    history = [
      {
        eventType: 'grabbed',
        date: new Date(Date.now() + 2000).toISOString(),
        movieId: 42,
        downloadId: 'D',
      },
    ];

    await refreshServer('radarr-0', tracker, {});
    assert.deepEqual(reads.history, []);

    await refreshServer('radarr-0', tracker, { arrIds: [42] });
    assert.deepEqual(reads.history, [42]);
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
    assert.equal(tracker.dormant(tracker.entry(media.id, false)!), false);
  });

  it('is refreshed by an event naming its item and by the full sync', async () => {
    const { media } = await setup();
    const syncMovie = mock.method(radarrScanner, 'syncMovie', async () => {});
    const run = mock.method(availabilitySync, 'run', async () => {});
    try {
      await dormantRun(progressTracker, media.id);
      mock.timers.enable({ apis: ['setTimeout'] });

      onSignalRMessage(radarr, { type: 'queue' });
      mock.timers.tick(DEBOUNCE_MS);
      await settle();
      assert.deepEqual(reads.history, []);

      onSignalRMessage(radarr, { type: 'movie', action: 'updated', id: 42 });
      mock.timers.tick(DEBOUNCE_MS);
      await settle();
      assert.deepEqual(reads.history, [42]);

      reads.history = [];
      await onJellyfinRemoved(['jf-unknown']);
      mock.timers.tick(FULL_SYNC_DEBOUNCE_MS);
      await settle();
      mock.timers.tick(DEBOUNCE_MS);
      await settle();
      assert.deepEqual(reads.history, [42]);
    } finally {
      mock.timers.reset();
      syncMovie.mock.restore();
      run.mock.restore();
      (
        progressTracker as unknown as { entries: Map<string, unknown> }
      ).entries.clear();
    }
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
  it('shows a running search with its indexers, then waits for RSS', async () => {
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

    await completeSearch(
      search('completed', {
        id,
        message: 'Completed search for 1 movies. 0 reports downloaded.',
        reportsDownloaded: 0,
      }),
      tracker
    );
    const step = statusOf(tracker, media.id, 'searching');
    assert.equal(step.status, 'running');
    assert.equal(step.detail, WAITING_FOR_RSS);
    assert.equal(step.searchStartedAt, undefined);
    assert.ok(tracker.entry(media.id, false)!.lastSearchedAt);
  });

  it('never waits for RSS when the history has the grab of the completed search', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const id = commandId++;
    await handleCommand(radarr, search('started', { id }), tracker);
    const waited: unknown[] = [];
    tracker.on('change', () => {
      waited.push(statusOf(tracker, media.id, 'searching').waiting);
    });

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await handleCommand(radarr, search('completed', { id }), tracker);
      history = [
        {
          eventType: 'grabbed',
          date: new Date(Date.now() + 1000).toISOString(),
          movieId: 42,
          downloadId: 'D',
        },
      ];
      mock.timers.tick(DEBOUNCE_MS);
      await settle();
    } finally {
      mock.timers.reset();
    }

    assert.equal(statusOf(tracker, media.id, 'searching').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
    assert.ok(!waited.includes('rss'));
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
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'failed');
    assert.equal(
      statusOf(tracker, media.id, 'grabbed').error,
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
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
    assert.equal(
      tracker.entry(media.id, false)!.units.get(0)?.downloadId,
      'new'
    );
  });

  it('ignores an automatic search on a grabbed item', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    reach(tracker, media.id, 'grabbed');
    await handleCommand(
      radarr,
      search('started', { trigger: 'unspecified' }),
      tracker
    );
    await completeSearch(
      search('completed', { trigger: 'unspecified', reportsDownloaded: 0 }),
      tracker
    );
    assert.equal(statusOf(tracker, media.id, 'searching').status, 'done');
    assert.equal(statusOf(tracker, media.id, 'grabbed').status, 'running');
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

describe('units at run start', () => {
  const episode = (id: number, seasonNumber: number) => ({
    id,
    seasonNumber,
    episodeNumber: id % 100,
    hasFile: false,
    monitored: true,
    airDateUtc: '2020-01-01T00:00:00Z',
  });

  async function series(tracker: ProgressTracker) {
    getSettings().sonarr = [
      { id: 0, name: 'Sonarr', hostname: 'localhost', port: 8989, apiKey: 'k' },
    ] as SonarrSettings[];
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 61,
        tvdbId: 62,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        serviceId: 0,
        externalServiceId: 63,
      })
    );
    tracker.start({
      mediaId: media.id,
      is4k: false,
      requestId: 1,
      seasons: [1],
      serverKey: 'sonarr-0',
    });
    return media;
  }

  const seriesSearch = (id: number) => ({
    type: 'command' as const,
    id,
    name: 'SeriesSearch',
    status: 'started' as const,
    seriesId: 63,
  });

  it('loads the units of the requested seasons when the request is sent', async () => {
    const { tracker } = await setup();
    const media = await series(tracker);
    sonarrEpisodes = [episode(101, 1), episode(102, 1), episode(201, 2)];
    try {
      await loadUnits(media.id, false, tracker);
      assert.deepEqual(
        [...tracker.entry(media.id, false)!.units.keys()],
        [101, 102]
      );
    } finally {
      sonarrEpisodes = [];
    }
  });

  it('loads them on the search start before any debounced refresh, once per search', async () => {
    const { tracker } = await setup();
    const media = await series(tracker);
    const sonarr = { type: 'sonarr', serverId: 0 } as const;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // Sonarr has not created the episodes of the new series yet.
      const first = commandId++;
      await handleCommand(sonarr, seriesSearch(first), tracker);
      assert.equal(tracker.entry(media.id, false)!.unitsKnown, false);

      sonarrEpisodes = [episode(101, 1), episode(102, 1)];
      await handleCommand(sonarr, seriesSearch(first), tracker);
      assert.equal(tracker.entry(media.id, false)!.unitsKnown, false);

      await handleCommand(sonarr, seriesSearch(commandId++), tracker);
      assert.equal(tracker.entry(media.id, false)!.units.size, 2);
      assert.deepEqual(reads.history, []);
    } finally {
      mock.timers.reset();
      sonarrEpisodes = [];
    }
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

    await completeSearch(search('completed', { id }), tracker);
    await handleCommand(radarr, search('started', { id }), tracker);
    assert.ok(tracker.entry(media.id, false));
  });
});

describe('reconcileJellyfin', () => {
  const video = { MediaSources: [{ MediaStreams: [{ Type: 'Video' }] }] };
  const jellyfinItem = (item: object) =>
    mock.method(JellyfinAPI.prototype, 'getItemData', async () => item);

  it('marks linked media in Jellyfin and available media playable', async () => {
    const { media, tracker } = await setup({
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'abc',
    });
    tracker.start({ mediaId: media.id, is4k: false });
    const item = jellyfinItem(video);

    await reconcileJellyfin(undefined, tracker);
    item.mock.restore();

    const progress = tracker.get(media.id, false)!;
    assert.ok(progress.steps.every((s) => s.status === 'done'));
    assert.match(progress.playUrl ?? '', /id=abc/);
  });

  it('waits until Jellyfin probed the movie file', async () => {
    const { media, tracker } = await setup({
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'abc',
    });
    tracker.start({ mediaId: media.id, is4k: false });
    const item = jellyfinItem({ MediaSources: [] });

    await reconcileJellyfin(undefined, tracker);
    item.mock.restore();

    assert.notEqual(statusOf(tracker, media.id, 'inJellyfin').status, 'done');
    assert.notEqual(statusOf(tracker, media.id, 'playable').status, 'done');
  });

  it('counts probed episodes only and links the lowest requested season', async () => {
    const { media, tracker } = await setup({
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'series',
    });
    tracker.start({
      mediaId: media.id,
      is4k: false,
      requestId: 1,
      seasons: [3, 2],
    });
    tracker.setUnits(media.id, false, [
      { id: 201, seasonNumber: 2, episodeNumber: 1, hasFile: true },
      { id: 301, seasonNumber: 3, episodeNumber: 1, hasFile: true },
    ]);
    let episodes = [
      { ParentIndexNumber: 2, IndexNumber: 1, ...video },
      { ParentIndexNumber: 3, IndexNumber: 1 },
    ];
    const listed = mock.method(
      JellyfinAPI.prototype,
      'getEpisodes',
      async () => episodes
    );
    const seasons = mock.method(
      JellyfinAPI.prototype,
      'getSeasons',
      async () => [
        { Id: 'season3', IndexNumber: 3 },
        { Id: 'season2', IndexNumber: 2 },
      ]
    );

    await reconcileJellyfin(undefined, tracker);
    assert.equal(
      tracker.get(media.id, false)!.steps.find((s) => s.key === 'inJellyfin')!
        .counts?.done,
      1
    );
    // Listed but not probed: Adding to Jellyfin goes on, Ready has no phase of its own.
    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
    assert.equal(statusOf(tracker, media.id, 'playable').status, 'pending');

    episodes = episodes.map((e) => ({ ...e, ...video }));
    await reconcileJellyfin(undefined, tracker);
    listed.mock.restore();
    seasons.mock.restore();

    assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');
    assert.match(tracker.get(media.id, false)!.playUrl ?? '', /id=season2&/);
  });

  it('counts probed episodes whatever the date of their item', async () => {
    const { media, tracker } = await setup({
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'series',
    });
    tracker.start({ mediaId: media.id, is4k: false, seasons: [1] });
    tracker.setUnits(media.id, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: true },
    ]);
    const importedAt = Date.now();
    tracker.grab(media.id, false, { downloadId: 'D', unitIds: [101, 102] });
    tracker.imported(media.id, false, {
      downloadId: 'D',
      unitIds: [101, 102],
      at: importedAt,
    });
    // Created a day before the import, e.g. an item Jellyfin kept for a replaced file.
    const episodes = [1, 2].map((n) => ({
      ParentIndexNumber: 1,
      IndexNumber: n,
      DateCreated: new Date(importedAt - 86_400_000).toISOString(),
      ...video,
    }));
    const listed = mock.method(
      JellyfinAPI.prototype,
      'getEpisodes',
      async () => episodes
    );
    const newest = mock.method(
      JellyfinAPI.prototype,
      'getNewestItems',
      async () => []
    );
    try {
      await reconcileJellyfin(undefined, tracker);
      assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'done');
      assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');
    } finally {
      listed.mock.restore();
      newest.mock.restore();
    }
  });

  it('looks the series up by provider id when its item lists none of the units', async () => {
    const { media, tracker } = await setup({
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'stale',
      tvdbId: 121361,
    });
    tracker.start({ mediaId: media.id, is4k: false, seasons: [1] });
    tracker.setUnits(media.id, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
    ]);
    const listed = mock.method(
      JellyfinAPI.prototype,
      'getEpisodes',
      async (id: string) =>
        id === 'series'
          ? [{ ParentIndexNumber: 1, IndexNumber: 1, ...video }]
          : []
    );
    const newest = mock.method(
      JellyfinAPI.prototype,
      'getNewestItems',
      async () => [
        { Id: 'series', Type: 'Series', ProviderIds: { Tvdb: '121361' } },
      ]
    );
    const scan = mock.method(jellyfinItemScanner, 'runItems', async () => {
      await getRepository(Media).update(media.id, {
        jellyfinMediaId: 'series',
      });
    });
    try {
      await reconcileJellyfin(undefined, tracker);
      assert.deepEqual(scan.mock.calls[0].arguments, [['series']]);
      assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');
    } finally {
      listed.mock.restore();
      newest.mock.restore();
      scan.mock.restore();
    }
  });

  it('counts no unit in Jellyfin while the series has no Jellyfin item', async () => {
    const { media, tracker } = await setup({
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      seasons: [
        Object.assign(new Season(), {
          seasonNumber: 1,
          status: MediaStatus.AVAILABLE,
        }),
      ],
    });
    tracker.start({ mediaId: media.id, is4k: false, seasons: [1] });
    tracker.setUnits(media.id, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
    ]);
    const newest = mock.method(
      JellyfinAPI.prototype,
      'getNewestItems',
      async () => []
    );

    await reconcileJellyfin(undefined, tracker);
    newest.mock.restore();

    assert.notEqual(statusOf(tracker, media.id, 'inJellyfin').status, 'done');
    assert.notEqual(statusOf(tracker, media.id, 'playable').status, 'done');
  });

  it('reopens the Jellyfin step when the item left Jellyfin', async () => {
    const { media, tracker } = await setup();
    tracker.start({ mediaId: media.id, is4k: false });
    reach(tracker, media.id, 'playable');

    await reconcileJellyfin(undefined, tracker);

    assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');
  });
});

describe('Jellyfin poll', () => {
  const POLL_MS = 10_000;
  const video = { MediaSources: [{ MediaStreams: [{ Type: 'Video' }] }] };
  const jellyfinCalls = () => [
    mock.method(JellyfinAPI.prototype, 'getItemData', async () => video),
    mock.method(JellyfinAPI.prototype, 'getEpisodes', async () => []),
    mock.method(JellyfinAPI.prototype, 'getNewestItems', async () => []),
  ];

  it('makes a run in Jellyfin ready without socket events', async () => {
    const { media, tracker } = await setup({
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'abc',
    });
    const calls = jellyfinCalls();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      watchJellyfin(tracker);
      tracker.start({ mediaId: media.id, is4k: false });
      tracker.grab(media.id, false, { downloadId: 'D', unitIds: [0] });
      tracker.imported(media.id, false, { downloadId: 'D', unitIds: [0] });
      assert.equal(statusOf(tracker, media.id, 'inJellyfin').status, 'running');

      mock.timers.tick(POLL_MS);
      await settle();
      assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');

      // Nothing waits for Jellyfin any more, so the poll stops.
      const asked = calls[0].mock.callCount();
      mock.timers.tick(POLL_MS * 3);
      await settle();
      assert.equal(calls[0].mock.callCount(), asked);
    } finally {
      mock.timers.reset();
      calls.forEach((c) => c.mock.restore());
    }
  });

  it('links a new series without a Jellyfin item by its provider id', async () => {
    const { media, tracker } = await setup({
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      tmdbId: 1399,
      tvdbId: 121361,
    });
    tracker.start({
      mediaId: media.id,
      is4k: false,
      requestId: 1,
      seasons: [1],
    });
    tracker.setUnits(media.id, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
    ]);
    tracker.grab(media.id, false, { downloadId: 'D', unitIds: [101] });
    tracker.imported(media.id, false, { downloadId: 'D', unitIds: [101] });
    const newest = mock.method(
      JellyfinAPI.prototype,
      'getNewestItems',
      async () => [
        { Id: 'movie', Type: 'Movie', ProviderIds: { Tmdb: '1399' } },
        { Id: 'other', Type: 'Series', ProviderIds: { Tvdb: '1' } },
        { Id: 'series', Type: 'Series', ProviderIds: { Tvdb: '121361' } },
      ]
    );
    const scan = mock.method(jellyfinItemScanner, 'runItems', async () => {
      await getRepository(Media).update(media.id, {
        jellyfinMediaId: 'series',
      });
    });
    const episodes = mock.method(
      JellyfinAPI.prototype,
      'getEpisodes',
      async () => [{ ParentIndexNumber: 1, IndexNumber: 1, ...video }]
    );
    try {
      await pollJellyfin(tracker);
      assert.deepEqual(scan.mock.calls[0].arguments, [['series']]);
      assert.equal(episodes.mock.calls[0].arguments[0], 'series');
      assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');
    } finally {
      newest.mock.restore();
      scan.mock.restore();
      episodes.mock.restore();
    }
  });

  it('stops while its interval is 0 and resumes once it is set', async () => {
    const { media, tracker } = await setup({
      status: MediaStatus.AVAILABLE,
      jellyfinMediaId: 'abc',
    });
    const calls = jellyfinCalls();
    const settings = getSettings().requestProgress;
    settings.jellyfinCheckSeconds = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      watchJellyfin(tracker);
      tracker.start({ mediaId: media.id, is4k: false });
      tracker.grab(media.id, false, { downloadId: 'D', unitIds: [0] });
      tracker.imported(media.id, false, { downloadId: 'D', unitIds: [0] });
      mock.timers.tick(POLL_MS * 3);
      await settle();
      assert.equal(calls[0].mock.callCount(), 0);

      settings.jellyfinCheckSeconds = 30;
      mock.timers.tick(POLL_MS);
      await settle();
      mock.timers.tick(30_000);
      await settle();
      assert.equal(statusOf(tracker, media.id, 'playable').status, 'done');
    } finally {
      settings.jellyfinCheckSeconds = 10;
      mock.timers.reset();
      calls.forEach((c) => c.mock.restore());
    }
  });

  it('asks Jellyfin nothing while no run waits for it', async () => {
    const { media, tracker } = await setup({ jellyfinMediaId: 'abc' });
    const calls = jellyfinCalls();
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      watchJellyfin(tracker);
      tracker.start({ mediaId: media.id, is4k: false });
      tracker.grab(media.id, false, { downloadId: 'D', unitIds: [0] });
      await pollJellyfin(tracker);
      mock.timers.tick(POLL_MS * 3);
      await settle();
      assert.deepEqual(
        calls.map((c) => c.mock.callCount()),
        [0, 0, 0]
      );
    } finally {
      mock.timers.reset();
      calls.forEach((c) => c.mock.restore());
    }
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
    assert.equal(searching.detail, WAITING_FOR_RSS);
    assert.equal(searching.waiting, 'rss');
    assert.equal(tracker.get(media.id, false)!.dormant, true);
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

  it('has no run for a declined request', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.DECLINED);

    await reconstructProgress([{ mediaId: media.id, is4k: false }], tracker);

    assert.equal(tracker.entry(media.id, false), undefined);
  });

  it('rebuilds a completed request whose stored run never reached Ready', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.COMPLETED);
    const request = await getRepository(MediaRequest).findOneByOrFail({
      media: { id: media.id },
    });
    const stored = (playable: 'pending' | 'done') => ({
      mediaId: media.id,
      is4k: false,
      requests: [],
      steps: [{ key: 'playable' as const, status: playable }],
      estimatePercentile: 50 as const,
      finishedAt: requestedAt,
    });
    hasFile = true;

    await storeRun(stored('done'), [request.id]);
    await reconstructProgress([{ mediaId: media.id, is4k: false }], tracker);
    assert.equal(tracker.entry(media.id, false), undefined);

    await storeRun(stored('pending'), [request.id]);
    await reconstructProgress([{ mediaId: media.id, is4k: false }], tracker);
    const progress = tracker.get(media.id, false)!;
    assert.deepEqual(
      progress.requests.map((r) => r.id),
      [request.id]
    );
    assert.equal(statusOf(tracker, media.id, 'importing').status, 'done');
  });

  it('rebuilds a completed request whose stored run is unfinished', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.COMPLETED);
    const request = await getRepository(MediaRequest).findOneByOrFail({
      media: { id: media.id },
    });
    hasFile = true;

    // Ready already, but cut short before its final state was stored.
    await storeRun(
      {
        mediaId: media.id,
        is4k: false,
        requests: [],
        steps: [{ key: 'playable', status: 'done' }],
        estimatePercentile: 50,
      },
      [request.id]
    );
    await reconstructProgress(undefined, tracker);

    assert.deepEqual(
      tracker.get(media.id, false)!.requests.map((r) => r.id),
      [request.id]
    );
  });

  it('leaves media with a tracked run alone', async () => {
    const { media, tracker } = await setupRequest(MediaRequestStatus.APPROVED);
    tracker.start({ mediaId: media.id, is4k: false, serverKey: 'radarr-0' });
    const before = tracker.get(media.id, false);

    await reconstructProgress(undefined, tracker);

    assert.deepEqual(tracker.get(media.id, false), before);
  });
});

describe('storeRuns', () => {
  it('stores a run unfinished when it starts and final when it ends', async () => {
    const { media } = await setup();
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const request = await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.PENDING,
        media,
        requestedBy: user,
        modifiedBy: user,
      })
    );
    const tracker = new ProgressTracker(new StepStats());
    storeRuns(tracker);
    const stored = () =>
      getRepository(RequestProgressRun).findOne({
        where: { request: { id: request.id } },
      });

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      tracker.start({ mediaId: media.id, is4k: false, requestId: request.id });
      mock.timers.tick(DEBOUNCE_MS);
      await settle();
    } finally {
      mock.timers.reset();
    }
    const unfinished = await stored();
    assert.equal(unfinished?.finishedAt, null);
    assert.equal(JSON.parse(unfinished!.snapshot).requests[0].id, request.id);

    reach(tracker, media.id, 'playable');
    await settle();
    const final = await stored();
    assert.ok(final?.finishedAt);
    assert.equal(final.id, unfinished!.id);
  });
});

describe('syncRequests', () => {
  it('drops a deleted request and keeps the other one of the media', async () => {
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        tmdbId: 1,
        tvdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
      })
    );
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const requests = getRepository(MediaRequest);
    const [s1, s2] = await requests.save(
      [1, 2].map(
        (seasonNumber) =>
          new MediaRequest({
            type: MediaType.TV,
            status: MediaRequestStatus.APPROVED,
            media,
            requestedBy: user,
            seasons: [new SeasonRequest({ seasonNumber })],
          })
      )
    );
    const tracker = new ProgressTracker(new StepStats());
    tracker.start({ mediaId: media.id, is4k: false, requestId: s1.id });

    await syncRequests([media.id], tracker);
    assert.deepEqual(
      tracker.get(media.id, false)!.requests.map((r) => r.seasons),
      [[1], [2]]
    );

    await requests.remove(s1);
    await syncRequests([media.id], tracker);
    const progress = tracker.get(media.id, false)!;
    assert.deepEqual(
      progress.requests.map((r) => [r.id, r.seasons]),
      [[s2.id, [2]]]
    );

    await requests.remove(s2);
    await syncRequests([media.id], tracker);
    assert.equal(tracker.get(media.id, false), undefined);
  });
  it('starts a run awaiting approval for a new pending request and ends it once declined', async () => {
    const media = await getRepository(Media).save(
      Object.assign(new Media(), {
        id: 70,
        tmdbId: 1,
        tvdbId: 2,
        mediaType: MediaType.TV,
        status: MediaStatus.PENDING,
      })
    );
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const requests = getRepository(MediaRequest);
    const pending = (seasonNumber: number) =>
      requests.save(
        new MediaRequest({
          type: MediaType.TV,
          status: MediaRequestStatus.PENDING,
          media,
          requestedBy: user,
          modifiedBy: user,
          seasons: [new SeasonRequest({ seasonNumber })],
        })
      );
    const first = await pending(1);
    const more = await pending(2);

    const progress = progressTracker.get(media.id, false)!;
    assert.deepEqual(
      progress.requests.map((r) => [r.id, r.seasons]),
      [
        [first.id, [1]],
        [more.id, [2]],
      ]
    );
    assert.equal(
      statusOf(progressTracker, media.id, 'requested').status,
      'running'
    );
    assert.equal(
      statusOf(progressTracker, media.id, 'searching').status,
      'pending'
    );

    await requests.update(
      { id: In([first.id, more.id]) },
      { status: MediaRequestStatus.DECLINED }
    );
    await syncRequests([media.id]);
    assert.equal(progressTracker.entry(media.id, false), undefined);
  });

  it('keeps a completed request until its run is ready', async () => {
    const { media, tracker } = await setup();
    const user = await getRepository(User).findOneByOrFail({ id: 1 });
    const requests = getRepository(MediaRequest);
    const request = await requests.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media,
        requestedBy: user,
      })
    );
    // An older completed request of the media never joins the run.
    await requests.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: user,
      })
    );
    tracker.start({ mediaId: media.id, is4k: false, requestId: request.id });
    const finished: string[] = [];
    tracker.on('finished', (p) =>
      finished.push(p.steps.find((s) => s.key === 'playable')!.status)
    );
    reach(tracker, media.id, 'grabbed');

    await requests.update(request.id, {
      status: MediaRequestStatus.COMPLETED,
    });
    await syncRequests([media.id], tracker);
    assert.deepEqual(
      tracker.get(media.id, false)!.requests.map((r) => r.id),
      [request.id]
    );
    assert.deepEqual(finished, []);

    reach(tracker, media.id, 'playable');
    assert.deepEqual(finished, ['done']);
    await syncRequests([media.id], tracker);
    assert.equal(tracker.get(media.id, false), undefined);
    assert.deepEqual(finished, ['done']);
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
    const friend = await users.findOneByOrFail({ email: 'demo@seerr.dev' });
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
    // The singleton outlives the test; Jellyfin checks below would recover its run.
    (
      progressTracker as unknown as { entries: Map<string, unknown> }
    ).entries.clear();
  });
});

describe('onSignalRMessage', () => {
  it('syncs each changed item once per burst of events', async () => {
    const syncMovie = mock.method(radarrScanner, 'syncMovie', async () => {});
    const syncSeries = mock.method(sonarrScanner, 'syncSeries', async () => {});
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      onSignalRMessage(radarr, { type: 'movie', action: 'updated', id: 42 });
      onSignalRMessage(radarr, {
        type: 'movieFile',
        action: 'deleted',
        id: 9,
        movieId: 42,
      });
      onSignalRMessage(radarr, { type: 'movie', action: 'deleted', id: 7 });
      onSignalRMessage(
        { type: 'sonarr', serverId: 1 },
        { type: 'episodeFile', action: 'deleted', id: 3, seriesId: 5 }
      );
      onSignalRMessage(
        { type: 'sonarr', serverId: 1 },
        { type: 'series', action: 'updated', id: 5 }
      );
      assert.equal(syncMovie.mock.callCount(), 0);

      mock.timers.tick(DEBOUNCE_MS);
      await new Promise(setImmediate);

      assert.deepEqual(
        syncMovie.mock.calls.map((c) => c.arguments),
        [
          [0, 42],
          [0, 7],
        ]
      );
      assert.deepEqual(
        syncSeries.mock.calls.map((c) => c.arguments),
        [[1, 5]]
      );
    } finally {
      mock.timers.reset();
      syncMovie.mock.restore();
      syncSeries.mock.restore();
    }
  });
});

describe('onSignalRMessage refresh', () => {
  it('shows a grab during a long search while queue events keep coming', async () => {
    const { media } = await setup();
    progressTracker.start({
      mediaId: media.id,
      is4k: false,
      serverKey: 'radarr-0',
    });
    // Date too: the debounce measures its maximum wait with Date.now.
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    try {
      history = [
        {
          eventType: 'grabbed',
          date: new Date().toISOString(),
          movieId: 42,
          downloadId: 'D',
        },
      ];
      // A download sends queue updates more often than the debounce delay.
      for (let t = 0; t < SERVER_REFRESH_MAX_WAIT_MS; t += 1000) {
        onSignalRMessage(radarr, { type: 'queue' });
        mock.timers.tick(1000);
      }
      await settle();
      assert.equal(
        statusOf(progressTracker, media.id, 'grabbed').status,
        'running'
      );
    } finally {
      mock.timers.reset();
      (
        progressTracker as unknown as { entries: Map<string, unknown> }
      ).entries.clear();
    }
  });
});

/** Sends a completed search command and lets the debounced refresh behind it run. */
async function completeSearch(event: CommandEvent, tracker: ProgressTracker) {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await handleCommand(radarr, event, tracker);
    mock.timers.tick(DEBOUNCE_MS);
    await settle();
  } finally {
    mock.timers.reset();
  }
}

// Lets the database lookups behind the handlers finish; only setTimeout is mocked.
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise(setImmediate);
}

describe('content removed in Radarr/Sonarr', () => {
  it('checks each available media once after the removal events settle', async () => {
    const sonarr = { type: 'sonarr', serverId: 1 } as const;
    const { media: movie } = await setup({ status: MediaStatus.AVAILABLE });
    const series = Object.assign(new Media(), {
      tmdbId: 552,
      mediaType: MediaType.TV,
      status: MediaStatus.AVAILABLE,
      serviceId: 1,
      externalServiceId: 5,
    });
    const grabbing = Object.assign(new Media(), {
      tmdbId: 553,
      mediaType: MediaType.TV,
      status: MediaStatus.PARTIALLY_AVAILABLE,
      serviceId: 1,
      externalServiceId: 6,
    });
    await getRepository(Media).save([series, grabbing]);
    const syncMedia = mock.method(
      availabilitySync,
      'syncMedia',
      async () => {}
    );
    const syncMovie = mock.method(radarrScanner, 'syncMovie', async () => {});
    const syncSeries = mock.method(sonarrScanner, 'syncSeries', async () => {});
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // A deleted season as Sonarr v4 reports it: file ids only, then the episodes and series.
      for (const id of [1, 2, 3]) {
        onSignalRMessage(sonarr, {
          type: 'episodeFile',
          action: 'deleted',
          id,
        });
        onSignalRMessage(sonarr, {
          type: 'episode',
          action: 'updated',
          id: 100 + id,
          seriesId: 5,
          episodeFileId: 0,
          hasFile: false,
        });
      }
      onSignalRMessage(sonarr, { type: 'series', action: 'updated', id: 5 });
      onSignalRMessage(sonarr, {
        type: 'episode',
        action: 'updated',
        id: 200,
        seriesId: 6,
        hasFile: false,
        grabbed: true,
      });
      // A deleted movie file as Radarr reports it.
      onSignalRMessage(radarr, { type: 'movieFile', action: 'deleted', id: 9 });
      onSignalRMessage(radarr, {
        type: 'movie',
        action: 'updated',
        id: 42,
        hasFile: false,
      });
      await settle();
      mock.timers.tick(REMOVAL_DEBOUNCE_MS - 1);
      await settle();
      assert.equal(syncMedia.mock.callCount(), 0);

      mock.timers.tick(1);
      await settle();
      assert.deepEqual(
        syncMedia.mock.calls.map((c) => c.arguments).sort(),
        [[movie.id], [series.id]].sort()
      );
    } finally {
      mock.timers.reset();
      syncMedia.mock.restore();
      syncMovie.mock.restore();
      syncSeries.mock.restore();
    }
  });
});

describe('onJellyfinRemoved', () => {
  it('checks each movie or series behind removed items once per burst', async () => {
    const { media } = await setup({ jellyfinMediaId: 'jf-movie' });
    const uhd = Object.assign(new Media(), {
      tmdbId: 551,
      mediaType: MediaType.TV,
      jellyfinMediaId4k: 'jf-series-4k',
    });
    await getRepository(Media).save(uhd);
    const syncMedia = mock.method(
      availabilitySync,
      'syncMedia',
      async () => {}
    );
    const run = mock.method(availabilitySync, 'run', async () => {});
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await onJellyfinRemoved(['jf-movie']);
      await onJellyfinRemoved(['jf-movie', 'jf-series-4k']);
      assert.equal(syncMedia.mock.callCount(), 0);

      mock.timers.tick(REMOVAL_DEBOUNCE_MS);
      await settle();

      assert.deepEqual(
        syncMedia.mock.calls.map((c) => c.arguments).sort(),
        [[media.id], [uhd.id]].sort()
      );
      assert.equal(run.mock.callCount(), 0);
    } finally {
      mock.timers.reset();
      syncMedia.mock.restore();
      run.mock.restore();
    }
  });

  it('runs the full availability sync once for a burst of unknown items', async () => {
    const run = mock.method(availabilitySync, 'run', async () => {});
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await onJellyfinRemoved(['jf-episode-1', 'jf-season']);
      mock.timers.tick(FULL_SYNC_DEBOUNCE_MS - 1);
      await onJellyfinRemoved(['jf-episode-2']);
      mock.timers.tick(FULL_SYNC_DEBOUNCE_MS - 1);
      await settle();
      assert.equal(run.mock.callCount(), 0);

      mock.timers.tick(1);
      await settle();
      assert.equal(run.mock.callCount(), 1);
    } finally {
      mock.timers.reset();
      run.mock.restore();
    }
  });
});
