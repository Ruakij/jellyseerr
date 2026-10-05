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
  p90Ms?: number; // absent without samples
  error?: string; // set when status is 'failed'
  detail?: string; // searching: latest Radarr/Sonarr command message; grabbed: release title(s)
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
  totalP90Ms?: number;
  playUrl?: string; // Jellyfin deep link once playable
  downloads?: ProgressDownload[]; // queue items of this request while grabbed
}
