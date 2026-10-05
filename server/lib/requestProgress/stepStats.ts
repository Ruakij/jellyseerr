import type ServarrBase from '@server/api/servarr/base';
import type { HistoryRecord } from '@server/api/servarr/base';

export const PROGRESS_STEPS = [
  'searching',
  'grabbed',
  'importing',
  'inJellyfin',
  'playable',
] as const;

export type ProgressStep = (typeof PROGRESS_STEPS)[number];

export const MAX_SAMPLES = 200;

export interface Sample {
  /** When the step finished, ms since epoch; orders the sample window. */
  at: number;
  durationMs: number;
  /** Lets a recorded sample replace the history sample of the same download. */
  downloadId?: string;
}

export interface StepEstimate {
  count: number;
  p50?: number;
  p90?: number;
}

/**
 * Nearest-rank percentile: the smallest value with at least p% of all values at or below it.
 * Always returns a measured duration, never an interpolated one.
 */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Grab -> import durations from history records in any order. Per downloadId, the first grab is
 * paired with the first import after it, so a season pack (one grab, one import per episode)
 * counts once with the time until its first episode was usable.
 */
export function pairGrabToImport(records: HistoryRecord[]): Sample[] {
  const byDownload = new Map<string, { grabs: number[]; imports: number[] }>();
  for (const record of records) {
    if (
      !record.downloadId ||
      (record.eventType !== 'grabbed' &&
        record.eventType !== 'downloadFolderImported')
    ) {
      continue;
    }
    const at = Date.parse(record.date);
    if (Number.isNaN(at)) continue;
    let entry = byDownload.get(record.downloadId);
    if (!entry) {
      entry = { grabs: [], imports: [] };
      byDownload.set(record.downloadId, entry);
    }
    (record.eventType === 'grabbed' ? entry.grabs : entry.imports).push(at);
  }

  const samples: Sample[] = [];
  for (const [downloadId, { grabs, imports }] of byDownload) {
    if (grabs.length === 0) continue;
    const grab = Math.min(...grabs);
    const imported = imports.filter((at) => at >= grab);
    if (imported.length === 0) continue;
    const at = Math.min(...imported);
    samples.push({ at, durationMs: at - grab, downloadId });
  }
  return newest(samples);
}

function newest(samples: Sample[]): Sample[] {
  return [...samples].sort((a, b) => b.at - a.at).slice(0, MAX_SAMPLES);
}

type HistorySource = Pick<ServarrBase<unknown>, 'getHistory'>;

interface ServerSamples {
  history: Sample[];
  recorded: Record<ProgressStep, Sample[]>;
}

/**
 * Duration samples per step and server. Grab -> import pairs from history count towards the
 * `importing` step, which runs from the grab until the file is imported.
 */
export class StepStats {
  private servers = new Map<string, ServerSamples>();

  private server(serverKey: string): ServerSamples {
    let entry = this.servers.get(serverKey);
    if (!entry) {
      entry = {
        history: [],
        recorded: Object.fromEntries(
          PROGRESS_STEPS.map((step) => [step, []])
        ) as unknown as Record<ProgressStep, Sample[]>,
      };
      this.servers.set(serverKey, entry);
    }
    return entry;
  }

  /** Replaces the history samples of a server; on failure the previous ones stay. */
  public async refresh(serverKey: string, api: HistorySource): Promise<void> {
    // Two filtered pages, as the paged endpoint of older Radarr/Sonarr takes one event type only.
    const [grabs, imports] = await Promise.all([
      api.getHistory({ eventType: 'grabbed', pageSize: MAX_SAMPLES }),
      api.getHistory({
        eventType: 'downloadFolderImported',
        pageSize: MAX_SAMPLES,
      }),
    ]);
    this.server(serverKey).history = pairGrabToImport([...grabs, ...imports]);
  }

  public record(
    serverKey: string,
    step: ProgressStep,
    durationMs: number,
    { at = Date.now(), downloadId }: { at?: number; downloadId?: string } = {}
  ): void {
    const recorded = this.server(serverKey).recorded;
    recorded[step] = newest([
      ...recorded[step],
      { at, durationMs, downloadId },
    ]);
  }

  public get(serverKey: string): Record<ProgressStep, StepEstimate> {
    const { history, recorded } = this.server(serverKey);
    return Object.fromEntries(
      PROGRESS_STEPS.map((step) => {
        const own = recorded[step];
        const tracked = new Set(own.map((s) => s.downloadId).filter(Boolean));
        const samples = newest(
          step === 'importing'
            ? [...history.filter((s) => !tracked.has(s.downloadId)), ...own]
            : own
        ).map((s) => s.durationMs);
        return [
          step,
          {
            count: samples.length,
            p50: percentile(samples, 50),
            p90: percentile(samples, 90),
          },
        ];
      })
    ) as Record<ProgressStep, StepEstimate>;
  }
}

const stepStats = new StepStats();

export default stepStats;
