import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import {
  MIN_TOTAL_SAMPLES,
  StepStats,
} from '@server/lib/requestProgress/stepStats';
import { ProgressTracker } from '@server/lib/requestProgress/tracker';
import { getSettings } from '@server/lib/settings';

function setup() {
  let now = Date.now();
  const stats = new StepStats();
  const tracker = new ProgressTracker(stats, () => now);
  const changes: RequestProgress[] = [];
  tracker.on('change', (p) => changes.push(p));
  return {
    stats,
    tracker,
    changes,
    tick: (ms: number) => (now += ms),
    statuses: () =>
      Object.fromEntries(
        tracker.get(1, false)!.steps.map((s) => [s.key, s.status])
      ),
  };
}

describe('ProgressTracker', () => {
  it('starts with requested done and searching running', () => {
    const { tracker, changes, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false, requestId: 7 });
    assert.deepEqual(statuses(), {
      requested: 'done',
      searching: 'running',
      grabbed: 'pending',
      importing: 'pending',
      inJellyfin: 'pending',
      playable: 'pending',
    });
    assert.equal(changes.length, 1);
    assert.equal(changes[0].requestId, 7);
  });

  it('walks through all steps and records their durations', () => {
    const { tracker, stats, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
    tick(5_000);
    tracker.advance(1, false, 'grabbed', undefined, { downloadId: 'D' });
    assert.equal(statuses().importing, 'running');
    tick(7_000);
    tracker.advance(1, false, 'importing');
    tick(10_000);
    tracker.advance(1, false, 'inJellyfin');
    tick(2_000);
    tracker.advance(1, false, 'playable', undefined, { playUrl: 'http://jf' });

    const progress = tracker.get(1, false)!;
    assert.ok(progress.steps.every((s) => s.status === 'done'));
    assert.equal(progress.playUrl, 'http://jf');
    const estimates = stats.get('radarr-0');
    assert.equal(estimates.searching.percentiles[90]?.valueMs, 5_000);
    assert.equal(estimates.grabbed.percentiles[90]?.valueMs, 0);
    assert.equal(estimates.importing.percentiles[90]?.valueMs, 7_000);
    assert.equal(estimates.inJellyfin.percentiles[90]?.valueMs, 10_000);
    assert.equal(estimates.playable.percentiles[90]?.valueMs, 2_000);
    assert.equal(progress.totalEstimateMs, 24_000);
    assert.equal(progress.estimatePercentile, 90);
    const importing = progress.steps.find((s) => s.key === 'importing')!;
    assert.equal(importing.estimateMs, 7_000);
    assert.equal(importing.estimateRangeMs, undefined);
  });

  it('closes skipped steps when a later one is reached', () => {
    const { tracker, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false });
    tick(3_000);
    tracker.advance(1, false, 'importing');
    assert.deepEqual(statuses(), {
      requested: 'done',
      searching: 'done',
      grabbed: 'done',
      importing: 'done',
      inJellyfin: 'running',
      playable: 'pending',
    });
  });

  it('fails the current step with a reason and recovers on a later advance', () => {
    const { tracker, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false });
    tracker.advance(1, false, 'grabbed');
    tracker.fail(1, false, 'Manual interaction required');
    const failed = tracker
      .get(1, false)!
      .steps.find((s) => s.key === 'importing')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Manual interaction required');
    assert.equal(tracker.active().length, 0);

    tracker.advance(1, false, 'importing');
    assert.equal(statuses().importing, 'done');
    assert.equal(tracker.active().length, 1);
  });

  it('ignores events for untracked media and keeps 4k separate', () => {
    const { tracker, changes } = setup();
    tracker.advance(1, false, 'grabbed');
    tracker.fail(1, false, 'x');
    assert.equal(changes.length, 0);
    tracker.start({ mediaId: 1, is4k: true });
    assert.equal(tracker.get(1, false), undefined);
    assert.ok(tracker.get(1, true));
  });

  it('ensure keeps an existing run and fills in its server', () => {
    const { tracker } = setup();
    const first = tracker.start({ mediaId: 1, is4k: false });
    tracker.advance(1, false, 'grabbed');
    const again = tracker.ensure({
      mediaId: 1,
      is4k: false,
      serverKey: 'radarr-1',
    });
    assert.equal(again, first);
    assert.equal(again.serverKey, 'radarr-1');
    assert.equal(again.steps.grabbed.status, 'done');
  });

  it('estimates the total from finished runs once there are enough', () => {
    const { tracker, stats, tick } = setup();
    // Every run takes 51s, but alternates which step is slow, so the step p90s add up to 100s.
    for (let i = 0; i < MIN_TOTAL_SAMPLES; i++) {
      tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
      tick(i % 2 ? 1_000 : 50_000);
      tracker.advance(1, false, 'importing');
      tick(i % 2 ? 50_000 : 1_000);
      tracker.advance(1, false, 'playable');
      if (i === MIN_TOTAL_SAMPLES - 2) {
        assert.equal(tracker.get(1, false)!.totalEstimateMs, 100_000);
      }
    }
    assert.equal(stats.total('radarr-0').percentiles[90]?.valueMs, 51_000);
    assert.equal(tracker.get(1, false)!.totalEstimateMs, 51_000);
  });

  it('estimates at the configured percentile, with its interval when enabled', () => {
    const { tracker, stats } = setup();
    const settings = getSettings().requestProgress;
    const defaults = { ...settings };
    try {
      for (let i = 1; i <= 20; i++) {
        stats.record('radarr-0', 'searching', i * 1_000);
        stats.recordTotal('radarr-0', i * 10_000);
      }
      Object.assign(settings, {
        estimatePercentile: 50,
        showConfidenceInterval: true,
      });
      tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
      const progress = tracker.get(1, false)!;
      const searching = progress.steps.find((s) => s.key === 'searching')!;
      assert.equal(progress.estimatePercentile, 50);
      assert.equal(searching.estimateMs, 10_000);
      assert.deepEqual(searching.estimateRangeMs, [6_000, 15_000]);
      assert.equal(progress.totalEstimateMs, 100_000);
      assert.deepEqual(progress.totalEstimateRangeMs, [60_000, 150_000]);

      settings.estimatePercentile = 90;
      const p90 = tracker.get(1, false)!;
      assert.equal(p90.totalEstimateMs, 180_000);
      assert.equal(p90.totalEstimateRangeMs, undefined);
    } finally {
      Object.assign(settings, defaults);
    }
  });
});
