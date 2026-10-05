import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import { getRepository } from '@server/datasource';
import { StepSample } from '@server/entity/StepSample';
import {
  MIN_TOTAL_SAMPLES,
  StepStats,
  pairGrabToImport,
  percentile,
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

  it('counts a season pack once, until its first import', () => {
    const samples = pairGrabToImport([
      rec('downloadFolderImported', '2026-10-05T10:00:12Z', 'pack'),
      rec('downloadFolderImported', '2026-10-05T10:00:10Z', 'pack'),
      rec('grabbed', '2026-10-05T10:00:00Z', 'pack'),
      rec('downloadFolderImported', '2026-10-05T10:00:11Z', 'pack'),
    ]);
    assert.deepEqual(samples, [
      {
        at: Date.parse('2026-10-05T10:00:10Z'),
        durationMs: 10_000,
        downloadId: 'pack',
      },
    ]);
  });
});

describe('StepStats', () => {
  it('merges history and recorded samples for importing, per server', async () => {
    const stats = new StepStats();
    await stats.refresh('radarr-0', sevenSecondGrab);
    stats.record('radarr-0', 'importing', 20_000);
    stats.record('radarr-0', 'inJellyfin', 60_000);

    const radarr = stats.get('radarr-0');
    assert.deepEqual(radarr.importing, { count: 2, p50: 7_000, p90: 20_000 });
    assert.deepEqual(radarr.inJellyfin, {
      count: 1,
      p50: 60_000,
      p90: 60_000,
    });
    assert.deepEqual(radarr.searching, {
      count: 0,
      p50: undefined,
      p90: undefined,
    });
    assert.equal(stats.get('sonarr-0').importing.count, 0);
  });

  it('keeps only the newest samples per step', () => {
    const { localMaxSamples } = getSettings().requestProgress;
    const stats = new StepStats();
    const now = Date.now();
    for (let i = 0; i < localMaxSamples + 50; i++) {
      stats.record('s', 'searching', i < 50 ? 1_000_000 : 1, { at: now + i });
    }
    assert.deepEqual(stats.get('s').searching, {
      count: localMaxSamples,
      p50: 1,
      p90: 1,
    });
  });

  it('skips a history sample whose download the tracker recorded', async () => {
    const stats = new StepStats();
    await stats.refresh('s', sevenSecondGrab);
    stats.record('s', 'importing', 9_000, { downloadId: 'A' });
    assert.deepEqual(stats.get('s').importing, {
      count: 1,
      p50: 9_000,
      p90: 9_000,
    });
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
    assert.equal(stats.get('s').importing.count, 1);
  });

  it('estimates the total from end-to-end samples once there are enough', () => {
    const stats = new StepStats();
    for (let i = 1; i < MIN_TOTAL_SAMPLES; i++)
      stats.recordTotal('s', i * 1_000);
    assert.equal(stats.totalP90('s'), undefined);
    stats.recordTotal('s', MIN_TOTAL_SAMPLES * 1_000);
    assert.equal(stats.totalP90('s'), 18_000);
    assert.equal(stats.totalP90('other'), undefined);
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
    assert.deepEqual(stats.get('s').inJellyfin, {
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

    assert.equal(stats.get('s').searching.count, 1);
    assert.deepEqual(
      (await getRepository(StepSample).find()).map((r) => r.durationMs),
      [2]
    );
  });
});
