export type ProgressStepKey =
  | 'requested'
  | 'searching'
  | 'grabbed'
  | 'importing'
  | 'inJellyfin'
  | 'playable';

export interface ProgressStep {
  key: ProgressStepKey;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  p90Ms?: number;
  error?: string;
}

export interface RequestProgress {
  mediaId: number;
  is4k: boolean;
  requestId?: number;
  steps: ProgressStep[];
  totalP90Ms?: number;
  playUrl?: string;
}
