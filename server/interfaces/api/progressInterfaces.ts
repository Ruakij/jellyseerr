export type ProgressStepKey =
  | 'requested'
  | 'searching'
  | 'grabbed'
  | 'importing'
  | 'inJellyfin'
  | 'playable';

export type ProgressStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ProgressStep {
  key: ProgressStepKey;
  status: ProgressStepStatus;
  startedAt?: string; // ISO
  finishedAt?: string;
  estimateMs?: number; // duration at RequestProgress.estimatePercentile; absent without samples
  estimateRangeMs?: [number, number]; // 95% confidence interval of estimateMs; only when enabled and enough samples
  error?: string; // set when status is 'failed'
  detail?: string; // searching while running: 'Searching (N indexers)' or the waiting text; grabbed: release title(s)
  episodes?: ProgressEpisodes; // importing of a series request only
  counts?: ProgressCounts; // units per step; absent on `requested`
  progress?: number; // 0..1: done / total, byte-weighted for grabbed
  // searching only: search time without waiting
  searchMs?: number; // time finished searches ran
  searchStartedAt?: string; // ISO; start of the search running now
  // searching: no search runs and units still lack a release; grabbed: no unit downloads, the rest waits for a grab
  waiting?: 'release' | 'rss' | 'grab';
  // ISO; searching: set with `waiting`; other steps: running with no unit in it, its time stops there
  waitingSince?: string;
}

// Units (the movie, or the requested episodes) at a step
export interface ProgressCounts {
  done: number; // past the step
  active: number; // in the step
  failed: number; // last attempt failed at this step
  total: number; // units of the request
}

// Units of a series request with a file against all its units
export interface ProgressEpisodes {
  imported: number;
  total: number; // monitored aired episodes of the requested seasons and those with a file
}

export type ProgressTimelineKind =
  | 'requested'
  | 'searchStarted'
  | 'searchFinished'
  | 'searchFailed'
  | 'grabbed'
  | 'downloaded'
  | 'downloadFailed'
  | 'importBlocked'
  | 'imported'
  | 'fileDeleted'
  | 'inJellyfin'
  | 'leftJellyfin'
  | 'playable'
  | 'requestFailed';

export type ProgressTimelineSource =
  | 'request'
  | 'search'
  | 'history'
  | 'queue'
  | 'files'
  | 'jellyfin';

export interface ProgressTimelineEntry {
  at: string; // ISO
  step: ProgressStepKey;
  kind: ProgressTimelineKind;
  units?: string[]; // episodes as 'S01E07' or ranges 'S01E01-E24'; absent for a movie or the whole request
  detail?: string; // e.g. release title and indexer, failure reason; requested: the requester
  source: ProgressTimelineSource;
  seasons?: number[]; // series: seasons of its units, else of the requests active then
}

// One active request of the media; the run covers the units of all of them
export interface ProgressRequest {
  id: number;
  seasons?: number[]; // series only
  requestedBy?: string; // display name
  step: ProgressStepKey; // of its least advanced unit; requested while it awaits approval
  status: ProgressStepStatus;
  waiting?: 'release' | 'rss'; // searching with no search running
  waitingSince?: string; // ISO; the request or the last search after it
}

export interface ProgressDownload {
  title: string; // release title
  indexer?: string;
  size: number; // bytes
  sizeLeft: number;
  etaMs?: number; // from the download client, absent when unknown
}

// Payload of the `progress` SSE event on GET /api/v1/media/:mediaId/progress
export interface RequestProgress {
  mediaId: number;
  is4k: boolean;
  requests: ProgressRequest[]; // active ones by id; empty when no request is tracked
  steps: ProgressStep[];
  totalEstimateMs?: number; // percentile of end-to-end runs from 20 of them, else the sum of the step estimates
  totalEstimateRangeMs?: [number, number]; // only when enabled and taken from end-to-end runs
  estimatePercentile: EstimatePercentile;
  playUrl?: string; // Jellyfin deep link once playable
  dormant?: boolean; // waits for a release with nothing running; its waiting time does not tick
  downloads?: ProgressDownload[]; // queue items of units without a file
  timeline?: ProgressTimelineEntry[]; // last 100 events, oldest first; on the stream only when changed
  search?: ProgressSearch; // computed per viewer
  finishedAt?: string; // ISO; set on a run that is over (stored, or its requests left the tracker), shown read-only
}

// Manual search via POST /api/v1/media/:mediaId/progress/search
export interface ProgressSearch {
  allowed: boolean; // the viewer may search (manager, or the requester) and it is not playable yet
  retryAfter?: string; // ISO; set while the requester cooldown holds
  lastSearchedAt?: string; // ISO; last search by Radarr/Sonarr for the requested scope
  running: boolean; // a Radarr/Sonarr search command for the media is in flight
}

export type EstimatePercentile = 50 | 90 | 95 | 99;

export interface PercentileStat {
  valueMs: number; // nearest-rank percentile, a measured duration
  rangeMs?: [number, number]; // 95% confidence interval; absent when too few samples for one
}

export interface ProgressSampleStats {
  historyCount: number; // derived from the Radarr/Sonarr history
  localCount: number; // measured by Seerr
  percentiles: Partial<Record<EstimatePercentile, PercentileStat>>; // empty without samples
}

// GET /api/v1/settings/request-progress/stats
export interface RequestProgressStatsResponse {
  servers: {
    serverKey: string; // e.g. radarr-0
    name: string;
    steps: Record<Exclude<ProgressStepKey, 'requested'>, ProgressSampleStats>;
    total: ProgressSampleStats; // end-to-end runs, requested -> playable
  }[];
}
