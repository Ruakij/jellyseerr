import type {
  ProgressCounts,
  ProgressDownload,
  ProgressRequest,
  ProgressStepKey,
  ProgressStepStatus,
  ProgressTimelineEntry,
  ProgressTimelineKind,
  ProgressTimelineSource,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import type { StepStats } from '@server/lib/requestProgress/stepStats';
import stepStats, {
  MIN_STEP_SAMPLES,
  MIN_TOTAL_SAMPLES,
} from '@server/lib/requestProgress/stepStats';
import { PROGRESS_STEPS } from '@server/lib/requestProgress/steps';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { EventEmitter } from 'node:events';

export const STEP_KEYS: readonly ProgressStepKey[] = [
  'requested',
  ...PROGRESS_STEPS,
];

// Finished entries stay for a while so a reopened pop-up still shows the run.
export const KEEP_FINISHED_MS = 60 * 60 * 1000;

export const TIMELINE_SIZE = 100;

// A file state loaded this long before an import record may predate the import.
const FILE_STATE_RACE_MS = 5000;

// Marks a run whose search was measured.
const SEARCH_SAMPLE = 'sample:searching';

// Time between the request and its search that still counts as no waiting.
const SEARCH_GAP_MS = 1000;

// Index in PROGRESS_STEPS of the step a unit is in.
const SEARCHING = 0;
const GRABBED = 1;
const IMPORTING = 2;
const PLAYABLE = 4;

/** The movie, or one requested episode. */
export interface Unit {
  /** Sonarr episode id; 0 for a movie and for the placeholder of a series not loaded yet. */
  id: number;
  seasonNumber?: number;
  episodeNumber?: number;
  /** The download delivering it, kept after the import. */
  downloadId?: string;
  grabbedAt?: number;
  /** Its download finished; it waits for the import. */
  downloadedAt?: number;
  hasFile: boolean;
  importedAt?: number;
  /** Whether Radarr/Sonarr listed a file at its last answer. */
  arrHasFile?: boolean;
  inJellyfin: boolean;
  /** Why its last attempt failed; it counts while the unit has not moved on. */
  failure?: { step: 'searching' | 'grabbed' | 'importing'; reason: string };
}

export interface QueueItemState {
  downloadId: string;
  unitIds: number[];
  title: string;
  indexer?: string;
  size: number;
  sizeLeft: number;
  etaMs?: number;
  state: 'downloading' | 'downloaded' | 'blocked' | 'failed';
  /** Why it is blocked or failed. */
  reason?: string;
}

export interface TrackedRequest {
  id: number;
  /** Seasons of a series request; absent for a movie. */
  seasons?: number[];
  requestedBy?: string;
  /** When it was sent to Radarr/Sonarr, or made while it awaits approval. */
  at: number;
  awaitingApproval?: boolean;
}

interface StepState {
  status: ProgressStepStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  counts?: ProgressCounts;
  progress?: number;
  /** Running with no unit in it: the units are past it, failed at it or not there yet. */
  idleSince?: number;
}

export interface TrackedProgress {
  mediaId: number;
  is4k: boolean;
  /** The active requests of the media; their units make up the run. */
  requests: Map<number, TrackedRequest>;
  /** StepStats key, e.g. `radarr-0`; absent until the serving Radarr/Sonarr is known. */
  serverKey?: string;
  /** Radarr/Sonarr search command running for the media, if any. */
  searchCommandId?: number;
  /** Indexers the running search queries, from its messages. */
  searchIndexers?: number;
  lastSearchedAt?: number;
  /** Start of the search running now; a request goes out with searchNow, so it starts one. */
  searchStartedAt?: number;
  /** The last finished search, to tell whether a grab reported later came from it. */
  lastSearch?: { start: number; end: number };
  /** Time finished searches ran, up to the grab that ended one. */
  searchMs: number;
  /** Radarr/Sonarr has nothing released to search for yet; set once its item state was read. */
  unreleased?: boolean;
  /** What Radarr/Sonarr waits for next: a digital or physical release, or an air date. */
  releaseDate?: number;
  /** Why Radarr/Sonarr will not deliver it, e.g. the item was removed there. */
  arrError?: string;
  /** Why sending the request to Radarr/Sonarr failed, from the request. */
  failureReason?: string;
  /** The request failed as a whole: declined, not sent, or FAILED. */
  requestError?: { error: string; at: number };
  units: Map<number, Unit>;
  /** False while a series has its placeholder unit only. */
  unitsKnown: boolean;
  /** When the file states of the last `setUnits` were loaded. */
  filesLoadedAt?: number;
  /** Release title and indexer per download. */
  releases: Map<string, { title?: string; indexer?: string }>;
  /** Queue items by download, as last seen. */
  queue: Map<string, QueueItemState>;
  /** The Watch link, shown once the run is ready. */
  playUrl?: string;
  /** Rebuilt after the fact, so its step times are not durations worth measuring. */
  reconstructed?: boolean;
  timeline: ProgressTimelineEntry[];
  /** Keys of the events applied, so replayed history changes nothing. */
  seen: Set<string>;
  /** When the run last became finished; cleared while it runs again. */
  finishedAt?: number;
  steps: Record<ProgressStepKey, StepState>;
}

const key = (mediaId: number, is4k: boolean) => `${mediaId}:${is4k}`;

/** Every request awaits approval, so nothing was sent to Radarr/Sonarr yet. */
const awaitingApproval = (entry: TrackedProgress) =>
  entry.requests.size > 0 &&
  [...entry.requests.values()].every((r) => r.awaitingApproval);

const covers = (request: TrackedRequest, unit: Unit) =>
  !request.seasons ||
  unit.seasonNumber === undefined ||
  request.seasons.includes(unit.seasonNumber);

export const REQUEST_FAILED = 'Request failed';

export const WAITING_FOR_RSS = 'No release found yet, waiting for RSS';

export const WAITING_FOR_RELEASE = 'Not released yet';

const iso = (ms?: number) =>
  ms === undefined ? undefined : new Date(ms).toISOString();

const newUnit = (id: number): Unit => ({
  id,
  hasFile: false,
  inJellyfin: false,
});

/** Index of the step the unit is in, see PROGRESS_STEPS. */
export const unitStage = (u: Unit): number =>
  u.inJellyfin && u.arrHasFile !== false
    ? PLAYABLE
    : u.hasFile
      ? 3
      : u.downloadId
        ? u.downloadedAt !== undefined
          ? IMPORTING
          : GRABBED
        : SEARCHING;

/** The step the unit's failure holds it at, if it has not moved on since. */
const failedAt = (u: Unit): number | undefined => {
  if (!u.failure) return undefined;
  const step = PROGRESS_STEPS.indexOf(u.failure.step);
  const stage = unitStage(u);
  return stage === (step === IMPORTING ? IMPORTING : SEARCHING)
    ? step
    : undefined;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** Episode labels with consecutive episodes of a season as ranges: S01E01-E03, S02E05. */
export function unitLabels(units: Unit[]): string[] {
  const sorted = units
    .filter(
      (u) => u.seasonNumber !== undefined && u.episodeNumber !== undefined
    )
    .sort(
      (a, b) =>
        (a.seasonNumber as number) - (b.seasonNumber as number) ||
        (a.episodeNumber as number) - (b.episodeNumber as number)
    );
  const labels: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (
      j + 1 < sorted.length &&
      sorted[j + 1].seasonNumber === sorted[i].seasonNumber &&
      (sorted[j + 1].episodeNumber as number) ===
        (sorted[j].episodeNumber as number) + 1
    ) {
      j++;
    }
    const first = `S${pad(sorted[i].seasonNumber as number)}E${pad(
      sorted[i].episodeNumber as number
    )}`;
    labels.push(
      j > i ? `${first}-E${pad(sorted[j].episodeNumber as number)}` : first
    );
    i = j + 1;
  }
  return labels;
}

interface Change {
  at?: number;
  /** What caused it, for the debug log. */
  cause?: string;
}

interface TrackerEvents {
  change: [RequestProgress];
  /** The run became finished, or was dropped unfinished; once per finish, carrying `finishedAt`. */
  finished: [progress: RequestProgress, requestIds: number[]];
  /** The last active request of the media is gone, and its run with it; `last` is its final state. */
  removed: [mediaId: number, is4k: boolean, last: RequestProgress];
  /** A request of the media was changed or removed in the database. */
  requests: [mediaId: number];
  /** Radarr/Sonarr added the media of a run, so its item can be read. */
  sent: [mediaId: number, is4k: boolean];
}

export class ProgressTracker extends EventEmitter<TrackerEvents> {
  private entries = new Map<string, TrackedProgress>();
  private evictions = new Map<string, NodeJS.Timeout>();
  /** The units of a timeline entry, to merge the next records of the same event into it. */
  private timelineUnits = new WeakMap<
    ProgressTimelineEntry,
    { units: Unit[]; downloadId?: string }
  >();

  constructor(
    private readonly injectedStats?: Pick<
      StepStats,
      'get' | 'record' | 'recordTotal' | 'total'
    >,
    private readonly now: () => number = Date.now
  ) {
    super();
    // One listener per open progress stream.
    this.setMaxListeners(0);
  }

  // Resolved on use: stepStats loads the database entities, whose subscribers import this module.
  private get stats() {
    return this.injectedStats ?? stepStats;
  }

  /**
   * Starts a fresh run, replacing a previous one of the same media, or adds the request to the
   * unfinished run of other requests.
   */
  public start({
    mediaId,
    is4k,
    requestId,
    seasons,
    requestedBy,
    serverKey,
    at = this.now(),
    awaitingApproval: awaiting,
    reconstructed,
  }: {
    mediaId: number;
    is4k: boolean;
    requestId?: number;
    seasons?: number[];
    requestedBy?: string;
    serverKey?: string;
    /** When the request was made, for a run rebuilt later. */
    at?: number;
    awaitingApproval?: boolean;
    reconstructed?: boolean;
  }): TrackedProgress {
    const request: TrackedRequest | undefined =
      requestId === undefined
        ? undefined
        : {
            id: requestId,
            seasons,
            requestedBy,
            at,
            awaitingApproval: awaiting,
          };
    const current = this.entry(mediaId, is4k);
    if (
      current &&
      request &&
      !this.finished(current) &&
      [...current.requests.keys()].some((id) => id !== request.id)
    ) {
      this.mutate(mediaId, is4k, at, 'request added', (entry) => {
        entry.serverKey ??= serverKey;
        this.putRequest(entry, request);
        // A request goes out with searchNow.
        if (!awaiting && !reconstructed) entry.searchStartedAt ??= at;
      });
      return current;
    }
    const entry: TrackedProgress = {
      mediaId,
      is4k,
      requests: new Map(request ? [[request.id, request]] : []),
      serverKey,
      reconstructed,
      searchStartedAt: awaiting || reconstructed ? undefined : at,
      searchMs: 0,
      units: new Map([[0, newUnit(0)]]),
      unitsKnown: false,
      releases: new Map(),
      queue: new Map(),
      timeline: [],
      seen: new Set(),
      steps: Object.fromEntries(
        STEP_KEYS.map((k) => [k, { status: 'pending' }])
      ) as Record<ProgressStepKey, StepState>,
    };
    this.cancelEviction(key(mediaId, is4k));
    this.entries.set(key(mediaId, is4k), entry);
    if (request) this.noteRequest(entry, request);
    this.recompute(entry, at, 'request started');
    this.changed(entry);
    return entry;
  }

  /**
   * Sets the active requests of a run. Units no remaining request covers leave it, and step times
   * start no earlier than the oldest remaining request. Without requests, the run is gone; a run
   * that never had one, e.g. of media added in Radarr/Sonarr directly, stays.
   */
  public setRequests(
    mediaId: number,
    is4k: boolean,
    requests: TrackedRequest[],
    { at = this.now(), cause }: Change = {}
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry) return;
    if (requests.length === 0) {
      if (entry.requests.size > 0) this.remove(entry);
      return;
    }
    this.mutate(mediaId, is4k, at, cause ?? 'requests', () => {
      const removed = [...entry.requests.keys()].some(
        (id) => !requests.some((r) => r.id === id)
      );
      const known = entry.requests;
      entry.requests = new Map();
      for (const request of requests) {
        this.putRequest(entry, request, known.get(request.id));
      }
      if (removed) this.dropUncovered(entry);
    });
  }

  /** Tells the request syncing that a request of the media changed in the database. */
  public requestsChanged(mediaId: number): void {
    this.emit('requests', mediaId);
  }

  /** Adds or updates a request; it keeps its time unless it was approved since. */
  private putRequest(
    entry: TrackedProgress,
    request: TrackedRequest,
    known = entry.requests.get(request.id)
  ): void {
    const approved = known?.awaitingApproval && !request.awaitingApproval;
    entry.requests.set(request.id, {
      ...request,
      at: known && !approved ? known.at : request.at,
    });
    if (!known) this.noteRequest(entry, request);
  }

  private noteRequest(entry: TrackedProgress, request: TrackedRequest): void {
    this.note(entry, request.at, 'request added', {
      step: 'requested',
      kind: 'requested',
      detail: request.requestedBy,
      source: 'request',
      seasons: request.seasons,
    });
  }

  /** Forgets units, timeline entries and times of seasons no request asks for anymore. */
  private dropUncovered(entry: TrackedProgress): void {
    const requests = [...entry.requests.values()];
    if (entry.unitsKnown) {
      for (const [id, unit] of entry.units) {
        if (!requests.some((r) => covers(r, unit))) entry.units.delete(id);
      }
      if (entry.units.size === 0) {
        entry.units.set(0, newUnit(0));
        entry.unitsKnown = false;
      }
    }
    const asked = (season: number) =>
      requests.some((r) => !r.seasons || r.seasons.includes(season));
    entry.timeline = entry.timeline.filter(
      (e) => !e.seasons || e.seasons.some(asked)
    );
    const since = Math.min(...requests.map((r) => r.at));
    for (const state of Object.values(entry.steps)) {
      if (state.startedAt !== undefined && state.startedAt < since) {
        state.startedAt = since;
      }
      if (state.idleSince !== undefined && state.idleSince < since) {
        state.idleSince = since;
      }
    }
    if ((entry.lastSearchedAt ?? Infinity) < since) {
      entry.lastSearchedAt = undefined;
    }
    if (entry.lastSearch && entry.lastSearch.end < since) {
      entry.lastSearch = undefined;
      entry.searchMs = 0;
    }
  }

  private remove(entry: TrackedProgress): void {
    const k = key(entry.mediaId, entry.is4k);
    this.cancelEviction(k);
    this.entries.delete(k);
    if (entry.finishedAt === undefined) this.reportFinished(entry);
    this.emit('removed', entry.mediaId, entry.is4k, this.final(entry));
  }

  public ensure(args: Parameters<ProgressTracker['start']>[0]) {
    const entry = this.entries.get(key(args.mediaId, args.is4k));
    if (!entry) return this.start(args);
    if (!entry.serverKey && args.serverKey) entry.serverKey = args.serverKey;
    return entry;
  }

  public entry(mediaId: number, is4k: boolean): TrackedProgress | undefined {
    return this.entries.get(key(mediaId, is4k));
  }

  /** All entries, finished ones included until they are evicted. */
  public tracked(): TrackedProgress[] {
    return [...this.entries.values()];
  }

  /** Entries not playable yet; failed ones included, as a later event may recover them. */
  public incomplete(): TrackedProgress[] {
    return [...this.entries.values()].filter(
      (e) => e.steps.playable.status !== 'done'
    );
  }

  /** Entries still waiting for a step. */
  public active(): TrackedProgress[] {
    return [...this.entries.values()].filter((e) => !this.finished(e));
  }

  public get(mediaId: number, is4k: boolean): RequestProgress | undefined {
    const entry = this.entry(mediaId, is4k);
    return entry && this.snapshot(entry);
  }

  /**
   * Sets the units of a series (or the movie's single one) with whether Radarr/Sonarr lists a
   * file for each; `syncFiles` applies the file states once the history is in. An empty list
   * keeps the units.
   */
  public setUnits(
    mediaId: number,
    is4k: boolean,
    units: Pick<Unit, 'id' | 'seasonNumber' | 'episodeNumber' | 'hasFile'>[],
    { at = this.now(), cause }: Change = {}
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'units', (entry) => {
      if (units.length === 0) return;
      const next = new Map<number, Unit>();
      for (const { id, seasonNumber, episodeNumber, hasFile } of units) {
        // Episode ids are never 0, so only a movie takes over the placeholder.
        const unit = entry.units.get(id) ?? newUnit(id);
        Object.assign(unit, { seasonNumber, episodeNumber });
        unit.arrHasFile = hasFile;
        next.set(id, unit);
      }
      entry.units = next;
      entry.unitsKnown = true;
      entry.filesLoadedAt = at;
    });
  }

  /**
   * Applies the file states of the last `setUnits`: a file listed counts as imported, a file gone
   * that was imported before that answer sends its unit back to searching.
   */
  public syncFiles(
    mediaId: number,
    is4k: boolean,
    { at = this.now(), cause }: Change = {}
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'files', (entry) => {
      const loadedAt = entry.filesLoadedAt ?? at;
      const added: Unit[] = [];
      const deleted: Unit[] = [];
      for (const unit of entry.units.values()) {
        if (unit.arrHasFile && !unit.hasFile) {
          Object.assign(unit, { hasFile: true, importedAt: at });
          unit.failure = undefined;
          added.push(unit);
        } else if (
          unit.arrHasFile === false &&
          unit.hasFile &&
          (unit.importedAt ?? 0) < loadedAt - FILE_STATE_RACE_MS
        ) {
          Object.assign(unit, {
            downloadId: undefined,
            grabbedAt: undefined,
            downloadedAt: undefined,
            hasFile: false,
            importedAt: undefined,
            inJellyfin: false,
            failure: undefined,
          });
          deleted.push(unit);
        }
      }
      if (added.length > 0) {
        this.recover(entry, at);
        this.note(entry, at, cause, {
          step: 'importing',
          kind: 'imported',
          units: added,
          source: 'files',
        });
      }
      if (deleted.length > 0) {
        this.note(entry, at, cause, {
          step: 'searching',
          kind: 'fileDeleted',
          units: deleted,
          detail: 'Back to searching',
          source: 'files',
        });
      }
    });
  }

  /** Assigns a download to units without a file; a pack assigns all of its episodes. */
  public grab(
    mediaId: number,
    is4k: boolean,
    {
      downloadId,
      unitIds,
      title,
      indexer,
      source = 'history',
      at = this.now(),
      cause,
    }: {
      downloadId: string;
      unitIds: number[];
      title?: string;
      indexer?: string;
      source?: ProgressTimelineSource;
    } & Change
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'grab', (entry) =>
      this.applyGrab(entry, downloadId, unitIds, at, source, cause, {
        title,
        indexer,
      })
    );
  }

  /** Takes the download from its units, which go back to searching; the run goes on. */
  public downloadFailed(
    mediaId: number,
    is4k: boolean,
    {
      downloadId,
      unitIds,
      reason,
      detail,
      source = 'history',
      at = this.now(),
      cause,
    }: {
      downloadId: string;
      /** Absent: every unit of the download. */
      unitIds?: number[];
      reason: string;
      detail?: string;
      source?: ProgressTimelineSource;
    } & Change
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'download failed', (entry) =>
      this.applyFailed(entry, downloadId, unitIds, at, source, cause, {
        reason,
        detail,
      })
    );
  }

  public imported(
    mediaId: number,
    is4k: boolean,
    {
      downloadId,
      unitIds,
      source = 'history',
      at = this.now(),
      cause,
    }: {
      downloadId?: string;
      unitIds: number[];
      source?: ProgressTimelineSource;
    } & Change
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'import', (entry) => {
      const units = this.fresh(
        entry,
        `imported:${downloadId ?? 'manual'}`,
        unitIds
      ).filter((u) => !u.hasFile);
      if (units.length === 0) return;
      for (const unit of units) {
        unit.hasFile = true;
        unit.importedAt = at;
        unit.failure = undefined;
        if (downloadId && !unit.downloadId) {
          unit.downloadId = downloadId;
        }
        unit.downloadedAt ??= at;
      }
      this.recover(entry, at);
      this.note(entry, at, cause, {
        step: 'importing',
        kind: 'imported',
        units,
        downloadId,
        detail: downloadId && entry.releases.get(downloadId)?.title,
        source,
      });
      if (downloadId) this.recordDownload(entry, downloadId, 'importing');
    });
  }

  /**
   * Applies the queue as it is now: downloads assign their units, finished or importing ones move
   * them to importing, blocked ones fail the import, failed ones fail the download. A download
   * gone from the queue counts as finished.
   */
  public setQueue(
    mediaId: number,
    is4k: boolean,
    items: QueueItemState[],
    { at = this.now(), cause }: Change = {}
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'queue', (entry) => {
      const next = new Map<string, QueueItemState>();
      for (const item of items) {
        if (item.state === 'failed') {
          this.applyFailed(
            entry,
            item.downloadId,
            item.unitIds,
            at,
            'queue',
            cause,
            { reason: item.reason ?? 'Download failed' }
          );
          continue;
        }
        const units = this.resolve(entry, item.unitIds).filter(
          (u) => !u.hasFile
        );
        if (units.length === 0) continue;
        this.applyGrab(
          entry,
          item.downloadId,
          item.unitIds,
          at,
          'queue',
          cause,
          {
            title: item.title,
            indexer: item.indexer,
          }
        );
        const own = units.filter((u) => u.downloadId === item.downloadId);
        if (item.state !== 'downloading') {
          this.applyDownloaded(entry, item.downloadId, own, at, cause);
        }
        const blockKey = `blocked:${item.downloadId}`;
        if (item.state === 'blocked') {
          const blocked = own.filter((u) => !u.failure);
          for (const unit of blocked) {
            unit.failure = {
              step: 'importing',
              reason: item.reason ?? 'Import blocked',
            };
          }
          if (blocked.length > 0 && !entry.seen.has(blockKey)) {
            entry.seen.add(blockKey);
            this.note(entry, at, cause, {
              step: 'importing',
              kind: 'importBlocked',
              units: blocked,
              downloadId: item.downloadId,
              detail: item.reason,
              source: 'queue',
            });
          }
        } else {
          entry.seen.delete(blockKey);
          for (const unit of own) {
            if (unit.failure?.step === 'importing') unit.failure = undefined;
          }
        }
        next.set(item.downloadId, item);
      }
      for (const downloadId of entry.queue.keys()) {
        if (next.has(downloadId)) continue;
        const left = [...entry.units.values()].filter(
          (u) => u.downloadId === downloadId && !u.hasFile
        );
        this.applyDownloaded(entry, downloadId, left, at, cause);
      }
      entry.queue = next;
    });
  }

  /**
   * Sets which units Jellyfin has, ready to play. A unit Radarr/Sonarr lists no file for does not
   * count as in Jellyfin, which notices deletions later. The run is ready with the last unit.
   */
  public setJellyfin(
    mediaId: number,
    is4k: boolean,
    {
      present,
      playUrl,
      at = this.now(),
      cause,
    }: {
      present: (unit: Unit) => boolean;
      playUrl?: string;
    } & Change
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'Jellyfin', (entry) => {
      const added: Unit[] = [];
      const left: Unit[] = [];
      for (const unit of entry.units.values()) {
        const inJellyfin = present(unit);
        if (inJellyfin && !unit.inJellyfin) added.push(unit);
        if (!inJellyfin && unit.inJellyfin) left.push(unit);
        unit.inJellyfin = inJellyfin;
      }
      if (added.length > 0) {
        this.recover(entry, at);
        this.note(entry, at, cause, {
          step: 'inJellyfin',
          kind: 'inJellyfin',
          units: added,
          source: 'jellyfin',
        });
      }
      if (left.length > 0) {
        this.note(entry, at, cause, {
          step: 'inJellyfin',
          kind: 'leftJellyfin',
          units: left,
          source: 'jellyfin',
        });
      }
      entry.playUrl = playUrl ?? entry.playUrl;
    });
  }

  /** Fails the whole request at the first step not done yet; unit progress after it recovers. */
  public fail(
    mediaId: number,
    is4k: boolean,
    error: string,
    at = this.now()
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry || entry.requestError || this.finished(entry)) return;
    this.mutate(mediaId, is4k, at, error, () => {
      entry.requestError = { error, at };
      this.note(entry, at, error, {
        step:
          STEP_KEYS.find((k) => entry.steps[k].status !== 'done') ??
          'requested',
        kind: 'requestFailed',
        detail: error,
        source: 'request',
      });
    });
  }

  /** Shows the request status FAILED, with its failure reason or the one Radarr/Sonarr gives. */
  public failRequest(
    mediaId: number,
    is4k: boolean,
    failureReason?: string | null,
    at = this.now()
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (entry && failureReason && entry.failureReason !== failureReason) {
      entry.failureReason = failureReason;
      // A run already failed keeps its step, only its error text changes.
      if (this.finished(entry)) this.changed(entry);
    }
    this.fail(mediaId, is4k, REQUEST_FAILED, at);
  }

  /**
   * Updates the search state. A new command clears the failures of the units still searched for.
   * Without search events, a `lastSearchedAt` after the running search started ends it.
   */
  public setSearch(
    mediaId: number,
    is4k: boolean,
    search: Pick<
      TrackedProgress,
      | 'searchCommandId'
      | 'searchIndexers'
      | 'lastSearchedAt'
      | 'unreleased'
      | 'releaseDate'
    >,
    { at = this.now(), cause }: Change = {}
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'search', (entry) => {
      const started =
        search.searchCommandId !== undefined &&
        search.searchCommandId !== entry.searchCommandId;
      Object.assign(entry, search);
      if (
        !started &&
        entry.searchCommandId === undefined &&
        entry.searchStartedAt !== undefined &&
        (search.lastSearchedAt ?? 0) >= entry.searchStartedAt
      ) {
        this.endSearch(entry, search.lastSearchedAt as number);
      }
      if (!started) return;
      entry.searchStartedAt ??= at;
      for (const unit of entry.units.values()) {
        if ((failedAt(unit) ?? Infinity) <= GRABBED) unit.failure = undefined;
      }
      this.note(entry, at, cause, {
        step: 'searching',
        kind: 'searchStarted',
        detail: `Command ${search.searchCommandId}`,
        source: 'search',
      });
    });
  }

  /**
   * A search command ended. Without `error` the units still without a release wait for RSS;
   * with it they fail at searching.
   */
  public searchFinished(
    mediaId: number,
    is4k: boolean,
    {
      commandId,
      error,
      at = this.now(),
      cause,
    }: { commandId: number; error?: string } & Change
  ): void {
    this.mutate(mediaId, is4k, at, cause ?? 'search finished', (entry) => {
      if (entry.searchCommandId === commandId) {
        entry.searchCommandId = undefined;
        entry.searchIndexers = undefined;
      }
      if (
        entry.searchCommandId === undefined &&
        entry.searchStartedAt !== undefined
      ) {
        this.endSearch(entry, at);
      }
      entry.lastSearchedAt = at;
      const commandKey = `search:${commandId}`;
      if (entry.seen.has(commandKey)) return;
      entry.seen.add(commandKey);
      const missing = [...entry.units.values()].filter(
        (u) => unitStage(u) === SEARCHING && failedAt(u) === undefined
      );
      if (error) {
        for (const unit of missing) {
          unit.failure = { step: 'searching', reason: error };
        }
      }
      const total = entry.units.size;
      this.note(entry, at, cause, {
        step: 'searching',
        kind: error ? 'searchFailed' : 'searchFinished',
        detail: error
          ? `Command ${commandId}: ${error}`
          : missing.length === 0
            ? `Command ${commandId}`
            : total > 1
              ? `Command ${commandId}: ${missing.length} of ${total} not found`
              : `Command ${commandId}: no release found`,
        source: 'search',
      });
    });
  }

  public finished(entry: TrackedProgress): boolean {
    return (
      entry.steps.playable.status === 'done' ||
      STEP_KEYS.some((k) => entry.steps[k].status === 'failed')
    );
  }

  /**
   * Waits for a release with nothing running: its search ended without a grab, or nothing is
   * released. Only events naming its item, the queue holding it and the full sync refresh it.
   */
  public dormant(entry: TrackedProgress): boolean {
    return (
      entry.unreleased !== undefined &&
      entry.steps.requested.status === 'done' &&
      !this.finished(entry) &&
      entry.searchCommandId === undefined &&
      entry.searchStartedAt === undefined &&
      entry.queue.size === 0 &&
      [...entry.units.values()].every((u) => unitStage(u) === SEARCHING)
    );
  }

  public snapshot(entry: TrackedProgress): RequestProgress {
    const { estimatePercentile: p, showConfidenceInterval } =
      getSettings().requestProgress;
    const estimates = entry.serverKey
      ? this.stats.get(entry.serverKey)
      : undefined;
    const units = [...entry.units.values()];
    const steps = STEP_KEYS.map((k) => {
      const state = entry.steps[k];
      // Ready is no phase of its own: it completes with the last unit in Jellyfin.
      const stats =
        k === 'requested' || k === 'playable' ? undefined : estimates?.[k];
      const estimate =
        stats && stats.historyCount + stats.localCount >= MIN_STEP_SAMPLES
          ? stats.percentiles[p]
          : undefined;
      return {
        key: k,
        status: state.status,
        startedAt: iso(state.startedAt),
        finishedAt: iso(state.finishedAt),
        estimateMs: estimate?.valueMs,
        estimateRangeMs: showConfidenceInterval ? estimate?.rangeMs : undefined,
        error:
          state.status !== 'failed'
            ? undefined
            : (entry.failureReason ??
              (state.error === REQUEST_FAILED
                ? (entry.arrError ?? REQUEST_FAILED)
                : state.error)),
        ...(k === 'searching'
          ? this.searchTimes(entry)
          : {
              waiting:
                k === 'grabbed' && state.idleSince !== undefined
                  ? ('grab' as const)
                  : undefined,
              waitingSince: iso(state.idleSince),
            }),
        detail:
          k === 'searching' && state.status === 'running'
            ? this.searchingDetail(entry)
            : k === 'grabbed'
              ? this.releaseTitles(entry)
              : undefined,
        counts: state.counts,
        progress: state.progress,
      };
    });
    const single = units.length === 1;
    const totals = entry.serverKey
      ? this.stats.total(entry.serverKey)
      : undefined;
    const total =
      totals && totals.localCount >= MIN_TOTAL_SAMPLES
        ? totals.percentiles[p]
        : undefined;
    const stepSum = steps.flatMap((s) => s.estimateMs ?? []);
    const downloads: ProgressDownload[] = [...entry.queue.values()]
      .filter((item) =>
        this.resolve(entry, item.unitIds).some((u) => !u.hasFile)
      )
      .map(({ title, indexer, size, sizeLeft, etaMs }) => ({
        title,
        indexer,
        size,
        sizeLeft,
        etaMs,
      }));
    return {
      mediaId: entry.mediaId,
      is4k: entry.is4k,
      requests: this.requestStates(entry),
      steps,
      totalEstimateMs: !single
        ? undefined
        : (total?.valueMs ??
          (stepSum.length ? stepSum.reduce((a, b) => a + b, 0) : undefined)),
      totalEstimateRangeMs:
        single && showConfidenceInterval ? total?.rangeMs : undefined,
      estimatePercentile: p,
      playUrl:
        entry.steps.playable.status === 'done' ? entry.playUrl : undefined,
      dormant: this.dormant(entry) || undefined,
      releaseDate: iso(entry.releaseDate),
      downloads:
        entry.steps.playable.status === 'done' || downloads.length === 0
          ? undefined
          : downloads,
      timeline: entry.timeline.length > 0 ? [...entry.timeline] : undefined,
    };
  }

  /** What the searching step waits for while no search runs, if anything. */
  private waiting(entry: TrackedProgress): 'release' | 'rss' | undefined {
    if (
      entry.searchStartedAt !== undefined ||
      entry.steps.searching.status !== 'running' ||
      ![...entry.units.values()].some((u) => unitStage(u) === SEARCHING)
    ) {
      return undefined;
    }
    return entry.unreleased ? 'release' : 'rss';
  }

  /** Search time apart from waiting, for the searching step. */
  private searchTimes(entry: TrackedProgress) {
    const waiting = this.waiting(entry);
    const since = Math.max(
      entry.lastSearch?.end ?? 0,
      entry.lastSearchedAt ?? 0,
      entry.steps.searching.startedAt ?? 0
    );
    return {
      searchMs: entry.searchMs || undefined,
      searchStartedAt: iso(entry.searchStartedAt),
      waiting,
      waitingSince: waiting && since > 0 ? iso(since) : undefined,
    };
  }

  /**
   * Where each request stands: the step of its least advanced unit. A season without aired
   * episodes has no unit and waits for its release. Waiting counts from the request or the last
   * search after it.
   */
  private requestStates(entry: TrackedProgress): ProgressRequest[] {
    return [...entry.requests.values()]
      .sort((a, b) => a.id - b.id)
      .map((request) => {
        const base = {
          id: request.id,
          seasons: request.seasons,
          requestedBy: request.requestedBy,
          requestedAt: iso(request.at),
        };
        if (request.awaitingApproval) {
          return { ...base, step: 'requested' as const, status: 'running' };
        }
        const failedStep = entry.requestError
          ? STEP_KEYS.find((k) => entry.steps[k].status === 'failed')
          : undefined;
        if (failedStep) return { ...base, step: failedStep, status: 'failed' };
        const units = entry.unitsKnown
          ? [...entry.units.values()].filter((u) => covers(request, u))
          : [...entry.units.values()];
        const failed = units.map(failedAt);
        if (
          units.length > 0 &&
          entry.searchCommandId === undefined &&
          failed.every((f) => f !== undefined)
        ) {
          return {
            ...base,
            step: PROGRESS_STEPS[Math.min(...(failed as number[]))],
            status: 'failed',
          };
        }
        const stage = units.length
          ? Math.min(...units.map(unitStage))
          : SEARCHING;
        if (stage === PLAYABLE) {
          return { ...base, step: 'playable' as const, status: 'done' };
        }
        const searching =
          stage === SEARCHING && entry.searchStartedAt === undefined;
        const since = Math.max(
          request.at,
          entry.lastSearch?.end ?? 0,
          entry.lastSearchedAt ?? 0
        );
        return {
          ...base,
          step: PROGRESS_STEPS[stage],
          status: 'running',
          waiting: !searching
            ? undefined
            : units.length === 0 || entry.unreleased
              ? 'release'
              : 'rss',
          waitingSince: searching ? iso(since) : undefined,
        };
      });
  }

  private searchingDetail(entry: TrackedProgress): string {
    if (entry.searchStartedAt !== undefined) {
      return entry.searchIndexers
        ? `Searching (${entry.searchIndexers} indexers)`
        : 'Searching';
    }
    if (entry.unreleased) return WAITING_FOR_RELEASE;
    const total = entry.units.size;
    const missing = [...entry.units.values()].filter(
      (u) => unitStage(u) === SEARCHING
    ).length;
    return total > 1 && missing > 0
      ? `${missing} of ${total} not found yet, waiting for RSS`
      : WAITING_FOR_RSS;
  }

  /** Ends the running search at `at`. */
  private endSearch(entry: TrackedProgress, at: number): void {
    const start = entry.searchStartedAt as number;
    const end = Math.max(start, at);
    entry.searchMs += end - start;
    entry.lastSearch = { start, end };
    entry.searchStartedAt = undefined;
  }

  /**
   * Once no unit is searched for anymore, a grab during a search ends it there and, for a single
   * unit, records the search as a sample. A grab outside any search came from RSS while waiting.
   */
  private grabEndsSearch(entry: TrackedProgress, at: number): void {
    if ([...entry.units.values()].some((u) => unitStage(u) === SEARCHING)) {
      return;
    }
    let start: number;
    if (entry.searchStartedAt !== undefined && at >= entry.searchStartedAt) {
      start = entry.searchStartedAt;
      this.endSearch(entry, at);
    } else if (
      entry.lastSearch &&
      at >= entry.lastSearch.start &&
      at <= entry.lastSearch.end
    ) {
      // The grab is reported after its search finished.
      start = entry.lastSearch.start;
      entry.searchMs -= entry.lastSearch.end - at;
      entry.lastSearch.end = at;
    } else {
      return;
    }
    if (
      entry.units.size !== 1 ||
      entry.reconstructed ||
      !entry.serverKey ||
      entry.seen.has(SEARCH_SAMPLE)
    ) {
      return;
    }
    entry.seen.add(SEARCH_SAMPLE);
    this.stats.record(entry.serverKey, 'searching', at - start, {
      at,
      downloadId: [...entry.units.values()][0].downloadId,
    });
  }

  private releaseTitles(entry: TrackedProgress): string | undefined {
    const titles = new Set<string>();
    for (const unit of entry.units.values()) {
      const title =
        unit.downloadId && entry.releases.get(unit.downloadId)?.title;
      if (title) titles.add(title);
    }
    return titles.size > 0 ? [...titles].join(', ') : undefined;
  }

  /** The units with these ids; a series not loaded yet maps everything to its placeholder. */
  private resolve(entry: TrackedProgress, ids: number[]): Unit[] {
    if (!entry.unitsKnown) return [...entry.units.values()];
    return ids.flatMap((id) => entry.units.get(id) ?? []);
  }

  /** The units with these ids that `prefix` was not applied to yet; marks them applied. */
  private fresh(entry: TrackedProgress, prefix: string, ids: number[]) {
    return this.resolve(entry, ids).filter((u) => {
      const k = `${prefix}:${u.id}`;
      if (entry.seen.has(k)) return false;
      entry.seen.add(k);
      return true;
    });
  }

  private applyGrab(
    entry: TrackedProgress,
    downloadId: string,
    unitIds: number[],
    at: number,
    source: ProgressTimelineSource,
    cause: string | undefined,
    release: { title?: string; indexer?: string }
  ): void {
    const known = entry.releases.get(downloadId);
    entry.releases.set(downloadId, {
      title: known?.title ?? release.title,
      indexer: known?.indexer ?? release.indexer,
    });
    const units = this.fresh(entry, `grabbed:${downloadId}`, unitIds).filter(
      (u) => !u.hasFile && u.downloadId !== downloadId
    );
    if (units.length === 0) return;
    for (const unit of units) {
      Object.assign(unit, {
        downloadId,
        grabbedAt: at,
        downloadedAt: undefined,
        failure: undefined,
      });
    }
    this.recover(entry, at);
    this.grabEndsSearch(entry, at);
    const { title, indexer } = entry.releases.get(downloadId) ?? {};
    this.note(entry, at, cause, {
      step: 'grabbed',
      kind: 'grabbed',
      units,
      downloadId,
      detail: title && (indexer ? `${title} (${indexer})` : title),
      source,
    });
  }

  private applyFailed(
    entry: TrackedProgress,
    downloadId: string,
    unitIds: number[] | undefined,
    at: number,
    source: ProgressTimelineSource,
    cause: string | undefined,
    { reason, detail }: { reason: string; detail?: string }
  ): void {
    const ids =
      unitIds ??
      [...entry.units.values()]
        .filter((u) => u.downloadId === downloadId)
        .map((u) => u.id);
    const units = this.fresh(entry, `failed:${downloadId}`, ids).filter(
      (u) => u.downloadId === downloadId && !u.hasFile
    );
    if (units.length === 0) return;
    for (const unit of units) {
      Object.assign(unit, {
        downloadId: undefined,
        grabbedAt: undefined,
        downloadedAt: undefined,
        failure: { step: 'grabbed', reason },
      });
    }
    this.note(entry, at, cause, {
      step: 'grabbed',
      kind: 'downloadFailed',
      units,
      downloadId,
      detail: `${detail ?? reason}, back to searching`,
      source,
    });
  }

  private applyDownloaded(
    entry: TrackedProgress,
    downloadId: string,
    units: Unit[],
    at: number,
    cause: string | undefined
  ): void {
    const done = units.filter((u) => u.downloadedAt === undefined);
    if (done.length === 0) return;
    for (const unit of done) unit.downloadedAt = at;
    this.recover(entry, at);
    this.note(entry, at, cause, {
      step: 'grabbed',
      kind: 'downloaded',
      units: done,
      downloadId,
      source: 'queue',
    });
    this.recordDownload(entry, downloadId, 'grabbed');
  }

  /**
   * Records one sample per download once all its units passed `step`: from the grab, divided by
   * its number of units, so a season pack counts as per-episode time.
   */
  private recordDownload(
    entry: TrackedProgress,
    downloadId: string,
    step: 'grabbed' | 'importing'
  ): void {
    if (entry.reconstructed || !entry.serverKey) return;
    const units = [...entry.units.values()].filter(
      (u) => u.downloadId === downloadId
    );
    const field = step === 'grabbed' ? 'downloadedAt' : 'importedAt';
    if (
      units.length === 0 ||
      units.some((u) => u[field] === undefined || u.grabbedAt === undefined)
    ) {
      return;
    }
    const sampleKey = `sample:${step}:${downloadId}`;
    if (entry.seen.has(sampleKey)) return;
    entry.seen.add(sampleKey);
    const end = Math.max(...units.map((u) => u[field] as number));
    const start = Math.min(...units.map((u) => u.grabbedAt as number));
    this.stats.record(
      entry.serverKey,
      step,
      Math.max(0, end - start) / units.length,
      { at: end, downloadId }
    );
  }

  /** Unit progress after a request failure recovers the run. */
  private recover(entry: TrackedProgress, at: number): void {
    if (entry.requestError && at > entry.requestError.at) {
      entry.requestError = undefined;
    }
  }

  private note(
    entry: TrackedProgress,
    at: number,
    cause: string | undefined,
    {
      units,
      downloadId,
      seasons,
      ...rest
    }: {
      step: ProgressStepKey;
      kind: ProgressTimelineKind;
      units?: Unit[];
      /** Records of the same event and download merge into one entry. */
      downloadId?: string;
      detail?: string;
      source: ProgressTimelineSource;
      /** Default: those of the units, else those of the requests. */
      seasons?: number[];
    }
  ): void {
    const atIso = new Date(at).toISOString();
    // History arrives later than the queue and searches; keep the list in time order.
    let i = entry.timeline.length;
    while (i > 0 && entry.timeline[i - 1].at > atIso) i--;
    const prev = entry.timeline[i - 1];
    const prevUnits = prev && this.timelineUnits.get(prev);
    // Sonarr reports a season pack once per episode; its records make one entry.
    const merge =
      units &&
      prevUnits &&
      prevUnits.downloadId === downloadId &&
      prev.at === atIso &&
      prev.kind === rest.kind &&
      prev.step === rest.step &&
      prev.detail === rest.detail &&
      prev.source === rest.source;
    const all = merge ? [...prevUnits.units, ...units] : units;
    const labels = all && unitLabels(all);
    const seasonList = [
      ...new Set(
        seasons ??
          (all?.some((u) => u.seasonNumber !== undefined)
            ? all.flatMap((u) => u.seasonNumber ?? [])
            : [...entry.requests.values()].flatMap((r) => r.seasons ?? []))
      ),
    ].sort((a, b) => a - b);
    const item: ProgressTimelineEntry = {
      at: atIso,
      ...rest,
      units: labels?.length ? labels : undefined,
      seasons: seasonList.length ? seasonList : undefined,
    };
    if (all) this.timelineUnits.set(item, { units: all, downloadId });
    if (merge) {
      entry.timeline[i - 1] = item;
    } else {
      entry.timeline.splice(i, 0, item);
      if (entry.timeline.length > TIMELINE_SIZE) entry.timeline.shift();
    }
    logger.debug(
      `${rest.kind}${item.units ? ` ${item.units.join(', ')}` : ''}${
        rest.detail ? `: ${rest.detail}` : ''
      }`,
      {
        label: 'Request Progress',
        mediaId: entry.mediaId,
        is4k: entry.is4k,
        step: rest.step,
        cause,
      }
    );
  }

  /** Applies `fn`, recomputes the steps and emits a change when the snapshot differs. */
  private mutate(
    mediaId: number,
    is4k: boolean,
    at: number,
    cause: string,
    fn: (entry: TrackedProgress) => void
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry) return;
    const before = JSON.stringify(this.snapshot(entry));
    fn(entry);
    this.recompute(entry, at, cause);
    if (JSON.stringify(this.snapshot(entry)) !== before) this.changed(entry);
  }

  /** Derives every step from the units; times and samples follow the status changes. */
  private recompute(entry: TrackedProgress, at: number, cause: string): void {
    const units = [...entry.units.values()];
    const total = units.length;
    const allFailed =
      entry.searchCommandId === undefined &&
      units.every((u) => failedAt(u) !== undefined);
    const counts = PROGRESS_STEPS.map(() => ({
      done: 0,
      active: 0,
      failed: 0,
      total,
    }));
    const reasons: (string | undefined)[] = [];
    let downloaded = 0;
    for (const unit of units) {
      const failed = failedAt(unit);
      if (failed !== undefined) {
        counts[failed].failed++;
        reasons[failed] ??= unit.failure?.reason;
        if (failed === GRABBED && !allFailed) counts[SEARCHING].active++;
        else for (let i = 0; i < failed; i++) counts[i].done++;
        if (failed > GRABBED) downloaded++;
        continue;
      }
      const stage = unitStage(unit);
      for (let i = 0; i < stage; i++) counts[i].done++;
      if (stage === PLAYABLE) counts[PLAYABLE].done++;
      else counts[stage].active++;
      if (stage > GRABBED) downloaded++;
      else if (stage === GRABBED) {
        const item = unit.downloadId && entry.queue.get(unit.downloadId);
        if (item && item.size > 0) {
          downloaded += Math.max(0, item.size - item.sizeLeft) / item.size;
        }
      }
    }

    const awaiting = awaitingApproval(entry);
    const next: Record<string, StepState> = {
      requested: {
        status: awaiting ? 'running' : 'done',
      },
    };
    PROGRESS_STEPS.forEach((k, i) => {
      const c = counts[i];
      next[k] = {
        status: awaiting
          ? 'pending'
          : allFailed && c.failed > 0
            ? 'failed'
            : c.done === total
              ? 'done'
              : k !== 'playable' && (c.active > 0 || c.done > 0)
                ? 'running'
                : 'pending',
        error: allFailed && c.failed > 0 ? reasons[i] : undefined,
        counts: c,
        progress: (k === 'grabbed' ? downloaded : c.done) / total,
      };
    });
    if (entry.requestError) {
      const k = STEP_KEYS.find((s) => next[s].status !== 'done');
      if (k)
        next[k] = {
          ...next[k],
          status: 'failed',
          error: entry.requestError.error,
        };
    }

    for (const k of STEP_KEYS) {
      const prev = entry.steps[k];
      const state = next[k];
      let { startedAt, finishedAt } = prev;
      if (state.status === 'pending') startedAt = undefined;
      else startedAt ??= at;
      finishedAt =
        state.status === 'done' || state.status === 'failed'
          ? prev.status === state.status
            ? finishedAt
            : at
          : undefined;
      // Searching has its own waiting, see searchTimes.
      const idle =
        k !== 'searching' &&
        state.status === 'running' &&
        state.counts?.active === 0;
      const idleSince = idle ? (prev.idleSince ?? at) : undefined;
      entry.steps[k] = { ...state, startedAt, finishedAt, idleSince };
      if (prev.status === state.status) continue;
      logger.debug(`Step ${k}: ${prev.status} -> ${state.status}`, {
        label: 'Request Progress',
        mediaId: entry.mediaId,
        is4k: entry.is4k,
        counts: state.counts,
        cause,
      });
      if (k === 'playable' && state.status === 'done') {
        this.note(entry, at, cause, {
          step: 'playable',
          kind: 'playable',
          source: 'jellyfin',
        });
      }
      if (
        state.status !== 'done' ||
        total !== 1 ||
        !entry.serverKey ||
        entry.reconstructed ||
        startedAt === undefined
      ) {
        continue;
      }
      if (k === 'inJellyfin') {
        this.stats.record(entry.serverKey, k, Math.max(0, at - startedAt), {
          at,
          downloadId: units[0].downloadId,
        });
      }
      const requestedAt = entry.steps.requested.startedAt ?? at;
      // A search ran from the request to the grab, so the total holds no waiting.
      const waited =
        (units[0].grabbedAt ?? requestedAt) - requestedAt - entry.searchMs;
      if (
        k === 'playable' &&
        entry.seen.has(SEARCH_SAMPLE) &&
        waited <= SEARCH_GAP_MS
      ) {
        this.stats.recordTotal(
          entry.serverKey,
          Math.max(0, at - requestedAt),
          at
        );
      }
    }
  }

  private changed(entry: TrackedProgress): void {
    const k = key(entry.mediaId, entry.is4k);
    this.cancelEviction(k);
    if (this.finished(entry)) {
      this.evictions.set(
        k,
        setTimeout(() => {
          this.evictions.delete(k);
          this.entries.delete(k);
        }, KEEP_FINISHED_MS).unref()
      );
    }
    this.emit('change', this.snapshot(entry));
    if (!this.finished(entry)) entry.finishedAt = undefined;
    else if (entry.finishedAt === undefined) this.reportFinished(entry);
  }

  private reportFinished(entry: TrackedProgress): void {
    entry.finishedAt = this.now();
    this.emit('finished', this.final(entry), [...entry.requests.keys()]);
  }

  /** The snapshot of a run that is over, read-only for the pop-up. */
  private final(entry: TrackedProgress): RequestProgress {
    return { ...this.snapshot(entry), finishedAt: iso(entry.finishedAt) };
  }

  private cancelEviction(k: string): void {
    clearTimeout(this.evictions.get(k));
    this.evictions.delete(k);
  }
}

const progressTracker = new ProgressTracker();

export default progressTracker;
