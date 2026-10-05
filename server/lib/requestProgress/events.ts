import jellyfinSocket from '@server/api/jellyfin-socket';
import type { HistoryRecord } from '@server/api/servarr/base';
import RadarrAPI from '@server/api/servarr/radarr';
import type {
  CommandEvent,
  ServarrSignalREvent,
  ServarrType,
  SignalRSource,
} from '@server/api/servarr/signalr';
import { servarrSignalR } from '@server/api/servarr/signalr';
import SonarrAPI from '@server/api/servarr/sonarr';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import type {
  ProgressDownload,
  RequestProgressStatsResponse,
} from '@server/interfaces/api/progressInterfaces';
import downloadTracker from '@server/lib/downloadtracker';
import { KeyedDebouncer } from '@server/lib/requestProgress/debounce';
import type { RequestStart } from '@server/lib/requestProgress/stepStats';
import stepStats from '@server/lib/requestProgress/stepStats';
import type {
  ProgressTracker,
  TrackedProgress,
} from '@server/lib/requestProgress/tracker';
import progressTracker from '@server/lib/requestProgress/tracker';
import {
  jellyfinItemScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, MoreThanOrEqual } from 'typeorm';

const serverKey = (type: ServarrType, serverId: number) =>
  `${type}-${serverId}`;

const externalId = (media: Media, is4k: boolean) =>
  is4k ? media.externalServiceId4k : media.externalServiceId;

function servarrApi(type: ServarrType, serverId: number) {
  const settings = getSettings()[type].find((s) => s.id === serverId);
  if (!settings) return undefined;
  const Api = type === 'radarr' ? RadarrAPI : SonarrAPI;
  return new Api({
    apiKey: settings.apiKey,
    url: Api.buildUrl(settings, '/api/v3'),
  });
}

/** Media variants served by this Radarr/Sonarr item. */
async function findMedia(
  { type, serverId }: SignalRSource,
  arrId: number
): Promise<{ media: Media; is4k: boolean }[]> {
  const mediaType = type === 'radarr' ? MediaType.MOVIE : MediaType.TV;
  const repo = getRepository(Media);
  const [standard, uhd] = await Promise.all([
    repo.findOneBy({
      mediaType,
      serviceId: serverId,
      externalServiceId: arrId,
    }),
    repo.findOneBy({
      mediaType,
      serviceId4k: serverId,
      externalServiceId4k: arrId,
    }),
  ]);
  return [
    ...(standard ? [{ media: standard, is4k: false }] : []),
    ...(uhd ? [{ media: uhd, is4k: true }] : []),
  ];
}

async function loadMedia(entries: TrackedProgress[]) {
  const media = await getRepository(Media).findBy({
    id: In(entries.map((e) => e.mediaId)),
  });
  return new Map(media.map((m) => [m.id, m]));
}

const isWaiting = (status: MediaStatus) =>
  status === MediaStatus.PENDING || status === MediaStatus.PROCESSING;

const isAvailable = (status: MediaStatus) =>
  status === MediaStatus.AVAILABLE ||
  status === MediaStatus.PARTIALLY_AVAILABLE;

const SEARCH_FAILED = ['failed', 'aborted', 'cancelled', 'orphaned'];
const IMPORT_BLOCKED = 'Manual interaction required';
const DOWNLOAD_FAILED = 'Download failed';
const NO_RESULTS = 'No results';

// Sonarr episode searches carry episode ids only; episode messages and the API link them to series.
// ponytail: unbounded until it hits the cap, then starts over; an LRU if that ever matters.
const episodeSeries = new Map<string, number>();

export function rememberEpisode(
  serverId: number,
  episodeId: number,
  seriesId: number
) {
  if (episodeSeries.size > 10_000) episodeSeries.clear();
  episodeSeries.set(`${serverId}:${episodeId}`, seriesId);
}

async function commandArrIds(
  source: SignalRSource,
  event: CommandEvent
): Promise<number[]> {
  if (event.movieIds) return event.movieIds;
  if (event.seriesId) return [event.seriesId];
  const ids = new Set<number>();
  for (const episodeId of event.episodeIds ?? []) {
    let seriesId = episodeSeries.get(`${source.serverId}:${episodeId}`);
    if (seriesId === undefined) {
      const api = servarrApi('sonarr', source.serverId) as
        | SonarrAPI
        | undefined;
      seriesId = (await api?.getEpisode(episodeId))?.seriesId;
      if (seriesId !== undefined) {
        rememberEpisode(source.serverId, episodeId, seriesId);
      }
    }
    if (seriesId !== undefined) ids.add(seriesId);
  }
  return [...ids];
}

// A search repeats its command message per processed release with the same ids.
// ponytail: cleared at the cap, in case terminal messages of some commands never arrive.
const commandMedia = new Map<
  string,
  Promise<{ media: Media; is4k: boolean }[]>
>();

async function findCommandMedia(source: SignalRSource, event: CommandEvent) {
  const cacheKey = `${serverKey(source.type, source.serverId)}:${event.id}`;
  let found = commandMedia.get(cacheKey);
  if (!found) {
    if (commandMedia.size > 1_000) commandMedia.clear();
    found = commandArrIds(source, event).then(async (arrIds) =>
      (await Promise.all(arrIds.map((id) => findMedia(source, id)))).flat()
    );
    commandMedia.set(cacheKey, found);
    found.catch(() => commandMedia.delete(cacheKey));
  }
  if (event.status === 'completed' || SEARCH_FAILED.includes(event.status)) {
    commandMedia.delete(cacheKey);
  }
  return found;
}

export async function handleCommand(
  source: SignalRSource,
  event: CommandEvent,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const key = serverKey(source.type, source.serverId);
  for (const { media, is4k } of await findCommandMedia(source, event)) {
    const entry = tracker.entry(media.id, is4k);
    if (event.status === 'started') {
      const downloadFailed = Object.values(entry?.steps ?? {}).some(
        (s) => s.error === DOWNLOAD_FAILED
      );
      // An automatic search on a grabbed item is housekeeping, not a new attempt.
      const userResearch =
        event.trigger === 'manual' &&
        entry?.steps.grabbed.status === 'done' &&
        entry.steps.playable.status !== 'done';
      if (downloadFailed || userResearch) {
        tracker.research(media.id, is4k);
      } else if (!entry && isWaiting(is4k ? media.status4k : media.status)) {
        // Covers requests sent before a restart or added in Radarr/Sonarr directly.
        tracker.ensure({ mediaId: media.id, is4k, serverKey: key });
      }
    } else if (entry?.steps.searching.status === 'running') {
      if (event.status === 'completed') {
        if (event.reportsDownloaded === 0) {
          tracker.fail(media.id, is4k, NO_RESULTS);
        } else if (event.reportsDownloaded === undefined) {
          tracker.searchCompleted(media.id, is4k);
        }
      } else if (SEARCH_FAILED.includes(event.status)) {
        tracker.fail(
          media.id,
          is4k,
          `Search failed${event.message ? `: ${event.message}` : ''}`
        );
      }
    }

    // The search that runs while searching owns the detail, up to its final report count.
    const current = tracker.entry(media.id, is4k);
    if (
      event.message &&
      current &&
      (current.steps.searching.status === 'running' ||
        current.searchCommandId === event.id)
    ) {
      current.searchCommandId = event.id;
      tracker.setDetail(media.id, is4k, 'searching', event.message);
    }
  }
  if (event.status === 'completed') serverRefresh.push(key);
}

interface ArrItem {
  movieId?: number;
  seriesId?: number;
  episode?: { seasonNumber: number };
}

/** Seasons of the request behind each tracked series; absent when no request is found. */
async function requestedSeasons(
  entries: TrackedProgress[]
): Promise<Map<TrackedProgress, Set<number>>> {
  const requests = await getRepository(MediaRequest).find({
    where: { media: { id: In(entries.map((e) => e.mediaId)) } },
    order: { id: 'DESC' },
  });
  const seasons = new Map<TrackedProgress, Set<number>>();
  for (const entry of entries) {
    // Entries started from a search event carry no request id; the newest request stands in.
    const request = requests.find((r) =>
      entry.requestId !== undefined
        ? r.id === entry.requestId
        : r.media.id === entry.mediaId && r.is4k === entry.is4k
    );
    if (request) {
      seasons.set(entry, new Set(request.seasons.map((s) => s.seasonNumber)));
    }
  }
  return seasons;
}

/** Milliseconds until a queue item completes, as the download client estimates it. */
export function queueEtaMs(
  item: { timeleft?: string; estimatedCompletionTime?: string },
  now = Date.now()
): number | undefined {
  const at = Date.parse(item.estimatedCompletionTime ?? '');
  if (!Number.isNaN(at)) return Math.max(0, at - now);
  // [d.]hh:mm:ss
  const m = item.timeleft?.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+)/);
  if (!m) return undefined;
  const [days, hours, minutes, seconds] = m.slice(1).map((v) => Number(v ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * Brings the tracked media of one Radarr/Sonarr server up to date from its history (grab and
 * import times, download ids, release titles) and queue (downloads, blocked or failed ones).
 */
export async function refreshServer(
  key: string,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const [type, id] = key.split('-') as [ServarrType, string];
  const entries = tracker.incomplete().filter((e) => e.serverKey === key);
  const api = servarrApi(type, Number(id));
  if (entries.length === 0 || !api) return;

  const media = await loadMedia(entries);
  const byArrId = new Map<number, TrackedProgress[]>();
  for (const entry of entries) {
    const m = media.get(entry.mediaId);
    const arrId = m && externalId(m, entry.is4k);
    if (arrId) byArrId.set(arrId, [...(byArrId.get(arrId) ?? []), entry]);
  }
  if (byArrId.size === 0) return;

  // Per item: the history of a whole server since an old request can be too large to load.
  const [histories, queue, seasons] = await Promise.all([
    Promise.all(
      [...byArrId.keys()].map((arrId) =>
        api.getItemHistory(arrId).catch((e: Error) => {
          logger.warn(`Loading item history failed: ${e.message}`, {
            label: 'Request Progress',
            server: key,
            arrId,
          });
          return [];
        })
      )
    ),
    api.getQueue(),
    type === 'sonarr' ? requestedSeasons(entries) : undefined,
  ]);
  const history = histories.flat();
  // Records of the same series can belong to seasons another request asked for.
  const entriesOf = (item: ArrItem) =>
    (
      byArrId.get((type === 'radarr' ? item.movieId : item.seriesId) ?? -1) ??
      []
    ).filter((entry) => {
      const wanted = seasons?.get(entry);
      const season = item.episode?.seasonNumber;
      return !wanted || season === undefined || wanted.has(season);
    });

  const grabbedTitles = new Map<TrackedProgress, Set<string>>();
  const indexers = new Map<string, string>();
  const ascending = [...history].sort(
    (a, b) => Date.parse(a.date) - Date.parse(b.date)
  );
  for (const record of ascending as HistoryRecord[]) {
    const at = Date.parse(record.date);
    for (const entry of entriesOf(record)) {
      const { mediaId, is4k } = entry;
      // The item history holds the records of earlier requests too.
      if (
        at < (entry.steps.requested.startedAt ?? 0) ||
        (record.downloadId &&
          entry.staleDownloadIds.includes(record.downloadId))
      ) {
        continue;
      }
      if (record.eventType === 'grabbed') {
        tracker.advance(mediaId, is4k, 'grabbed', at, {
          downloadId: record.downloadId,
        });
        grabbedTitles.set(
          entry,
          (grabbedTitles.get(entry) ?? new Set()).add(record.sourceTitle)
        );
        if (record.downloadId && record.data?.indexer) {
          indexers.set(record.downloadId, record.data.indexer);
        }
      } else if (record.eventType === 'downloadFolderImported') {
        tracker.advance(mediaId, is4k, 'importing', at);
      } else if (record.eventType === 'downloadFailed') {
        tracker.fail(mediaId, is4k, DOWNLOAD_FAILED, at);
      }
    }
  }
  for (const [entry, titles] of grabbedTitles) {
    tracker.setDetail(
      entry.mediaId,
      entry.is4k,
      'grabbed',
      [...titles].join(', ')
    );
  }

  // Keyed by downloadId: Sonarr lists a season pack once per episode.
  const downloads = new Map<TrackedProgress, Map<string, ProgressDownload>>();
  for (const item of queue as ((typeof queue)[number] & ArrItem)[]) {
    const state = item.trackedDownloadState;
    const reason =
      (state === 'importBlocked' || state === 'importPending') &&
      item.trackedDownloadStatus === 'warning'
        ? IMPORT_BLOCKED
        : state === 'failedPending' || state === 'failed'
          ? DOWNLOAD_FAILED
          : undefined;
    for (const entry of entriesOf(item)) {
      if (entry.staleDownloadIds.includes(item.downloadId)) continue;
      const own = downloads.get(entry) ?? new Map();
      own.set(item.downloadId, {
        title: item.title,
        indexer: item.indexer || indexers.get(item.downloadId),
        size: item.size,
        sizeLeft: item.sizeleft,
        etaMs: queueEtaMs(item),
      });
      downloads.set(entry, own);
      if (reason && entry.steps.importing.status !== 'done') {
        tracker.fail(entry.mediaId, entry.is4k, reason);
      }
    }
  }
  for (const entry of entries) {
    const own = downloads.get(entry);
    tracker.setDownloads(
      entry.mediaId,
      entry.is4k,
      own ? [...own.values()] : undefined
    );
  }

  for (const entry of entries) {
    if (entry.searchCompletedAt && entry.steps.grabbed.status !== 'done') {
      tracker.fail(entry.mediaId, entry.is4k, NO_RESULTS);
    }
  }
}

/** Advances tracked media that the Jellyfin scanners linked to an item or made available. */
export async function reconcileJellyfin(
  addedAt?: number,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const entries = tracker.active();
  if (entries.length === 0) return;
  const media = await loadMedia(entries);
  for (const { mediaId, is4k } of entries) {
    const m = media.get(mediaId);
    if (!m) continue;
    if (is4k ? m.jellyfinMediaId4k : m.jellyfinMediaId) {
      tracker.advance(mediaId, is4k, 'inJellyfin', addedAt);
    }
    const status = is4k ? m.status4k : m.status;
    if (
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE
    ) {
      tracker.advance(mediaId, is4k, 'playable', undefined, {
        playUrl: is4k ? m.mediaUrl4k : m.mediaUrl,
      });
    }
  }
}

const REQUEST_DECLINED = 'Request declined';
const REQUEST_FAILED = 'Request failed';
const WAITING_FOR_RELEASE = 'No release found yet, waiting for one';

/** Whether Radarr/Sonarr holds a file for the media, for requested seasons only. */
async function hasFiles(
  entry: TrackedProgress,
  arrId: number,
  seasons: Set<number> | undefined
): Promise<boolean> {
  const [type, id] = entry.serverKey?.split('-') ?? [];
  const api = servarrApi(type as ServarrType, Number(id));
  if (api instanceof RadarrAPI)
    return (await api.getMovie({ id: arrId })).hasFile;
  if (!(api instanceof SonarrAPI)) return false;
  const series = await api.getSeriesById(arrId);
  return series.seasons.some(
    (s) =>
      (!seasons || seasons.has(s.seasonNumber)) &&
      (s.statistics?.episodeFileCount ?? 0) > 0
  );
}

/**
 * Starts entries for media whose newest request the tracker never saw, e.g. one sent before a
 * restart, and fills them in from Radarr/Sonarr history, queue and files and from Jellyfin, as a
 * run would have. Without `targets`, covers every open request. Their times are not measured.
 */
export async function reconstructProgress(
  targets?: { mediaId: number; is4k: boolean }[],
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const requests = await getRepository(MediaRequest).find({
    where: targets
      ? { media: { id: In(targets.map((t) => t.mediaId)) } }
      : {
          status: In([MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED]),
        },
    order: { id: 'DESC' },
  });
  const settings = getSettings();
  const seen = new Set<string>();
  const created: TrackedProgress[] = [];
  for (const request of requests) {
    const { media, is4k } = request;
    const variant = `${media.id}:${is4k}`;
    if (seen.has(variant)) continue;
    seen.add(variant);
    if (
      (targets &&
        !targets.some((t) => t.mediaId === media.id && t.is4k === is4k)) ||
      tracker.entry(media.id, is4k)
    ) {
      continue;
    }
    const mediaStatus = is4k ? media.status4k : media.status;
    const open =
      request.status === MediaRequestStatus.PENDING ||
      request.status === MediaRequestStatus.APPROVED;
    const failed =
      request.status === MediaRequestStatus.DECLINED ||
      request.status === MediaRequestStatus.FAILED;
    if (
      !(open && isWaiting(mediaStatus)) &&
      !(failed && !isAvailable(mediaStatus))
    ) {
      continue;
    }

    const type = request.type === MediaType.MOVIE ? 'radarr' : 'sonarr';
    const serverId =
      (is4k ? media.serviceId4k : media.serviceId) ??
      request.serverId ??
      settings[type].find((s) => !!s.is4k === is4k && s.isDefault)?.id;
    const entry = tracker.start({
      mediaId: media.id,
      is4k,
      requestId: request.id,
      serverKey:
        serverId === undefined || serverId === null
          ? undefined
          : serverKey(type, serverId),
      at: request.createdAt.getTime(),
      awaitingApproval:
        request.status === MediaRequestStatus.PENDING ||
        request.status === MediaRequestStatus.DECLINED,
      reconstructed: true,
    });
    if (failed) {
      tracker.fail(
        media.id,
        is4k,
        request.status === MediaRequestStatus.DECLINED
          ? REQUEST_DECLINED
          : REQUEST_FAILED,
        request.updatedAt.getTime()
      );
    } else if (request.status === MediaRequestStatus.APPROVED) {
      created.push(entry);
    }
  }
  if (created.length === 0) return;

  for (const key of new Set(created.flatMap((e) => e.serverKey ?? []))) {
    await refreshServer(key, tracker);
  }
  const media = await loadMedia(created);
  const seasons = await requestedSeasons(created);
  for (const entry of created) {
    const m = media.get(entry.mediaId);
    const arrId = m && externalId(m, entry.is4k);
    if (!arrId || entry.steps.importing.status === 'done') continue;
    try {
      if (await hasFiles(entry, arrId, seasons.get(entry))) {
        tracker.advance(entry.mediaId, entry.is4k, 'importing');
      }
    } catch (e) {
      logger.warn(`Looking up files failed: ${e.message}`, {
        label: 'Request Progress',
        server: entry.serverKey,
      });
    }
  }
  await reconcileJellyfin(undefined, tracker);
  for (const entry of created) {
    if (
      entry.steps.searching.status === 'running' &&
      !entry.steps.searching.detail
    ) {
      tracker.setDetail(
        entry.mediaId,
        entry.is4k,
        'searching',
        WAITING_FOR_RELEASE
      );
    }
  }
}

const serverRefresh = new KeyedDebouncer((key) => refreshServer(key));

// Full polls, run once after a connection (re)starts since neither socket replays missed events.
const polls = new KeyedDebouncer(async (key) => {
  if (key === 'downloads') return downloadTracker.updateDownloads();
  if (!jellyfinRecentScanner.status().running) {
    await jellyfinRecentScanner.run();
  }
  await reconcileJellyfin();
});

const jellyfinAdded = new KeyedDebouncer<{ ids: string[]; at: number }>(
  async (_key, batches) => {
    await jellyfinItemScanner.runItems([
      ...new Set(batches.flatMap((b) => b.ids)),
    ]);
    await reconcileJellyfin(Math.min(...batches.map((b) => b.at)));
  }
);

function onSignalRConnected(source: SignalRSource, first: boolean): void {
  const key = serverKey(source.type, source.serverId);
  polls.push('downloads');
  serverRefresh.push(key);
  if (first) refreshStepHistory(source.type, source.serverId);
}

/**
 * Requests sent to a server since a date. Only auto-approved ones: for the others, the time until
 * an admin approved them is not part of the search.
 */
export async function requestStarts(
  type: ServarrType,
  serverId: number,
  since: Date
): Promise<RequestStart[]> {
  const server = getSettings()[type].find((s) => s.id === serverId);
  if (!server) return [];
  // An undefined condition would match both variants.
  const is4k = server.is4k === true;
  const requests = await getRepository(MediaRequest).find({
    where: {
      type: type === 'radarr' ? MediaType.MOVIE : MediaType.TV,
      is4k,
      status: In([MediaRequestStatus.APPROVED, MediaRequestStatus.COMPLETED]),
      createdAt: MoreThanOrEqual(since),
      media: is4k ? { serviceId4k: serverId } : { serviceId: serverId },
    },
  });
  return requests.flatMap((request) => {
    const arrId = externalId(request.media, is4k);
    return arrId && request.modifiedBy?.id === request.requestedBy?.id
      ? [
          {
            at: request.createdAt.getTime(),
            arrId,
            seasons:
              type === 'sonarr'
                ? request.seasons.map((s) => s.seasonNumber)
                : undefined,
          },
        ]
      : [];
  });
}

function refreshStepHistory(type: ServarrType, serverId: number): void {
  const key = serverKey(type, serverId);
  const api = servarrApi(type, serverId);
  if (!api) return;
  stepStats
    .refresh(key, api, (since) => requestStarts(type, serverId, since))
    .catch((e: Error) =>
      logger.warn(`Loading step history failed: ${e.message}`, {
        label: 'Request Progress',
        server: key,
      })
    );
}

/** Sample counts and percentiles per Radarr/Sonarr server, for the settings page. */
export function requestProgressStats(): RequestProgressStatsResponse {
  const settings = getSettings();
  return {
    servers: (['radarr', 'sonarr'] as const).flatMap((type) =>
      settings[type].map((server) => {
        const key = serverKey(type, server.id);
        return {
          serverKey: key,
          name: server.name,
          steps: stepStats.get(key),
          total: stepStats.total(key),
        };
      })
    ),
  };
}

/** Rebuilds the step samples, e.g. after their window settings changed. */
export async function reloadStepStats(): Promise<void> {
  await stepStats.load();
  const settings = getSettings();
  for (const type of ['radarr', 'sonarr'] as const) {
    for (const server of settings[type]) refreshStepHistory(type, server.id);
  }
}

function onSignalRMessage(
  source: SignalRSource,
  event: ServarrSignalREvent
): void {
  if (event.type === 'command') {
    handleCommand(source, event).catch((e: Error) =>
      logger.error(`Handling a command event failed: ${e.message}`, {
        label: 'Request Progress',
      })
    );
  } else if (event.type === 'episode' && event.seriesId !== undefined) {
    rememberEpisode(source.serverId, event.id, event.seriesId);
  } else if (
    event.type === 'queue' ||
    event.type === 'movieFile' ||
    event.type === 'episodeFile'
  ) {
    serverRefresh.push(serverKey(source.type, source.serverId));
  }
}

export function restartJellyfinSocket(): void {
  jellyfinSocket.stop();
  if (getSettings().main.mediaServerType === MediaServerType.JELLYFIN) {
    jellyfinSocket.start();
  }
}

export function startProgressEvents(): void {
  stepStats.load().catch((e: Error) =>
    logger.warn(`Loading step samples failed: ${e.message}`, {
      label: 'Request Progress',
    })
  );
  reconstructProgress().catch((e: Error) =>
    logger.warn(`Reconstructing open requests failed: ${e.message}`, {
      label: 'Request Progress',
    })
  );
  servarrSignalR.on('connected', (s) => onSignalRConnected(s, true));
  servarrSignalR.on('reconnected', (s) => onSignalRConnected(s, false));
  servarrSignalR.on('message', onSignalRMessage);

  const jellyfinPoll = () => polls.push('jellyfin');
  jellyfinSocket.on('connected', jellyfinPoll);
  jellyfinSocket.on('reconnected', jellyfinPoll);
  jellyfinSocket.on('libraryChanged', (event) => {
    if (event.itemsAdded.length > 0) {
      jellyfinAdded.push('added', { ids: event.itemsAdded, at: Date.now() });
    }
  });

  servarrSignalR.start();
  restartJellyfinSocket();
}
