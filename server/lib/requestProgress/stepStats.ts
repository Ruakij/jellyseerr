import type ServarrBase from '@server/api/servarr/base';
import type { HistoryRecord } from '@server/api/servarr/base';
import { getRepository } from '@server/datasource';
import { StepSample } from '@server/entity/StepSample';
import {
  PROGRESS_STEPS,
  type ProgressStep,
} from '@server/lib/requestProgress/steps';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { In, LessThan } from 'typeorm';

export { PROGRESS_STEPS, type ProgressStep };

const DAY_MS = 24 * 60 * 60 * 1000;

// ponytail: history without age and count limit reads this many records, paging if more matter.
const UNLIMITED_HISTORY = 1000;

export interface SampleWindow {
  /** 0 means no limit, as for maxSamples. */
  maxAgeDays: number;
  maxSamples: number;
}

const TOTAL = 'total';

/** Below this many end-to-end samples, the total estimate is the sum of the step p90s. */
export const MIN_TOTAL_SAMPLES = 20;

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
  return samples.sort((a, b) => b.at - a.at);
}

/** The newest samples within the window. */
export function windowed(
  samples: Sample[],
  { maxAgeDays, maxSamples }: SampleWindow,
  now = Date.now()
): Sample[] {
  const oldest = maxAgeDays > 0 ? now - maxAgeDays * DAY_MS : -Infinity;
  const newest = samples
    .filter((s) => s.at >= oldest)
    .sort((a, b) => b.at - a.at);
  return maxSamples > 0 ? newest.slice(0, maxSamples) : newest;
}

const historyWindow = (): SampleWindow => {
  const s = getSettings().requestProgress;
  return { maxAgeDays: s.historyMaxAgeDays, maxSamples: s.historyMaxSamples };
};

const localWindow = (): SampleWindow => {
  const s = getSettings().requestProgress;
  return { maxAgeDays: s.localMaxAgeDays, maxSamples: s.localMaxSamples };
};

type HistorySource = Pick<ServarrBase<unknown>, 'getHistory'>;

interface ServerSamples {
  history: Sample[];
  recorded: Record<ProgressStep, Sample[]>;
  /** Requested -> playable durations of tracked runs. */
  totals: Sample[];
}

/**
 * Duration samples per step and server. Grab -> import pairs from history count towards the
 * `importing` step, which runs from the grab until the file is imported. Recorded samples are
 * kept in the database when `persist` is set, so estimates survive restarts.
 */
export class StepStats {
  private servers = new Map<string, ServerSamples>();

  constructor(private readonly persist = false) {}

  private server(serverKey: string): ServerSamples {
    let entry = this.servers.get(serverKey);
    if (!entry) {
      entry = {
        history: [],
        recorded: Object.fromEntries(
          PROGRESS_STEPS.map((step) => [step, []])
        ) as unknown as Record<ProgressStep, Sample[]>,
        totals: [],
      };
      this.servers.set(serverKey, entry);
    }
    return entry;
  }

  /** Replaces the history samples of a server; on failure the previous ones stay. */
  public async refresh(serverKey: string, api: HistorySource): Promise<void> {
    const window = historyWindow();
    const range =
      window.maxAgeDays > 0
        ? { since: new Date(Date.now() - window.maxAgeDays * DAY_MS) }
        : { pageSize: window.maxSamples || UNLIMITED_HISTORY };
    // Two filtered requests, as the paged endpoint of older Radarr/Sonarr takes one event type only.
    const [grabs, imports] = await Promise.all([
      api.getHistory({ eventType: 'grabbed', ...range }),
      api.getHistory({ eventType: 'downloadFolderImported', ...range }),
    ]);
    this.server(serverKey).history = windowed(
      pairGrabToImport([...grabs, ...imports]),
      window
    );
  }

  /** Replaces the recorded samples with the persisted ones, pruned to the current window. */
  public async load(): Promise<void> {
    const repo = getRepository(StepSample);
    await this.prune();
    const rows = await repo.find();
    for (const server of this.servers.values()) {
      server.totals = [];
      for (const step of PROGRESS_STEPS) server.recorded[step] = [];
    }
    for (const row of rows) {
      const server = this.server(row.serverKey);
      const sample = {
        at: row.finishedAt.getTime(),
        durationMs: row.durationMs,
        downloadId: row.downloadId ?? undefined,
      };
      if (row.step === TOTAL) server.totals.push(sample);
      else if (row.step in server.recorded) {
        server.recorded[row.step as ProgressStep].push(sample);
      }
    }
    const window = localWindow();
    for (const server of this.servers.values()) {
      server.totals = windowed(server.totals, window);
      for (const step of PROGRESS_STEPS) {
        server.recorded[step] = windowed(server.recorded[step], window);
      }
    }
  }

  /** Deletes persisted samples outside the window, for one series or all of them. */
  private async prune(only?: { serverKey: string; step: string }) {
    const repo = getRepository(StepSample);
    const { maxAgeDays, maxSamples } = localWindow();
    if (maxAgeDays > 0) {
      await repo.delete({
        ...only,
        finishedAt: LessThan(new Date(Date.now() - maxAgeDays * DAY_MS)),
      });
    }
    if (maxSamples === 0) return;
    const series = only
      ? [only]
      : await repo
          .createQueryBuilder('s')
          .select(['s.serverKey AS "serverKey"', 's.step AS "step"'])
          .groupBy('s.serverKey')
          .addGroupBy('s.step')
          .having('COUNT(*) > :maxSamples', { maxSamples })
          .getRawMany<{ serverKey: string; step: string }>();
    for (const where of series) {
      const excess = await repo.find({
        select: { id: true },
        where,
        order: { finishedAt: 'DESC', id: 'DESC' },
        skip: maxSamples,
        take: 10_000,
      });
      if (excess.length > 0) {
        await repo.delete({ id: In(excess.map((s) => s.id)) });
      }
    }
  }

  /** Never rejects; callers need not wait for it. */
  private async save(
    serverKey: string,
    step: string,
    sample: Sample
  ): Promise<void> {
    if (!this.persist) return;
    await getRepository(StepSample)
      .save(
        new StepSample({
          serverKey,
          step,
          durationMs: sample.durationMs,
          finishedAt: new Date(sample.at),
          downloadId: sample.downloadId ?? null,
        })
      )
      .then(() => this.prune({ serverKey, step }))
      .catch((e: Error) =>
        logger.warn(`Saving a step sample failed: ${e.message}`, {
          label: 'Request Progress',
          server: serverKey,
        })
      );
  }

  public record(
    serverKey: string,
    step: ProgressStep,
    durationMs: number,
    { at = Date.now(), downloadId }: { at?: number; downloadId?: string } = {}
  ): Promise<void> {
    const recorded = this.server(serverKey).recorded;
    const sample = { at, durationMs, downloadId };
    recorded[step] = windowed([...recorded[step], sample], localWindow());
    return this.save(serverKey, step, sample);
  }

  public recordTotal(
    serverKey: string,
    durationMs: number,
    at = Date.now()
  ): Promise<void> {
    const server = this.server(serverKey);
    const sample = { at, durationMs };
    server.totals = windowed([...server.totals, sample], localWindow());
    return this.save(serverKey, TOTAL, sample);
  }

  /** p90 of the end-to-end durations; undefined until there are enough of them. */
  public totalP90(serverKey: string): number | undefined {
    const totals = this.server(serverKey).totals;
    return totals.length >= MIN_TOTAL_SAMPLES
      ? percentile(
          totals.map((s) => s.durationMs),
          90
        )
      : undefined;
  }

  public get(serverKey: string): Record<ProgressStep, StepEstimate> {
    const { history, recorded } = this.server(serverKey);
    return Object.fromEntries(
      PROGRESS_STEPS.map((step) => {
        const own = recorded[step];
        const tracked = new Set(own.map((s) => s.downloadId).filter(Boolean));
        const samples = (
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

const stepStats = new StepStats(true);

export default stepStats;
