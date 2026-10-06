import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import JellyfinAPI from '@server/api/jellyfin';
import jellyfinSocket from '@server/api/jellyfin-socket';
import type { HistoryRecord } from '@server/api/servarr/base';
import { isNotFound } from '@server/api/servarr/base';
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
import { User } from '@server/entity/User';
import type {
  RequestProgress,
  RequestProgressStatsResponse,
} from '@server/interfaces/api/progressInterfaces';
import availabilitySync from '@server/lib/availabilitySync';
import downloadTracker from '@server/lib/downloadtracker';
import {
  DEBOUNCE_MS,
  KeyedDebouncer,
} from '@server/lib/requestProgress/debounce';
import {
  storeRun,
  unfinishedCompletedRequests,
} from '@server/lib/requestProgress/history';
import type { RequestStart } from '@server/lib/requestProgress/stepStats';
import stepStats from '@server/lib/requestProgress/stepStats';
import type {
  ProgressTracker,
  QueueItemState,
  TrackedProgress,
  TrackedRequest,
  Unit,
} from '@server/lib/requestProgress/tracker';
import progressTracker from '@server/lib/requestProgress/tracker';
import {
  jellyfinItemScanner,
  jellyfinRecentScanner,
} from '@server/lib/scanners/jellyfin';
import { radarrScanner } from '@server/lib/scanners/radarr';
import { sonarrScanner } from '@server/lib/scanners/sonarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { In, MoreThanOrEqual } from 'typeorm';

const serverKey = (type: ServarrType, serverId: number) =>
  `${type}-${serverId}`;

export const externalId = (media: Media, is4k: boolean) =>
  is4k ? media.externalServiceId4k : media.externalServiceId;

/** The Radarr/Sonarr server a request went to, or goes to once approved. */
export function requestServer(
  request: MediaRequest
): { type: ServarrType; serverId: number } | undefined {
  const { media, is4k } = request;
  const type = request.type === MediaType.MOVIE ? 'radarr' : 'sonarr';
  const serverId =
    (is4k ? media.serviceId4k : media.serviceId) ??
    request.serverId ??
    getSettings()[type].find((s) => !!s.is4k === is4k && s.isDefault)?.id;
  return serverId === undefined || serverId === null
    ? undefined
    : { type, serverId };
}

export function servarrApi(type: ServarrType, serverId: number) {
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
  const ended =
    event.status === 'completed' || SEARCH_FAILED.includes(event.status);
  const cause = `${key} command ${event.id} ${event.status}`;
  for (const { media, is4k } of await findCommandMedia(source, event)) {
    if (
      event.status === 'started' &&
      !tracker.entry(media.id, is4k) &&
      isWaiting(is4k ? media.status4k : media.status)
    ) {
      // Covers requests sent before a restart or added in Radarr/Sonarr directly.
      tracker.ensure({ mediaId: media.id, is4k, serverKey: key });
    }
    const entry = tracker.entry(media.id, is4k);
    if (!entry) continue;
    if (event.status === 'completed') {
      // Applied once the refresh read the history: before it, a grab of this search still looks
      // like no result and the units would flash waiting for RSS.
      serverRefresh.push(key, {
        finished: {
          tracker,
          mediaId: media.id,
          is4k,
          commandId: event.id,
          at: Date.now(),
          cause,
        },
      });
    } else if (ended) {
      tracker.searchFinished(media.id, is4k, {
        commandId: event.id,
        error: `Search failed${event.message ? `: ${event.message}` : ''}`,
        cause,
      });
    } else {
      const indexers = event.message?.match(/(\d+) active indexers?/)?.[1];
      tracker.setSearch(
        media.id,
        is4k,
        {
          searchCommandId: event.id,
          searchIndexers:
            indexers === undefined
              ? entry.searchCommandId === event.id
                ? entry.searchIndexers
                : undefined
              : Number(indexers),
        },
        { cause }
      );
    }
  }
  if (event.status === 'completed') serverRefresh.push(key);
}

interface FinishedSearch {
  tracker: ProgressTracker;
  mediaId: number;
  is4k: boolean;
  commandId: number;
  at: number;
  cause: string;
}

interface ArrItem {
  movieId?: number;
  seriesId?: number;
  episodeId?: number;
  episode?: { seasonNumber: number };
}

/**
 * Seasons of the requests behind a tracked series that went to Sonarr, or of all its requests
 * while each awaits approval; absent without requests or for a movie.
 */
function requestedSeasons(entry: TrackedProgress): Set<number> | undefined {
  const all = [...entry.requests.values()];
  const sent = all.filter((r) => !r.awaitingApproval);
  const requests = sent.length > 0 ? sent : all;
  if (requests.length === 0 || requests.some((r) => !r.seasons)) {
    return undefined;
  }
  return new Set(requests.flatMap((r) => r.seasons ?? []));
}

// Deleted and declined requests leave the run; completed ones once it is over, see syncRequests.
const ACTIVE_REQUEST = [
  MediaRequestStatus.PENDING,
  MediaRequestStatus.APPROVED,
  MediaRequestStatus.FAILED,
];

const trackedRequest = (request: MediaRequest): TrackedRequest => ({
  id: request.id,
  seasons:
    request.type === MediaType.TV
      ? request.seasons.map((s) => s.seasonNumber)
      : undefined,
  requestedBy: request.requestedBy?.displayName,
  at: request.createdAt.getTime(),
  awaitingApproval: request.status === MediaRequestStatus.PENDING,
});

/**
 * Sets the requests of the tracked runs of these media to their active requests. A request of the
 * run turning COMPLETED stays until the run is over: Seerr completes it once Radarr/Sonarr has the
 * files, before the imports finished and Jellyfin has them.
 */
export async function syncRequests(
  mediaIds: number[],
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const entries = tracker.tracked().filter((e) => mediaIds.includes(e.mediaId));
  if (entries.length === 0) return;
  const requests = await getRepository(MediaRequest).find({
    where: {
      media: { id: In(entries.map((e) => e.mediaId)) },
      status: In([...ACTIVE_REQUEST, MediaRequestStatus.COMPLETED]),
    },
  });
  for (const entry of entries) {
    const { mediaId, is4k } = entry;
    tracker.setRequests(
      mediaId,
      is4k,
      requests
        .filter(
          (r) =>
            r.media.id === mediaId &&
            r.is4k === is4k &&
            (ACTIVE_REQUEST.includes(r.status) ||
              (entry.requests.has(r.id) && !tracker.finished(entry)))
        )
        .map(trackedRequest),
      { cause: 'requests' }
    );
  }
}

type UnitState = Pick<
  Unit,
  'id' | 'seasonNumber' | 'episodeNumber' | 'hasFile'
>;

interface ArrState {
  removed?: boolean;
  /** Radarr/Sonarr searches for it, for the series: some requested episode. */
  monitored: boolean;
  /** Something can be searched for: the movie is available, or an episode aired. */
  released: boolean;
  lastSearchedAt?: number;
  /** The movie, or the requested episodes that aired and are monitored or have a file. */
  units: UnitState[];
}

const latest = (times: (string | undefined)[]) => {
  const ms = times.flatMap((t) => (t ? [Date.parse(t)] : []));
  return ms.length ? Math.max(...ms) : undefined;
};

/** The Radarr movie or the requested seasons of the Sonarr series as they are now. */
async function arrState(
  api: RadarrAPI | SonarrAPI,
  arrId: number,
  seasons: Set<number> | undefined
): Promise<ArrState> {
  try {
    if (api instanceof RadarrAPI) {
      const movie = await api.getMovie({ id: arrId });
      return {
        monitored: movie.monitored,
        released: movie.isAvailable !== false,
        lastSearchedAt: latest([movie.lastSearchTime]),
        units: [{ id: 0, hasFile: movie.hasFile }],
      };
    }
    const [series, episodes] = await Promise.all([
      api.getSeriesById(arrId),
      api.getEpisodes(arrId),
    ]);
    const now = Date.now();
    const requested = episodes.filter(
      (e) => !seasons || seasons.has(e.seasonNumber)
    );
    const units = requested
      .filter(
        (e) =>
          e.hasFile ||
          (e.monitored && !!e.airDateUtc && Date.parse(e.airDateUtc) <= now)
      )
      .map(({ id, seasonNumber, episodeNumber, hasFile }) => ({
        id,
        seasonNumber,
        episodeNumber,
        hasFile,
      }));
    return {
      monitored: series.monitored && requested.some((e) => e.monitored),
      released: units.length > 0,
      lastSearchedAt: latest(requested.map((e) => e.lastSearchTime)),
      units,
    };
  } catch (e) {
    if (isNotFound(e)) {
      return { removed: true, monitored: false, released: true, units: [] };
    }
    throw e;
  }
}

const ARR_NAME = { radarr: 'Radarr', sonarr: 'Sonarr' } as const;

/**
 * Files appearing finish the import of their units; files disappearing send them back to
 * searching. Whether the request failed is up to the request status, see
 * `ProgressTracker.failRequest`.
 */
function applyArrState(
  entry: TrackedProgress,
  state: ArrState,
  type: ServarrType,
  tracker: ProgressTracker,
  cause: string
): void {
  const { mediaId, is4k, steps } = entry;
  const newer =
    (state.lastSearchedAt ?? 0) > (entry.lastSearchedAt ?? 0)
      ? { lastSearchedAt: state.lastSearchedAt }
      : {};
  tracker.setSearch(
    mediaId,
    is4k,
    { ...newer, unreleased: !state.released },
    { cause }
  );
  entry.arrError = state.removed
    ? `Removed from ${ARR_NAME[type]}`
    : state.monitored
      ? undefined
      : `Not monitored in ${ARR_NAME[type]}`;
  // Awaiting approval: nothing was sent to Radarr/Sonarr yet.
  if (steps.requested.status !== 'done') return;
  tracker.syncFiles(mediaId, is4k, { cause });
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

/** Items an event named; a refresh reads only these, those in the queue and the moving runs. */
export interface RefreshScope {
  arrIds?: number[];
  mediaIds?: number[];
}

// Steps whose units Radarr/Sonarr moves on without an event naming the item.
const ARR_STEPS = ['searching', 'grabbed', 'importing'] as const;

/**
 * Brings the tracked media of one Radarr/Sonarr server up to date from its history (grab and
 * import times, download ids, release titles), queue (downloads, blocked or failed ones) and item
 * state. With `scope`, only runs it names, runs in the queue and unfinished runs in a Radarr/Sonarr
 * step that are not dormant are read; without it, every tracked run.
 */
export async function refreshServer(
  key: string,
  tracker: ProgressTracker = progressTracker,
  scope?: RefreshScope
): Promise<void> {
  const [type, id] = key.split('-') as [ServarrType, string];
  const api = servarrApi(type, Number(id));
  if (!api) return;
  // Finished entries too: files deleted after the import send the run back to searching.
  const all = tracker.tracked().filter((e) => e.serverKey === key);
  if (all.length === 0) return;

  const media = await loadMedia(all);
  const arrIdOf = (entry: TrackedProgress) => {
    const m = media.get(entry.mediaId);
    return (m && externalId(m, entry.is4k)) || undefined;
  };
  // Read on use: the request sync below can change them.
  const seasons = (entry: TrackedProgress) =>
    type === 'sonarr' ? requestedSeasons(entry) : undefined;
  // Records of the same series can belong to seasons another request asked for.
  const matching = (entries: TrackedProgress[]) => (item: ArrItem) =>
    entries.filter((entry) => {
      const arrId = type === 'radarr' ? item.movieId : item.seriesId;
      if (arrId === undefined || arrIdOf(entry) !== arrId) return false;
      const wanted = seasons(entry);
      const season = item.episode?.seasonNumber;
      return !wanted || season === undefined || wanted.has(season);
    });

  const named = (entry: TrackedProgress) =>
    !scope ||
    scope.mediaIds?.includes(entry.mediaId) ||
    scope.arrIds?.includes(arrIdOf(entry) ?? -1);
  const moving = (entry: TrackedProgress) =>
    !tracker.finished(entry) &&
    !tracker.dormant(entry) &&
    (entry.queue.size > 0 ||
      ARR_STEPS.some((k) => entry.steps[k].status === 'running'));
  const touched = new Set(
    all.filter((e) => arrIdOf(e) !== undefined && (named(e) || moving(e)))
  );
  // A waiting run wakes once its item shows up in the queue.
  if (
    touched.size === 0 &&
    all.every((e) => tracker.finished(e) || arrIdOf(e) === undefined)
  ) {
    return;
  }

  const queue = (await api.getQueue()) as (Awaited<
    ReturnType<typeof api.getQueue>
  >[number] &
    ArrItem)[];
  const inQueue = matching(all);
  for (const item of queue) {
    for (const entry of inQueue(item)) touched.add(entry);
  }
  if (touched.size === 0) return;
  await syncRequests(
    [...touched].map((e) => e.mediaId),
    tracker
  );
  // The request sync can end runs.
  const entries = [...touched].filter(
    (e) => tracker.entry(e.mediaId, e.is4k) === e
  );
  if (entries.length === 0) return;
  const entriesOf = matching(entries);

  // Per item: the history of a whole server since an old request can be too large to load.
  const arrIds = [...new Set(entries.map((e) => arrIdOf(e) as number))];
  const [histories, states] = await Promise.all([
    Promise.all(
      arrIds.map((arrId) =>
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
    Promise.all(
      entries.map((entry) => {
        const arrId = arrIdOf(entry) as number;
        return arrState(api, arrId, seasons(entry)).catch((e: Error) => {
          logger.warn(`Loading the item state failed: ${e.message}`, {
            label: 'Request Progress',
            server: key,
            arrId,
          });
          return undefined;
        });
      })
    ),
  ]);
  const history = histories.flat();
  const unitIdsOf = (item: ArrItem) =>
    type === 'radarr' ? [0] : item.episodeId ? [item.episodeId] : [];

  // Units first: history and queue name episodes by id.
  entries.forEach((entry, i) => {
    const state = states[i];
    if (state) {
      tracker.setUnits(entry.mediaId, entry.is4k, state.units, {
        cause: `${key} item`,
      });
    }
  });

  const ascending = [...history].sort(
    (a, b) => Date.parse(a.date) - Date.parse(b.date)
  );
  for (const record of ascending as HistoryRecord[]) {
    const at = Date.parse(record.date);
    const cause = `${key} history ${record.id} ${record.eventType}`;
    for (const { mediaId, is4k, steps } of entriesOf(record)) {
      // The item history holds the records of earlier requests too.
      if (at < (steps.requested.startedAt ?? 0)) continue;
      const unitIds = unitIdsOf(record);
      if (record.eventType === 'grabbed') {
        tracker.grab(mediaId, is4k, {
          downloadId: record.downloadId ?? `history-${record.id}`,
          unitIds,
          title: record.sourceTitle,
          indexer: record.data?.indexer,
          at,
          cause,
        });
      } else if (record.eventType === 'downloadFolderImported') {
        tracker.imported(mediaId, is4k, {
          downloadId: record.downloadId,
          unitIds,
          at,
          cause,
        });
      } else if (record.eventType === 'downloadFailed' && record.downloadId) {
        tracker.downloadFailed(mediaId, is4k, {
          downloadId: record.downloadId,
          unitIds,
          reason: DOWNLOAD_FAILED,
          detail: record.data?.message,
          at,
          cause,
        });
      }
    }
  }

  // Keyed by downloadId: Sonarr lists a season pack once per episode.
  const items = new Map<TrackedProgress, Map<string, QueueItemState>>();
  for (const item of queue) {
    const state = item.trackedDownloadState;
    const queueState: QueueItemState['state'] =
      state === 'failedPending' || state === 'failed'
        ? 'failed'
        : (state === 'importBlocked' || state === 'importPending') &&
            item.trackedDownloadStatus === 'warning'
          ? 'blocked'
          : [
                'importBlocked',
                'importPending',
                'importing',
                'imported',
              ].includes(state)
            ? 'downloaded'
            : 'downloading';
    for (const entry of entriesOf(item)) {
      const own = items.get(entry) ?? new Map<string, QueueItemState>();
      items.set(entry, own);
      const known = own.get(item.downloadId);
      if (known) {
        known.unitIds.push(...unitIdsOf(item));
        continue;
      }
      own.set(item.downloadId, {
        downloadId: item.downloadId,
        unitIds: unitIdsOf(item),
        title: item.title,
        indexer: item.indexer || undefined,
        size: item.size,
        sizeLeft: item.sizeleft,
        etaMs: queueEtaMs(item),
        state: queueState,
        reason:
          queueState === 'failed'
            ? DOWNLOAD_FAILED
            : queueState === 'blocked'
              ? IMPORT_BLOCKED
              : undefined,
      });
    }
  }
  for (const entry of entries) {
    tracker.setQueue(
      entry.mediaId,
      entry.is4k,
      [...(items.get(entry)?.values() ?? [])],
      { cause: `${key} queue` }
    );
  }

  entries.forEach((entry, i) => {
    const state = states[i];
    if (!state) return;
    applyArrState(entry, state, type, tracker, `${key} item`);
    // The scanner decides what this means for the media and request status.
    if (entry.arrError) {
      syncItem({ type, serverId: Number(id) }, arrIdOf(entry) as number);
    }
  });
}

async function jellyfinClient(): Promise<JellyfinAPI | undefined> {
  const admin = await getRepository(User).findOne({
    where: { id: 1 },
    select: ['id', 'jellyfinUserId', 'jellyfinDeviceId'],
  });
  if (!admin) return undefined;
  const client = new JellyfinAPI(
    getHostname(),
    getSettings().jellyfin.apiKey,
    admin.jellyfinDeviceId
  );
  client.setUserId(admin.jellyfinUserId ?? '');
  return client;
}

// Jellyfin lists a new file before probing it, and plays it only once probed.
const probed = (item?: JellyfinLibraryItemExtended) =>
  !!item?.MediaSources?.some((s) =>
    s.MediaStreams?.some((m) => m.Type === 'Video')
  );

/** `season:episode` of the probed episodes Jellyfin has of a series; undefined when it cannot tell. */
async function jellyfinEpisodes(
  client: JellyfinAPI | undefined,
  itemId: string
): Promise<Set<string> | undefined> {
  if (!client) return undefined;
  try {
    const episodes = await client.getEpisodes(itemId, undefined, {
      includeMediaInfo: true,
    });
    const have = new Set<string>();
    for (const e of episodes) {
      if (e.ParentIndexNumber == null || e.IndexNumber == null) continue;
      if (!probed(e)) continue;
      // A file of several episodes is one item.
      for (
        let n = e.IndexNumber;
        n <= (e.IndexNumberEnd ?? e.IndexNumber);
        n++
      ) {
        have.add(`${e.ParentIndexNumber}:${n}`);
      }
    }
    return have;
  } catch (e) {
    logger.warn(`Listing the episodes in Jellyfin failed: ${e.message}`, {
      label: 'Request Progress',
      itemId,
    });
    return undefined;
  }
}

/** Whether Jellyfin has probed the movie item; undefined when it cannot tell. */
async function jellyfinMovie(
  client: JellyfinAPI | undefined,
  itemId: string
): Promise<boolean | undefined> {
  if (!client) return undefined;
  try {
    return probed(await client.getItemData(itemId));
  } catch (e) {
    logger.warn(`Loading the movie from Jellyfin failed: ${e.message}`, {
      label: 'Request Progress',
      itemId,
    });
    return undefined;
  }
}

/** The Watch link of a series opens the lowest requested season; the series without one. */
async function seasonUrl(
  client: JellyfinAPI | undefined,
  entry: TrackedProgress,
  itemId: string,
  url?: string
): Promise<string | undefined> {
  const seasons = [...entry.requests.values()].flatMap((r) => r.seasons ?? []);
  if (!client || !url || seasons.length === 0) return url;
  const lowest = Math.min(...seasons);
  try {
    const season = (await client.getSeasons(itemId)).find(
      (s) => s.IndexNumber === lowest
    );
    return season ? url.replace(`id=${itemId}&`, `id=${season.Id}&`) : url;
  } catch {
    return url;
  }
}

/** Radarr/Sonarr still downloads or imports a unit, e.g. one re-grabbed after its import. */
const queued = (entry: TrackedProgress) =>
  [...entry.queue.values()].some(
    (q) => q.state !== 'failed' && q.unitIds.some((id) => entry.units.has(id))
  );

/**
 * Sets which units of the tracked media Jellyfin has and whether they are ready to play. A
 * series with a Jellyfin item lists its episodes there; without one, an available season counts
 * all its units. `only` limits it to some runs, as it asks Jellyfin once per run.
 */
export async function reconcileJellyfin(
  addedAt?: number,
  tracker: ProgressTracker = progressTracker,
  only: (entry: TrackedProgress) => boolean = () => true
): Promise<void> {
  const entries = tracker.tracked().filter(only);
  if (entries.length === 0) return;
  const media = await loadMedia(entries);
  let client: Promise<JellyfinAPI | undefined> | undefined;
  for (const entry of entries) {
    const { mediaId, is4k } = entry;
    const m = media.get(mediaId);
    if (!m) continue;
    const itemId = is4k ? m.jellyfinMediaId4k : m.jellyfinMediaId;
    let present: (unit: Unit) => boolean = () => !!itemId;
    if (m.mediaType === MediaType.MOVIE && itemId) {
      client ??= jellyfinClient();
      const has = await jellyfinMovie(await client, itemId);
      if (has === undefined) continue;
      present = () => has;
    } else if (m.mediaType === MediaType.TV && entry.unitsKnown) {
      if (itemId) {
        client ??= jellyfinClient();
        const have = await jellyfinEpisodes(await client, itemId);
        if (!have) continue;
        present = (u) => have.has(`${u.seasonNumber}:${u.episodeNumber}`);
      } else {
        const available = new Set(
          m.seasons
            .filter(
              (s) => (is4k ? s.status4k : s.status) === MediaStatus.AVAILABLE
            )
            .map((s) => s.seasonNumber)
        );
        present = (u) => available.has(u.seasonNumber as number);
      }
    }
    // Radarr/Sonarr scans mark the media available once the file exists, before Jellyfin has it.
    const available =
      isAvailable(is4k ? m.status4k : m.status) &&
      !!itemId &&
      [...entry.units.values()].every(present) &&
      !queued(entry);
    let playUrl = is4k ? m.mediaUrl4k : m.mediaUrl;
    if (available && itemId && m.mediaType === MediaType.TV) {
      // Looked up once, when the run becomes ready.
      client ??= jellyfinClient();
      playUrl = entry.available
        ? entry.playUrl
        : await seasonUrl(await client, entry, itemId, playUrl);
    }
    tracker.setJellyfin(mediaId, is4k, {
      present,
      available,
      playUrl,
      at: addedAt,
      cause: 'Jellyfin',
    });
  }
}

/**
 * Starts entries for media with active requests the tracker never saw, e.g. ones sent before a
 * restart, and fills them in from Radarr/Sonarr history, queue and files and from Jellyfin, as a
 * run would have. Without `targets`, covers every active request. Completed requests whose stored
 * run is unfinished or never reached Ready count as active. Their times are not measured.
 */
export async function reconstructProgress(
  targets?: { mediaId: number; is4k: boolean }[],
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const mediaIds = targets?.map((t) => t.mediaId);
  const requests = [
    ...(await getRepository(MediaRequest).find({
      where: {
        status: In(ACTIVE_REQUEST),
        ...(mediaIds ? { media: { id: In(mediaIds) } } : {}),
      },
    })),
    ...(await unfinishedCompletedRequests(mediaIds)),
  ].sort((a, b) => a.id - b.id);
  const variants = new Map<string, MediaRequest[]>();
  for (const request of requests) {
    const variant = `${request.media.id}:${request.is4k}`;
    variants.set(variant, [...(variants.get(variant) ?? []), request]);
  }
  const created: TrackedProgress[] = [];
  for (const group of variants.values()) {
    const { media, is4k } = group[0];
    if (
      (targets &&
        !targets.some((t) => t.mediaId === media.id && t.is4k === is4k)) ||
      tracker.entry(media.id, is4k)
    ) {
      continue;
    }
    const failed = group.filter((r) => r.status === MediaRequestStatus.FAILED);
    // A failed request of available media is no run anymore.
    if (
      failed.length === group.length &&
      isAvailable(is4k ? media.status4k : media.status)
    ) {
      continue;
    }
    const server = requestServer(
      group.find((r) => r.status === MediaRequestStatus.APPROVED) ?? group[0]
    );
    const [first, ...others] = group.map(trackedRequest);
    const entry = tracker.start({
      mediaId: media.id,
      is4k,
      requestId: first.id,
      seasons: first.seasons,
      requestedBy: first.requestedBy,
      serverKey: server && serverKey(server.type, server.serverId),
      at: first.at,
      awaitingApproval: first.awaitingApproval,
      reconstructed: true,
    });
    if (others.length > 0) {
      tracker.setRequests(media.id, is4k, [first, ...others], { at: first.at });
    }
    const last = failed.pop();
    if (last) {
      tracker.failRequest(
        media.id,
        is4k,
        last.failureReason,
        last.updatedAt.getTime()
      );
    } else if (
      group.some(
        (r) =>
          r.status === MediaRequestStatus.APPROVED ||
          r.status === MediaRequestStatus.COMPLETED
      )
    ) {
      created.push(entry);
    }
  }
  if (created.length === 0) return;

  for (const key of new Set(created.flatMap((e) => e.serverKey ?? []))) {
    await refreshServer(key, tracker, {
      mediaIds: created.map((e) => e.mediaId),
    });
  }
  await reconcileJellyfin(undefined, tracker, (e) => created.includes(e));
}

// Queue events keep coming while anything downloads, so the refresh runs at least this often;
// a grab during a long search shows within it.
export const SERVER_REFRESH_MAX_WAIT_MS = 3000;

/** What an event asks a refresh of its server to read besides the moving runs. */
interface RefreshRequest {
  arrIds?: number[];
  mediaIds?: number[];
  /** Every tracked run, e.g. after a reconnect that may have missed events. */
  all?: boolean;
  finished?: FinishedSearch;
}

const serverRefresh = new KeyedDebouncer<RefreshRequest | void>(
  async (key, values) => {
    const requests = values.filter((v): v is RefreshRequest => !!v);
    const finished = requests.flatMap((r) => r.finished ?? []);
    const scope = requests.some((r) => r.all)
      ? undefined
      : {
          arrIds: requests.flatMap((r) => r.arrIds ?? []),
          mediaIds: [
            ...requests.flatMap((r) => r.mediaIds ?? []),
            ...finished.map((f) => f.mediaId),
          ],
        };
    try {
      await refreshServer(key, finished[0]?.tracker, scope);
    } finally {
      // A search without results leaves the units waiting: RSS may still bring a release.
      for (const { tracker, mediaId, is4k, ...search } of finished) {
        tracker.searchFinished(mediaId, is4k, search);
      }
    }
  },
  DEBOUNCE_MS,
  SERVER_REFRESH_MAX_WAIT_MS
);

// Request hooks fire inside their transaction; the debounce reads the committed state.
const requestSyncs = new KeyedDebouncer(async (key) => {
  const mediaId = Number(key);
  await syncRequests([mediaId]);
  for (const entry of progressTracker.tracked()) {
    if (entry.mediaId === mediaId && entry.serverKey) {
      serverRefresh.push(entry.serverKey, { mediaIds: [mediaId] });
    }
  }
});

const itemSyncs = new KeyedDebouncer<{ source: SignalRSource; arrId: number }>(
  (_key, [{ source, arrId }]) =>
    source.type === 'radarr'
      ? radarrScanner.syncMovie(source.serverId, arrId)
      : sonarrScanner.syncSeries(source.serverId, arrId)
);

/**
 * Updates the media and request status of one Radarr movie or Sonarr series through the scanner,
 * once its events settle. The full scans remain the backstop for missed events.
 */
export function syncItem(source: SignalRSource, arrId: number): void {
  itemSyncs.push(`${serverKey(source.type, source.serverId)}:${arrId}`, {
    source,
    arrId,
  });
}

// Full polls, run once after a connection (re)starts since neither socket replays missed events.
const polls = new KeyedDebouncer(async (key) => {
  if (key === 'downloads') return downloadTracker.updateDownloads();
  if (!jellyfinRecentScanner.status().running) {
    await jellyfinRecentScanner.run();
  }
  await reconcileJellyfin(
    undefined,
    progressTracker,
    (e) => !progressTracker.dormant(e)
  );
});

// Added items cannot be matched to runs by id: Jellyfin reports episodes, the media holds series.
// The importing step counts too, as Jellyfin can add a file before the refresh saw its import.
const awaitsJellyfin = (entry: TrackedProgress) =>
  !progressTracker.finished(entry) &&
  (['importing', 'inJellyfin', 'playable'] as const).some(
    (k) => entry.steps[k].status === 'running'
  );

const jellyfinAdded = new KeyedDebouncer<{ ids: string[]; at: number }>(
  async (_key, batches) => {
    await jellyfinItemScanner.runItems([
      ...new Set(batches.flatMap((b) => b.ids)),
    ]);
    await reconcileJellyfin(
      Math.min(...batches.map((b) => b.at)),
      progressTracker,
      awaitsJellyfin
    );
  }
);

// Long enough for Jellyfin to notice a deletion Radarr/Sonarr reported (its library monitor waits
// 60s by default): the check marks a version deleted only when both lost it.
export const REMOVAL_DEBOUNCE_MS = 90_000;
export const REMOVAL_MAX_WAIT_MS = 5 * 60_000;

const mediaRemovals = new KeyedDebouncer(
  async (key) => {
    await availabilitySync.syncMedia(Number(key));
    await reconcileJellyfin(
      undefined,
      progressTracker,
      (e) => e.mediaId === Number(key)
    );
  },
  REMOVAL_DEBOUNCE_MS,
  REMOVAL_MAX_WAIT_MS
);

// A season delete or a Jellyfin metadata refresh reports removals over minutes; one run covers it.
export const FULL_SYNC_DEBOUNCE_MS = 5 * 60_000;
export const FULL_SYNC_MAX_WAIT_MS = 30 * 60_000;

const fullSync = new KeyedDebouncer(
  async () => {
    // Waiting runs are refreshed only by events naming them; this catches a missed one.
    for (const key of new Set(
      progressTracker.tracked().flatMap((e) => e.serverKey ?? [])
    )) {
      serverRefresh.push(key, { all: true });
    }
    await availabilitySync.run();
    await reconcileJellyfin();
  },
  FULL_SYNC_DEBOUNCE_MS,
  FULL_SYNC_MAX_WAIT_MS
);

/**
 * Runs the availability check for the movies and series behind removed Jellyfin items, and the
 * full availability sync for removed items that are no stored movie or series, like episodes and
 * seasons.
 */
export async function onJellyfinRemoved(ids: string[]): Promise<void> {
  const media = await getRepository(Media).find({
    select: { id: true, jellyfinMediaId: true, jellyfinMediaId4k: true },
    where: [{ jellyfinMediaId: In(ids) }, { jellyfinMediaId4k: In(ids) }],
  });
  for (const { id } of media) mediaRemovals.push(String(id));
  const known = new Set(
    media.flatMap((m) => [m.jellyfinMediaId, m.jellyfinMediaId4k])
  );
  if (ids.some((id) => !known.has(id))) fullSync.push('full');
}

/** The Radarr movie or Sonarr series an event reports content gone from, if any. */
function removedItem(
  source: SignalRSource,
  event: ServarrSignalREvent
): number | undefined {
  switch (event.type) {
    case 'movie':
      // Radarr reports a deleted movie file only by its id, then the movie without a file.
      return event.action === 'deleted' || event.hasFile === false
        ? event.id
        : undefined;
    case 'series':
      return event.action === 'deleted' ? event.id : undefined;
    case 'movieFile':
      return event.action === 'deleted' ? event.movieId : undefined;
    case 'episodeFile':
      return event.action === 'deleted' ? event.seriesId : undefined;
    case 'episode':
      // Sonarr reports a deleted episode file only by its id, then its episodes without a file.
      return event.action === 'deleted' ||
        (event.hasFile === false && !event.grabbed)
        ? (event.seriesId ??
            episodeSeries.get(`${source.serverId}:${event.id}`))
        : undefined;
    default:
      return undefined;
  }
}

/** Runs the availability check for the available media behind a Radarr movie or Sonarr series. */
async function checkRemoved(
  source: SignalRSource,
  arrId: number
): Promise<void> {
  for (const { media, is4k } of await findMedia(source, arrId)) {
    if (isAvailable(is4k ? media.status4k : media.status)) {
      mediaRemovals.push(String(media.id));
    }
  }
}

function onSignalRConnected(source: SignalRSource): void {
  const key = serverKey(source.type, source.serverId);
  polls.push('downloads');
  serverRefresh.push(key, { all: true });
  refreshStepHistory(source.type, source.serverId);
}

export const STEP_HISTORY_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function refreshAllStepHistory(): void {
  const settings = getSettings();
  for (const type of ['radarr', 'sonarr'] as const) {
    for (const server of settings[type]) refreshStepHistory(type, server.id);
  }
}

/** Rebuilds the step samples, e.g. after their window settings changed. */
export async function reloadStepStats(): Promise<void> {
  await stepStats.load();
  refreshAllStepHistory();
}

/** The Radarr movie or Sonarr series whose state an event changed, if any. */
function changedItem(event: ServarrSignalREvent): number | undefined {
  switch (event.type) {
    case 'movie':
    case 'series':
      return event.id;
    case 'movieFile':
      return event.movieId;
    case 'episodeFile':
      return event.seriesId;
    default:
      return undefined;
  }
}

export function onSignalRMessage(
  source: SignalRSource,
  event: ServarrSignalREvent
): void {
  const arrId = changedItem(event);
  if (arrId !== undefined) syncItem(source, arrId);
  const removedId = removedItem(source, event);
  if (removedId !== undefined) {
    checkRemoved(source, removedId).catch((e: Error) =>
      logger.error(`Handling removed content failed: ${e.message}`, {
        label: 'Request Progress',
      })
    );
  }

  if (event.type === 'command') {
    handleCommand(source, event).catch((e: Error) =>
      logger.error(`Handling a command event failed: ${e.message}`, {
        label: 'Request Progress',
      })
    );
  } else if (event.type === 'episode') {
    if (event.seriesId !== undefined) {
      rememberEpisode(source.serverId, event.id, event.seriesId);
    }
    // Sonarr reports a grab on its episodes at once, its queue only later.
    const seriesId =
      event.seriesId ?? episodeSeries.get(`${source.serverId}:${event.id}`);
    if (event.grabbed) {
      serverRefresh.push(
        serverKey(source.type, source.serverId),
        seriesId === undefined ? undefined : { arrIds: [seriesId] }
      );
    }
  } else {
    serverRefresh.push(
      serverKey(source.type, source.serverId),
      arrId === undefined ? undefined : { arrIds: [arrId] }
    );
  }
}

export function restartJellyfinSocket(): void {
  jellyfinSocket.stop();
  if (getSettings().main.mediaServerType === MediaServerType.JELLYFIN) {
    jellyfinSocket.start();
  }
}

/**
 * Stores every run with requests when it starts, debounced while it changes, and its final state
 * when it ends, so a restart can rebuild the runs that were unfinished.
 */
export function storeRuns(tracker: ProgressTracker = progressTracker): void {
  // One write at a time: an unfinished snapshot never lands after the final one.
  let writes = Promise.resolve();
  const write = (progress: RequestProgress, requestIds: number[]) => {
    writes = writes.then(() =>
      storeRun(progress, requestIds).catch((e: Error) => {
        logger.warn(`Storing the run failed: ${e.message}`, {
          label: 'Request Progress',
          mediaId: progress.mediaId,
        });
      })
    );
  };
  const unfinished = new KeyedDebouncer((key) => {
    const [mediaId, is4k] = key.split(':');
    const entry = tracker.entry(Number(mediaId), is4k === 'true');
    if (entry && entry.requests.size > 0 && entry.finishedAt === undefined) {
      write(tracker.snapshot(entry), [...entry.requests.keys()]);
    }
  });
  tracker.on('change', (progress) => {
    if (progress.requests.length > 0) {
      unfinished.push(`${progress.mediaId}:${progress.is4k}`);
    }
  });
  tracker.on('finished', write);
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
  progressTracker.on('requests', (mediaId) =>
    requestSyncs.push(String(mediaId))
  );
  storeRuns();
  servarrSignalR.on('connected', onSignalRConnected);
  servarrSignalR.on('reconnected', onSignalRConnected);
  setInterval(refreshAllStepHistory, STEP_HISTORY_INTERVAL_MS).unref();
  servarrSignalR.on('message', onSignalRMessage);

  const jellyfinPoll = () => polls.push('jellyfin');
  jellyfinSocket.on('connected', jellyfinPoll);
  jellyfinSocket.on('reconnected', jellyfinPoll);
  jellyfinSocket.on('libraryChanged', (event) => {
    if (event.itemsAdded.length > 0) {
      jellyfinAdded.push('added', { ids: event.itemsAdded, at: Date.now() });
    }
    if (event.itemsRemoved.length > 0) {
      onJellyfinRemoved(event.itemsRemoved).catch((e: Error) =>
        logger.error(`Handling removed Jellyfin items failed: ${e.message}`, {
          label: 'Request Progress',
        })
      );
    }
  });

  servarrSignalR.start();
  restartJellyfinSocket();
}
