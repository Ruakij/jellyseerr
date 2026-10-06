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
import type { RequestProgressStatsResponse } from '@server/interfaces/api/progressInterfaces';
import availabilitySync from '@server/lib/availabilitySync';
import downloadTracker from '@server/lib/downloadtracker';
import { KeyedDebouncer } from '@server/lib/requestProgress/debounce';
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
    if (ended) {
      // A search without results leaves the units waiting: RSS may still bring a release.
      tracker.searchFinished(media.id, is4k, {
        commandId: event.id,
        error:
          event.status === 'completed'
            ? undefined
            : `Search failed${event.message ? `: ${event.message}` : ''}`,
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

// Deleted, declined and completed requests leave the run.
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

/** Sets the requests of the tracked runs of these media to their active requests. */
export async function syncRequests(
  mediaIds: number[],
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const entries = tracker.tracked().filter((e) => mediaIds.includes(e.mediaId));
  if (entries.length === 0) return;
  const requests = await getRepository(MediaRequest).find({
    where: {
      media: { id: In(entries.map((e) => e.mediaId)) },
      status: In(ACTIVE_REQUEST),
    },
  });
  for (const { mediaId, is4k } of entries) {
    tracker.setRequests(
      mediaId,
      is4k,
      requests
        .filter((r) => r.media.id === mediaId && r.is4k === is4k)
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

/**
 * Brings the tracked media of one Radarr/Sonarr server up to date from its history (grab and
 * import times, download ids, release titles) and queue (downloads, blocked or failed ones).
 */
export async function refreshServer(
  key: string,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const [type, id] = key.split('-') as [ServarrType, string];
  const api = servarrApi(type, Number(id));
  if (!api) return;
  await syncRequests(
    tracker
      .tracked()
      .filter((e) => e.serverKey === key)
      .map((e) => e.mediaId),
    tracker
  );
  // Finished entries too: files deleted after the import send the run back to searching.
  const entries = tracker.tracked().filter((e) => e.serverKey === key);
  if (entries.length === 0) return;

  const media = await loadMedia(entries);
  const byArrId = new Map<number, TrackedProgress[]>();
  for (const entry of entries) {
    const m = media.get(entry.mediaId);
    const arrId = m && externalId(m, entry.is4k);
    if (arrId) byArrId.set(arrId, [...(byArrId.get(arrId) ?? []), entry]);
  }
  if (byArrId.size === 0) return;

  const seasons =
    type === 'sonarr'
      ? new Map(entries.map((e) => [e, requestedSeasons(e)]))
      : undefined;
  // Per item: the history of a whole server since an old request can be too large to load.
  const [histories, queue, states] = await Promise.all([
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
    Promise.all(
      entries.map((entry) => {
        const m = media.get(entry.mediaId);
        const arrId = m && externalId(m, entry.is4k);
        return arrId
          ? arrState(api, arrId, seasons?.get(entry)).catch((e: Error) => {
              logger.warn(`Loading the item state failed: ${e.message}`, {
                label: 'Request Progress',
                server: key,
                arrId,
              });
              return undefined;
            })
          : undefined;
      })
    ),
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
  for (const item of queue as ((typeof queue)[number] & ArrItem)[]) {
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
    const m = media.get(entry.mediaId);
    const arrId = m && externalId(m, entry.is4k);
    if (entry.arrError && arrId) {
      syncItem({ type, serverId: Number(id) }, arrId);
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

/** `season:episode` of the episodes Jellyfin has of a series; undefined when it cannot tell. */
async function jellyfinEpisodes(
  client: JellyfinAPI | undefined,
  itemId: string
): Promise<Set<string> | undefined> {
  if (!client) return undefined;
  try {
    const episodes = await client.getEpisodes(itemId, undefined);
    const have = new Set<string>();
    for (const e of episodes) {
      if (e.ParentIndexNumber == null || e.IndexNumber == null) continue;
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

/**
 * Sets which units of the tracked media Jellyfin has and whether Seerr shows them available. A
 * series with a Jellyfin item lists its episodes there; without one, an available season counts
 * all its units.
 */
export async function reconcileJellyfin(
  addedAt?: number,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const entries = tracker.tracked();
  if (entries.length === 0) return;
  const media = await loadMedia(entries);
  let client: Promise<JellyfinAPI | undefined> | undefined;
  for (const entry of entries) {
    const { mediaId, is4k } = entry;
    const m = media.get(mediaId);
    if (!m) continue;
    const itemId = is4k ? m.jellyfinMediaId4k : m.jellyfinMediaId;
    let present: (unit: Unit) => boolean = () => !!itemId;
    if (m.mediaType === MediaType.TV && entry.unitsKnown) {
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
    tracker.setJellyfin(mediaId, is4k, {
      present,
      available: isAvailable(is4k ? m.status4k : m.status),
      playUrl: is4k ? m.mediaUrl4k : m.mediaUrl,
      at: addedAt,
      cause: 'Jellyfin',
    });
  }
}

/**
 * Starts entries for media with active requests the tracker never saw, e.g. ones sent before a
 * restart, and fills them in from Radarr/Sonarr history, queue and files and from Jellyfin, as a
 * run would have. Without `targets`, covers every active request. Their times are not measured.
 */
export async function reconstructProgress(
  targets?: { mediaId: number; is4k: boolean }[],
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const requests = await getRepository(MediaRequest).find({
    where: {
      status: In(ACTIVE_REQUEST),
      ...(targets ? { media: { id: In(targets.map((t) => t.mediaId)) } } : {}),
    },
    order: { id: 'ASC' },
  });
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
    } else if (group.some((r) => r.status === MediaRequestStatus.APPROVED)) {
      created.push(entry);
    }
  }
  if (created.length === 0) return;

  for (const key of new Set(created.flatMap((e) => e.serverKey ?? []))) {
    await refreshServer(key, tracker);
  }
  await reconcileJellyfin(undefined, tracker);
}

const serverRefresh = new KeyedDebouncer((key) => refreshServer(key));

// Request hooks fire inside their transaction; the debounce reads the committed state.
const requestSyncs = new KeyedDebouncer(async (key) => {
  const mediaId = Number(key);
  await syncRequests([mediaId]);
  for (const entry of progressTracker.tracked()) {
    if (entry.mediaId === mediaId && entry.serverKey) {
      serverRefresh.push(entry.serverKey);
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

// Long enough for Jellyfin to notice a deletion Radarr/Sonarr reported (its library monitor waits
// 60s by default): the check marks a version deleted only when both lost it.
export const REMOVAL_DEBOUNCE_MS = 90_000;
export const REMOVAL_MAX_WAIT_MS = 5 * 60_000;

const mediaRemovals = new KeyedDebouncer(
  async (key) => {
    await availabilitySync.syncMedia(Number(key));
    await reconcileJellyfin();
  },
  REMOVAL_DEBOUNCE_MS,
  REMOVAL_MAX_WAIT_MS
);

// A season delete or a Jellyfin metadata refresh reports removals over minutes; one run covers it.
export const FULL_SYNC_DEBOUNCE_MS = 5 * 60_000;
export const FULL_SYNC_MAX_WAIT_MS = 30 * 60_000;

const fullSync = new KeyedDebouncer(
  async () => {
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
  serverRefresh.push(key);
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
  } else if (event.type === 'episode' && event.seriesId !== undefined) {
    rememberEpisode(source.serverId, event.id, event.seriesId);
  } else if (event.type !== 'episode') {
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
  progressTracker.on('requests', (mediaId) =>
    requestSyncs.push(String(mediaId))
  );
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
