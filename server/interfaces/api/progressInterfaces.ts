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
  requestId?: number;
  steps: ProgressStep[];
  totalEstimateMs?: number; // percentile of end-to-end runs from 20 of them, else the sum of the step estimates
  totalEstimateRangeMs?: [number, number]; // only when enabled and taken from end-to-end runs
  estimatePercentile: EstimatePercentile;
  playUrl?: string; // Jellyfin deep link once playable
  downloads?: ProgressDownload[]; // queue items of this request while grabbed
  search?: ProgressSearch; // computed per viewer
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
