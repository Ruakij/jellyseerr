import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import { getRepository } from '@server/datasource';
import { StepSample } from '@server/entity/StepSample';
import type { StepEstimate } from '@server/lib/requestProgress/stepStats';
import {
  MIN_STEP_SAMPLES,
  StepStats,
  pairGrabToImport,
  pairRequestToGrab,
  percentile,
  quantileCiRanks,
  sumDistribution,
  windowed,
} from '@server/lib/requestProgress/stepStats';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

const DAY = 24 * 60 * 60 * 1000;

let nextId = 1;
function rec(
  eventType: HistoryRecord['eventType'],
  date: string,
  downloadId?: string
): HistoryRecord {
  return {
    id: nextId++,
    date,
    eventType,
    downloadId,
    sourceTitle: 'Some.Movie.2024.1080p',
    movieId: 1,
    data: {},
  };
}

const sevenSecondGrab: Parameters<StepStats['refresh']>[1] = {
  getHistory: async ({ eventType } = {}) =>
    eventType === 'grabbed'
      ? [rec('grabbed', '2026-10-05T10:00:00Z', 'A')]
      : [rec('downloadFolderImported', '2026-10-05T10:00:07Z', 'A')],
};

const summary = (e: StepEstimate) => ({
  count: e.historyCount + e.localCount,
  p50: e.percentiles[50]?.valueMs,
  p90: e.percentiles[90]?.valueMs,
});

describe('percentile', () => {
  it('returns undefined for no values', () => {
    assert.equal(percentile([], 90), undefined);
  });

  it('uses the nearest rank', () => {
    const values = [15, 20, 35, 40, 50];
    assert.equal(percentile(values, 0), 15);
    assert.equal(percentile(values, 30), 20);
    assert.equal(percentile(values, 40), 20);
    assert.equal(percentile(values, 50), 35);
    assert.equal(percentile(values, 100), 50);
  });

  it('sorts unsorted input without mutating it', () => {
    const values = Array.from({ length: 10 }, (_, i) => 10 - i);
    assert.equal(percentile(values, 90), 9);
    assert.equal(percentile(values, 50), 5);
    assert.equal(values[0], 10);
  });

  it('returns the single value for one sample', () => {
    assert.equal(percentile([7], 50), 7);
    assert.equal(percentile([7], 90), 7);
  });
});

describe('sumDistribution', () => {
  it('holds every combination of the samples, sorted', () => {
    assert.deepEqual(
      sumDistribution([
        [2, 1],
        [20, 10],
      ]),
      [11, 12, 21, 22]
    );
    assert.deepEqual(
      sumDistribution([
        [3, 1, 2],
        [10, 20],
        [100, 200],
      ]),
      [111, 112, 113, 121, 122, 123, 211, 212, 213, 221, 222, 223]
    );
  });

  it('is the samples themselves for one step and zero for none', () => {
    assert.deepEqual(sumDistribution([[3, 1, 2]]), [1, 2, 3]);
    assert.deepEqual(sumDistribution([]), [0]);
  });

  it('reduces to 200 points that keep the largest and the percentiles', () => {
    const a = Array.from({ length: 20 }, (_, i) => (i + 1) * 1_000);
    const b = Array.from({ length: 20 }, (_, i) => (i + 1) ** 2 * 1_000);
    const all = a.flatMap((x) => b.map((y) => x + y));
    const sum = sumDistribution([a, b]);
    assert.equal(sum.length, 200);
    assert.equal(sum[199], Math.max(...all));
    for (const p of [50, 90, 95, 99]) {
      assert.equal(percentile(sum, p), percentile(all, p));
    }
  });
});

describe('pairGrabToImport', () => {
  it('pairs records by downloadId regardless of order', () => {
    const samples = pairGrabToImport([
      rec('downloadFolderImported', '2026-10-05T10:01:00Z', 'B'),
      rec('downloadFolderImported', '2026-10-05T10:00:07Z', 'A'),
      rec('grabbed', '2026-10-05T10:00:30Z', 'B'),
      rec('grabbed', '2026-10-05T10:00:00Z', 'A'),
    ]);
    assert.deepEqual(samples, [
      {
        at: Date.parse('2026-10-05T10:01:00Z'),
        durationMs: 30_000,
        downloadId: 'B',
      },
      {
        at: Date.parse('2026-10-05T10:00:07Z'),
        durationMs: 7_000,
        downloadId: 'A',
      },
    ]);
  });

  it('skips unmatched records, records without downloadId and other events', () => {
    const samples = pairGrabToImport([
      rec('grabbed', '2026-10-05T10:00:00Z', 'only-grab'),
      rec('downloadFolderImported', '2026-10-05T10:00:05Z', 'only-import'),
      rec('downloadFolderImported', '2026-10-05T10:00:05Z'),
      rec('grabbed', '2026-10-05T10:00:00Z', 'failed'),
      rec('downloadFailed', '2026-10-05T10:00:09Z', 'failed'),
    ]);
    assert.deepEqual(samples, []);
  });

  it('ignores an import dated before the grab', () => {
    const samples = pairGrabToImport([
      rec('downloadFolderImported', '2026-10-05T09:59:00Z', 'A'),
      rec('grabbed', '2026-10-05T10:00:00Z', 'A'),
    ]);
    assert.deepEqual(samples, []);
  });

  it('counts a season pack once, until its last import', () => {
    const samples = pairGrabToImport([
      rec('downloadFolderImported', '2026-10-05T10:00:12Z', 'pack'),
      rec('downloadFolderImported', '2026-10-05T10:00:10Z', 'pack'),
      rec('grabbed', '2026-10-05T10:00:00Z', 'pack'),
      rec('downloadFolderImported', '2026-10-05T10:00:11Z', 'pack'),
    ]);
    assert.deepEqual(samples, [
      {
        at: Date.parse('2026-10-05T10:00:12Z'),
        durationMs: 12_000,
        downloadId: 'pack',
      },
    ]);
  });
});

describe('pairRequestToGrab', () => {
  const grab = (
    date: string,
    downloadId: string,
    item: Partial<HistoryRecord>
  ): HistoryRecord => ({
    ...rec('grabbed', date, downloadId),
    movieId: undefined,
    ...item,
  });

  it('pairs a request with the first grab of its item after it', () => {
    const samples = pairRequestToGrab(
      [{ at: Date.parse('2026-10-05T10:00:00Z'), arrId: 1 }],
      [
        grab('2026-10-05T10:05:00Z', 'later', { movieId: 1 }),
        grab('2026-10-05T09:00:00Z', 'before', { movieId: 1 }),
        grab('2026-10-05T10:01:00Z', 'other', { movieId: 2 }),
        grab('2026-10-05T10:02:00Z', 'first', { movieId: 1 }),
        rec('downloadFolderImported', '2026-10-05T10:01:30Z', 'import'),
      ]
    );
    assert.deepEqual(samples, [
      {
        at: Date.parse('2026-10-05T10:02:00Z'),
        durationMs: 120_000,
        downloadId: 'first',
      },
    ]);
  });

  it('matches series grabs of the requested seasons only', () => {
    const samples = pairRequestToGrab(
      [{ at: Date.parse('2026-10-05T10:00:00Z'), arrId: 7, seasons: [2] }],
      [
        grab('2026-10-05T10:01:00Z', 's1', {
          seriesId: 7,
          episode: { seasonNumber: 1, episodeNumber: 1 },
        }),
        grab('2026-10-05T10:03:00Z', 's2', {
          seriesId: 7,
          episode: { seasonNumber: 2, episodeNumber: 1 },
        }),
      ]
    );
    assert.deepEqual(
      samples.map((s) => s.downloadId),
      ['s2']
    );
  });

  it('skips a first grab from RSS or long after the request', () => {
    const samples = pairRequestToGrab(
      [
        { at: Date.parse('2026-10-05T10:00:00Z'), arrId: 1 },
        { at: Date.parse('2026-10-05T10:00:00Z'), arrId: 2 },
      ],
      [
        grab('2026-10-05T10:01:00Z', 'rss', {
          movieId: 1,
          data: { releaseSource: 'Rss' },
        }),
        grab('2026-10-05T10:05:00Z', 'search', { movieId: 1 }),
        grab('2026-10-05T11:00:00Z', 'late', { movieId: 2 }),
      ]
    );
    assert.deepEqual(samples, []);
  });

  it('counts a grab two requests reach once, for the later request', () => {
    const samples = pairRequestToGrab(
      [
        { at: Date.parse('2026-10-05T10:00:00Z'), arrId: 1 },
        { at: Date.parse('2026-10-05T10:04:00Z'), arrId: 1 },
      ],
      [grab('2026-10-05T10:05:00Z', 'A', { movieId: 1 })]
    );
    assert.deepEqual(
      samples.map((s) => s.durationMs),
      [60_000]
    );
  });
});

describe('StepStats', () => {
  // The history records are fixed dates, which an age limit would drop some day.
  const settings = getSettings().requestProgress;
  const { historyMaxAgeDays } = settings;
  before(() => (settings.historyMaxAgeDays = 0));
  after(() => (settings.historyMaxAgeDays = historyMaxAgeDays));

  it('merges history and recorded samples for grabbed, per server', async () => {
    const stats = new StepStats();
    await stats.refresh('radarr-0', sevenSecondGrab);
    stats.record('radarr-0', 'grabbed', 20_000);
    stats.record('radarr-0', 'inJellyfin', 60_000);

    const radarr = stats.get('radarr-0');
    assert.deepEqual(summary(radarr.grabbed), {
      count: 2,
      p50: 7_000,
      p90: 20_000,
    });
    assert.deepEqual(summary(radarr.inJellyfin), {
      count: 1,
      p50: 60_000,
      p90: 60_000,
    });
    assert.deepEqual(summary(radarr.searching), {
      count: 0,
      p50: undefined,
      p90: undefined,
    });
    assert.equal(summary(stats.get('sonarr-0').grabbed).count, 0);
  });

  it('keeps only the newest samples per step', () => {
    const { localMaxSamples } = getSettings().requestProgress;
    const stats = new StepStats();
    const now = Date.now();
    for (let i = 0; i < localMaxSamples + 50; i++) {
      stats.record('s', 'searching', i < 50 ? 1_000_000 : 1, { at: now + i });
    }
    assert.deepEqual(summary(stats.get('s').searching), {
      count: localMaxSamples,
      p50: 1,
      p90: 1,
    });
  });

  it('skips a history sample whose download the tracker recorded', async () => {
    const stats = new StepStats();
    await stats.refresh('s', sevenSecondGrab);
    stats.record('s', 'grabbed', 9_000, { downloadId: 'A' });
    assert.deepEqual(summary(stats.get('s').grabbed), {
      count: 1,
      p50: 9_000,
      p90: 9_000,
    });
  });

  it('seeds searching from requests and their grabs, unless tracked', async () => {
    const stats = new StepStats();
    let since: Date | undefined;
    await stats.refresh('s', sevenSecondGrab, async (from) => {
      since = from;
      return [{ at: Date.parse('2026-10-05T09:59:00Z'), arrId: 1 }];
    });
    assert.deepEqual(since, new Date('2026-10-05T10:00:00Z'));
    assert.deepEqual(summary(stats.get('s').searching), {
      count: 1,
      p50: 60_000,
      p90: 60_000,
    });
    stats.record('s', 'searching', 5_000, { downloadId: 'A' });
    assert.equal(summary(stats.get('s').searching).count, 1);
  });

  it('keeps the previous history when a refresh fails', async () => {
    const stats = new StepStats();
    await stats.refresh('s', sevenSecondGrab);
    await assert.rejects(
      stats.refresh('s', {
        getHistory: async () => {
          throw new Error('down');
        },
      })
    );
    assert.equal(summary(stats.get('s').grabbed).count, 1);
  });

  it('counts history and local samples apart', async () => {
    const stats = new StepStats();
    await stats.refresh('s', sevenSecondGrab);
    stats.record('s', 'grabbed', 20_000);
    const { historyCount, localCount } = stats.get('s').grabbed;
    assert.deepEqual([historyCount, localCount], [1, 1]);
  });

  it('estimates the sum of the step durations from the steps with enough samples', () => {
    const stats = new StepStats();
    const sums = () =>
      Object.fromEntries(
        Object.entries(stats.stepSum('s')).map(([p, stat]) => [p, stat.valueMs])
      );
    assert.deepEqual(stats.stepSum('s'), {});
    for (let i = 1; i <= MIN_STEP_SAMPLES; i++) {
      stats.record('s', 'searching', i * 1_000);
      stats.record('s', 'grabbed', i * 10_000);
    }
    // Too few samples: left out.
    for (let i = 1; i < MIN_STEP_SAMPLES; i++) {
      stats.record('s', 'importing', 1_000_000);
    }
    // 25 sums of 1..5s and 10..50s; the p90 steps alone add up to 55s.
    assert.deepEqual(sums(), {
      50: 33_000,
      90: 53_000,
      95: 54_000,
      99: 55_000,
    });
    assert.equal(stats.stepSum('s')[90]?.rangeMs, undefined);

    stats.record('s', 'searching', 100_000);
    assert.deepEqual(sums(), {
      50: 35_000,
      90: 120_000,
      95: 140_000,
      99: 150_000,
    });
    assert.deepEqual(stats.stepSum('other'), {});
  });

  it('estimates the end-to-end durations with confidence intervals', () => {
    const stats = new StepStats();
    for (let i = 1; i <= 20; i++) stats.recordTotal('s', i * 1_000);
    assert.deepEqual(stats.total('s'), {
      historyCount: 0,
      localCount: 20,
      percentiles: {
        50: { valueMs: 10_000, rangeMs: [6_000, 15_000] },
        90: { valueMs: 18_000, rangeMs: undefined },
        95: { valueMs: 19_000, rangeMs: undefined },
        99: { valueMs: 20_000, rangeMs: undefined },
      },
    });
    assert.deepEqual(stats.total('other').percentiles, {});
  });
});

describe('quantileCiRanks', () => {
  it('finds the order statistics of a 95% interval', () => {
    assert.deepEqual(quantileCiRanks(10, 0.5), [2, 9]);
    assert.deepEqual(quantileCiRanks(6, 0.5), [1, 6]);
    assert.deepEqual(quantileCiRanks(100, 0.5), [41, 61]);
    assert.deepEqual(quantileCiRanks(100, 0.9), [84, 96]);
  });

  it('has no interval with too few samples', () => {
    assert.equal(quantileCiRanks(5, 0.5), undefined);
    assert.equal(quantileCiRanks(28, 0.9), undefined);
    assert.deepEqual(quantileCiRanks(29, 0.9), [21, 29]);
    assert.equal(quantileCiRanks(0, 0.5), undefined);
  });

  it('covers the quantile with at least 95%', () => {
    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      for (let n = 1; n <= 400; n++) {
        const ranks = quantileCiRanks(n, q);
        if (!ranks) continue;
        const [l, u] = ranks;
        // Exact binomial sum, independent of the implementation.
        let coverage = 0;
        let binom = 1;
        for (let k = 0; k < u; k++) {
          if (k >= l) coverage += binom * q ** k * (1 - q) ** (n - k);
          binom = (binom * (n - k)) / (k + 1);
        }
        assert.ok(coverage >= 0.95, `n=${n} q=${q} [${l}, ${u}]`);
      }
    }
  });
});

describe('windowed', () => {
  const samples = [1, 2, 3, 4].map((day) => ({
    at: day * DAY,
    durationMs: day,
  }));

  it('keeps the newest samples within age and count', () => {
    assert.deepEqual(
      windowed(samples, { maxAgeDays: 2, maxSamples: 0 }, 4 * DAY).map(
        (s) => s.durationMs
      ),
      [4, 3, 2]
    );
    assert.deepEqual(
      windowed(samples, { maxAgeDays: 0, maxSamples: 2 }, 4 * DAY).map(
        (s) => s.durationMs
      ),
      [4, 3]
    );
    assert.equal(windowed(samples, { maxAgeDays: 0, maxSamples: 0 }).length, 4);
  });
});

describe('StepStats persistence', () => {
  setupTestDb();

  const settings = getSettings().requestProgress;
  const defaults = { ...settings };
  afterEach(() => Object.assign(settings, defaults));

  it('loads recorded samples into a new instance', async () => {
    await new StepStats(true).record('s', 'inJellyfin', 5_000, {
      downloadId: 'A',
    });
    await new StepStats(true).recordTotal('s', 60_000);

    const stats = new StepStats(true);
    await stats.load();
    assert.deepEqual(summary(stats.get('s').inJellyfin), {
      count: 1,
      p50: 5_000,
      p90: 5_000,
    });
    assert.equal(
      (await getRepository(StepSample).findOneByOrFail({ step: 'total' }))
        .durationMs,
      60_000
    );
  });

  it('persists the unit and download counts of a sample, null without', async () => {
    const stats = new StepStats(true);
    await stats.record('s', 'grabbed', 5_000, {
      unitCount: 3,
      downloadCount: 2,
    });
    await stats.recordTotal('s', 60_000, Date.now(), {
      unitCount: 3,
      downloadCount: 2,
    });
    await stats.record('s', 'importing', 1_000);

    const rows = await getRepository(StepSample).find({ order: { id: 'ASC' } });
    assert.deepEqual(
      rows.map((r) => [r.step, r.unitCount, r.downloadCount]),
      [
        ['grabbed', 3, 2],
        ['total', 3, 2],
        ['importing', null, null],
      ]
    );
  });

  it('prunes persisted samples beyond the newest per step', async () => {
    settings.localMaxSamples = 2;
    const stats = new StepStats(true);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await stats.record('s', 'searching', i, { at: now - i * 1000 });
    }
    await stats.record('s', 'importing', 9, { at: now - 9000 });

    const rows = await getRepository(StepSample).find({
      order: { durationMs: 'ASC' },
    });
    assert.deepEqual(
      rows.map((r) => [r.step, r.durationMs]),
      [
        ['searching', 0],
        ['searching', 1],
        ['importing', 9],
      ]
    );
  });

  it('prunes persisted samples older than the maximum age on load', async () => {
    const now = Date.now();
    const stats = new StepStats(true);
    await stats.record('s', 'searching', 1, { at: now - 5 * DAY });
    await stats.record('s', 'searching', 2, { at: now - DAY });
    settings.localMaxAgeDays = 3;
    await stats.load();

    assert.equal(summary(stats.get('s').searching).count, 1);
    assert.deepEqual(
      (await getRepository(StepSample).find()).map((r) => r.durationMs),
      [2]
    );
  });
});
