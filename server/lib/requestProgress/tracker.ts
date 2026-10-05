import type {
  ProgressStepKey,
  RequestProgress,
} from '@server/interfaces/api/progressInterfaces';
import type { StepStats } from '@server/lib/requestProgress/stepStats';
import stepStats, {
  PROGRESS_STEPS,
} from '@server/lib/requestProgress/stepStats';
import { EventEmitter } from 'node:events';

export const STEP_KEYS: readonly ProgressStepKey[] = [
  'requested',
  ...PROGRESS_STEPS,
];

// Finished entries stay for a while so a reopened pop-up still shows the run.
export const KEEP_FINISHED_MS = 60 * 60 * 1000;

interface StepState {
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface TrackedProgress {
  mediaId: number;
  is4k: boolean;
  requestId?: number;
  /** StepStats key, e.g. `radarr-0`; absent until the serving Radarr/Sonarr is known. */
  serverKey?: string;
  downloadId?: string;
  /** Downloads given up on by a re-search; their history no longer applies. */
  staleDownloadIds: string[];
  searchCompletedAt?: number;
  playUrl?: string;
  steps: Record<ProgressStepKey, StepState>;
}

const key = (mediaId: number, is4k: boolean) => `${mediaId}:${is4k}`;
const iso = (ms?: number) =>
  ms === undefined ? undefined : new Date(ms).toISOString();

interface TrackerEvents {
  change: [RequestProgress];
}

export class ProgressTracker extends EventEmitter<TrackerEvents> {
  private entries = new Map<string, TrackedProgress>();
  private evictions = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly stats: Pick<
      StepStats,
      'get' | 'record' | 'recordTotal' | 'totalP90'
    > = stepStats,
    private readonly now: () => number = Date.now
  ) {
    super();
    // One listener per open progress stream.
    this.setMaxListeners(0);
  }

  /** Starts a fresh run, replacing any previous one of the same media. */
  public start({
    mediaId,
    is4k,
    requestId,
    serverKey,
  }: {
    mediaId: number;
    is4k: boolean;
    requestId?: number;
    serverKey?: string;
  }): TrackedProgress {
    const at = this.now();
    const steps = Object.fromEntries(
      STEP_KEYS.map((k) => [k, { status: 'pending' }])
    ) as Record<ProgressStepKey, StepState>;
    steps.requested = { status: 'done', startedAt: at, finishedAt: at };
    // Requests go out with searchNow, so the search runs from the request on.
    steps.searching = { status: 'running', startedAt: at };
    const entry: TrackedProgress = {
      mediaId,
      is4k,
      requestId,
      serverKey,
      staleDownloadIds: [],
      steps,
    };
    this.cancelEviction(key(mediaId, is4k));
    this.entries.set(key(mediaId, is4k), entry);
    this.changed(entry);
    return entry;
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
   * Marks `step` done at `at`. Earlier steps that are not done yet finish at the same time, so a
   * missed event never leaves a gap; the step after it starts running.
   */
  public advance(
    mediaId: number,
    is4k: boolean,
    step: ProgressStepKey,
    at = this.now(),
    { downloadId, playUrl }: { downloadId?: string; playUrl?: string } = {}
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry || entry.steps[step].status === 'done') return;
    if (downloadId) entry.downloadId = downloadId;
    if (playUrl) entry.playUrl = playUrl;

    const index = STEP_KEYS.indexOf(step);
    let previousEnd: number | undefined;
    for (const k of STEP_KEYS.slice(0, index + 1)) {
      const state = entry.steps[k];
      if (state.status !== 'done') {
        const startedAt = state.startedAt ?? previousEnd ?? at;
        entry.steps[k] = { status: 'done', startedAt, finishedAt: at };
        if (k !== 'requested' && entry.serverKey) {
          this.stats.record(entry.serverKey, k, Math.max(0, at - startedAt), {
            at,
            downloadId: entry.downloadId,
          });
        }
      }
      previousEnd = entry.steps[k].finishedAt;
    }
    if (step === 'playable' && entry.serverKey) {
      const requestedAt = entry.steps.requested.startedAt ?? at;
      this.stats.recordTotal(
        entry.serverKey,
        Math.max(0, at - requestedAt),
        at
      );
    }
    const next = STEP_KEYS[index + 1];
    if (next && entry.steps[next].status === 'pending') {
      entry.steps[next] = { status: 'running', startedAt: at };
    }
    this.changed(entry);
  }

  /** Fails the first step not done yet. A later advance past it recovers the run. */
  public fail(
    mediaId: number,
    is4k: boolean,
    error: string,
    at = this.now()
  ): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry || this.finished(entry)) return;
    const step = STEP_KEYS.find((k) => entry.steps[k].status !== 'done');
    if (!step) return;
    entry.steps[step] = {
      ...entry.steps[step],
      status: 'failed',
      finishedAt: at,
      error,
    };
    this.changed(entry);
  }

  /** Restarts the search, e.g. after Radarr/Sonarr gave up on a failed download. */
  public research(mediaId: number, is4k: boolean, at = this.now()): void {
    const entry = this.entry(mediaId, is4k);
    if (!entry) return;
    if (entry.downloadId) entry.staleDownloadIds.push(entry.downloadId);
    entry.downloadId = undefined;
    entry.searchCompletedAt = undefined;
    for (const k of STEP_KEYS.slice(STEP_KEYS.indexOf('grabbed'))) {
      entry.steps[k] = { status: 'pending' };
    }
    entry.steps.searching = { status: 'running', startedAt: at };
    this.changed(entry);
  }

  public searchCompleted(mediaId: number, is4k: boolean, at = this.now()) {
    const entry = this.entry(mediaId, is4k);
    if (entry) entry.searchCompletedAt = at;
  }

  public finished(entry: TrackedProgress): boolean {
    return (
      entry.steps.playable.status === 'done' ||
      STEP_KEYS.some((k) => entry.steps[k].status === 'failed')
    );
  }

  public snapshot(entry: TrackedProgress): RequestProgress {
    const estimates = entry.serverKey
      ? this.stats.get(entry.serverKey)
      : undefined;
    const steps = STEP_KEYS.map((k) => {
      const state = entry.steps[k];
      return {
        key: k,
        status: state.status,
        startedAt: iso(state.startedAt),
        finishedAt: iso(state.finishedAt),
        p90Ms: k === 'requested' ? undefined : estimates?.[k].p90,
        error: state.error,
      };
    });
    const p90s = steps.flatMap((s) => (s.p90Ms === undefined ? [] : s.p90Ms));
    return {
      mediaId: entry.mediaId,
      is4k: entry.is4k,
      requestId: entry.requestId,
      steps,
      totalP90Ms:
        (entry.serverKey ? this.stats.totalP90(entry.serverKey) : undefined) ??
        (p90s.length ? p90s.reduce((a, b) => a + b, 0) : undefined),
      playUrl: entry.playUrl,
    };
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
  }

  private cancelEviction(k: string): void {
    clearTimeout(this.evictions.get(k));
    this.evictions.delete(k);
  }
}

const progressTracker = new ProgressTracker();

export default progressTracker;
