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
import { MediaStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import downloadTracker from '@server/lib/downloadtracker';
import { KeyedDebouncer } from '@server/lib/requestProgress/debounce';
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
import { In } from 'typeorm';

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

const SEARCH_FAILED = ['failed', 'aborted', 'cancelled', 'orphaned'];

export async function handleCommand(
  source: SignalRSource,
  event: CommandEvent,
  tracker: ProgressTracker = progressTracker
): Promise<void> {
  const arrIds = event.movieIds ?? (event.seriesId ? [event.seriesId] : []);
  const key = serverKey(source.type, source.serverId);
  for (const arrId of arrIds) {
    for (const { media, is4k } of await findMedia(source, arrId)) {
      if (event.status === 'started') {
        // Covers requests sent before a restart or added in Radarr/Sonarr directly.
        if (isWaiting(is4k ? media.status4k : media.status)) {
          tracker.ensure({ mediaId: media.id, is4k, serverKey: key });
        }
      } else if (event.status === 'completed') {
        tracker.searchCompleted(media.id, is4k);
      } else if (SEARCH_FAILED.includes(event.status)) {
        tracker.fail(
          media.id,
          is4k,
          `Search failed${event.message ? `: ${event.message}` : ''}`
        );
      }
    }
  }
  if (event.status === 'completed') serverRefresh.push(key);
}

const IMPORT_BLOCKED = 'Manual interaction required';
const DOWNLOAD_FAILED = 'Download failed';

/**
 * Brings the tracked media of one Radarr/Sonarr server up to date from its history (grab and
 * import times, download ids) and queue (blocked or failed downloads).
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

  const since = Math.min(
    ...entries.map((e) => e.steps.requested.startedAt ?? Date.now())
  );
  const [history, queue] = await Promise.all([
    api.getHistory({ since: new Date(since) }),
    api.getQueue(),
  ]);
  const arrIdOf = (r: { movieId?: number; seriesId?: number }) =>
    type === 'radarr' ? r.movieId : r.seriesId;

  const ascending = [...history].sort(
    (a, b) => Date.parse(a.date) - Date.parse(b.date)
  );
  for (const record of ascending as HistoryRecord[]) {
    const at = Date.parse(record.date);
    for (const entry of byArrId.get(arrIdOf(record) ?? -1) ?? []) {
      const { mediaId, is4k } = entry;
      if (record.eventType === 'grabbed') {
        tracker.advance(mediaId, is4k, 'grabbed', at, {
          downloadId: record.downloadId,
        });
      } else if (record.eventType === 'downloadFolderImported') {
        tracker.advance(mediaId, is4k, 'importing', at);
      } else if (record.eventType === 'downloadFailed') {
        tracker.fail(mediaId, is4k, DOWNLOAD_FAILED, at);
      }
    }
  }

  for (const item of queue as ((typeof queue)[number] & {
    movieId?: number;
    seriesId?: number;
  })[]) {
    const state = item.trackedDownloadState;
    const reason =
      state === 'importBlocked' ||
      (state === 'importPending' && item.trackedDownloadStatus === 'warning')
        ? IMPORT_BLOCKED
        : state === 'failedPending' || state === 'failed'
          ? DOWNLOAD_FAILED
          : undefined;
    if (!reason) continue;
    for (const entry of byArrId.get(arrIdOf(item) ?? -1) ?? []) {
      if (entry.steps.importing.status !== 'done') {
        tracker.fail(entry.mediaId, entry.is4k, reason);
      }
    }
  }

  for (const entry of entries) {
    if (entry.searchCompletedAt && entry.steps.grabbed.status !== 'done') {
      tracker.fail(entry.mediaId, entry.is4k, 'No results');
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
  const api = servarrApi(source.type, source.serverId);
  if (first && api) {
    stepStats.refresh(key, api).catch((e: Error) =>
      logger.warn(`Loading step history failed: ${e.message}`, {
        label: 'Request Progress',
        server: key,
      })
    );
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
  servarrSignalR.on('connected', (s) => onSignalRConnected(s, true));
  servarrSignalR.on('reconnected', (s) => onSignalRConnected(s, false));
  servarrSignalR.on('message', onSignalRMessage);

  const jellyfinPoll = () => polls.push('jellyfin');
  jellyfinSocket.on('connected', jellyfinPoll);
  jellyfinSocket.on('reconnected', jellyfinPoll);
  jellyfinSocket.on('libraryChanged', (event) => {
    if (event.itemsAdded.length > 0 && progressTracker.active().length > 0) {
      jellyfinAdded.push('added', { ids: event.itemsAdded, at: Date.now() });
    }
  });

  servarrSignalR.start();
  restartJellyfinSocket();
}
