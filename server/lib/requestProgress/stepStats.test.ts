import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import {
  MAX_SAMPLES,
  StepStats,
  pairGrabToImport,
  percentile,
} from '@server/lib/requestProgress/stepStats';

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
      { at: Date.parse('2026-10-05T10:01:00Z'), durationMs: 30_000 },
      { at: Date.parse('2026-10-05T10:00:07Z'), durationMs: 7_000 },
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
      { at: Date.parse('2026-10-05T10:00:10Z'), durationMs: 10_000 },
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
    const stats = new StepStats();
    for (let i = 0; i < MAX_SAMPLES + 50; i++) {
      stats.record('s', 'searching', i < 50 ? 1_000_000 : 1, i);
    }
    assert.deepEqual(stats.get('s').searching, {
      count: MAX_SAMPLES,
      p50: 1,
      p90: 1,
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
});
