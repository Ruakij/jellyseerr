import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import type { RequestProgress } from '@server/interfaces/api/progressInterfaces';
import {
  MIN_STEP_SAMPLES,
  MIN_TOTAL_SAMPLES,
  StepStats,
} from '@server/lib/requestProgress/stepStats';
import {
  ProgressTracker,
  RETRY_SEARCH_MS,
  WAITING_FOR_RELEASE,
  WAITING_FOR_RSS,
} from '@server/lib/requestProgress/tracker';
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
    assert.deepEqual(
      changes[0].requests.map((r) => r.id),
      [7]
    );
  });

  describe('several requests of one series', () => {
    const episodes = (season: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: season * 100 + i + 1,
        seasonNumber: season,
        episodeNumber: i + 1,
        hasFile: false,
      }));

    function twoSeasons() {
      const ctx = setup();
      const { tracker, tick } = ctx;
      const s1At = ctx.tick(0);
      tracker.start({
        mediaId: 1,
        is4k: false,
        requestId: 1,
        seasons: [1],
        requestedBy: 'alice',
      });
      tracker.setUnits(1, false, episodes(1, 2));
      tracker.searchFinished(1, false, { commandId: 1 });
      tick(13 * 3600_000);
      const s2At = tick(0);
      tracker.start({
        mediaId: 1,
        is4k: false,
        requestId: 2,
        seasons: [2],
        requestedBy: 'bob',
      });
      tracker.grab(1, false, { downloadId: 'D1', unitIds: [101] });
      return { ...ctx, s1At, s2At };
    }

    it('adds the second request to the run of the first', () => {
      const { tracker, s2At } = twoSeasons();
      const progress = tracker.get(1, false)!;
      assert.deepEqual(
        progress.requests.map((r) => [r.id, r.seasons, r.requestedBy, r.step]),
        [
          [1, [1], 'alice', 'searching'],
          [2, [2], 'bob', 'searching'],
        ]
      );
      // Season 2 has no aired episode yet; it waits from its own request on.
      const s2 = progress.requests[1];
      assert.equal(s2.waiting, undefined);
      assert.equal(progress.steps[2].counts?.total, 2);
      tracker.searchFinished(1, false, { commandId: 2 });
      const after = tracker.get(1, false)!.requests[1];
      assert.equal(after.waiting, 'release');
      assert.ok(Date.parse(after.waitingSince!) >= s2At);
      assert.deepEqual(
        tracker
          .get(1, false)!
          .timeline!.filter((e) => e.kind === 'requested')
          .map((e) => [e.detail, e.seasons]),
        [
          ['alice', [1]],
          ['bob', [2]],
        ]
      );
    });

    it('drops the units, events and times of a removed request', () => {
      const { tracker, changes, s2At } = twoSeasons();
      tracker.setUnits(1, false, [...episodes(1, 2), ...episodes(2, 3)]);
      tracker.searchFinished(1, false, { commandId: 2 });
      tracker.setRequests(1, false, [
        { id: 2, seasons: [2], requestedBy: 'bob', at: s2At },
      ]);

      const progress = changes.at(-1)!;
      assert.deepEqual(
        progress.requests.map((r) => r.id),
        [2]
      );
      assert.equal(progress.steps[1].counts?.total, 3);
      assert.equal(progress.steps[2].status, 'pending');
      for (const step of progress.steps) {
        if (step.startedAt) assert.ok(Date.parse(step.startedAt) >= s2At);
      }
      const searching = progress.steps[1];
      assert.equal(searching.status, 'running');
      assert.ok(Date.parse(searching.waitingSince!) >= s2At);
      assert.ok(
        progress.timeline!.every((e) => !e.seasons || e.seasons.includes(2))
      );
      assert.ok(!progress.timeline!.some((e) => e.kind === 'grabbed'));
    });

    it('is gone once its last request is', () => {
      const { tracker, s2At } = twoSeasons();
      const removed: [number, boolean][] = [];
      tracker.on('removed', (id, is4k) => removed.push([id, is4k]));
      tracker.setRequests(1, false, [{ id: 2, seasons: [2], at: s2At }]);
      assert.ok(tracker.get(1, false));
      tracker.setRequests(1, false, []);
      assert.equal(tracker.get(1, false), undefined);
      assert.deepEqual(removed, [[1, false]]);
    });

    it('keeps a run without requests, e.g. from a search event', () => {
      const { tracker } = setup();
      tracker.ensure({ mediaId: 1, is4k: false });
      tracker.setRequests(1, false, []);
      assert.ok(tracker.get(1, false));
    });
  });

  it('completes Ready together with the last unit in Jellyfin', () => {
    const { tracker, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false, requestId: 1, seasons: [1] });
    tracker.setUnits(1, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: true },
    ]);
    tracker.syncFiles(1, false);
    tracker.setJellyfin(1, false, {
      present: (u) => u.id === 101,
      playUrl: 'http://jf',
    });
    assert.equal(statuses().inJellyfin, 'running');
    assert.equal(statuses().playable, 'pending');
    assert.equal(tracker.get(1, false)!.playUrl, undefined);

    tick(5_000);
    tracker.setJellyfin(1, false, { present: () => true });
    const progress = tracker.get(1, false)!;
    const step = (k: string) => progress.steps.find((s) => s.key === k)!;
    assert.equal(step('playable').status, 'done');
    assert.equal(step('playable').startedAt, step('inJellyfin').finishedAt);
    assert.equal(step('playable').finishedAt, step('inJellyfin').finishedAt);
    assert.equal(progress.playUrl, 'http://jf');
  });

  it('walks a movie through all steps and records their durations', () => {
    const { tracker, stats, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
    tick(5_000);
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0], title: 'Movie' });
    assert.equal(statuses().grabbed, 'running');
    tick(3_000);
    tracker.setQueue(1, false, [
      {
        downloadId: 'D',
        unitIds: [0],
        title: 'Movie',
        size: 100,
        sizeLeft: 0,
        state: 'downloaded',
      },
    ]);
    assert.equal(statuses().importing, 'running');
    tick(4_000);
    tracker.imported(1, false, { downloadId: 'D', unitIds: [0] });
    tick(10_000);
    tracker.setJellyfin(1, false, {
      present: () => true,
      playUrl: 'http://jf',
    });

    const progress = tracker.get(1, false)!;
    assert.ok(progress.steps.every((s) => s.status === 'done'));
    assert.equal(progress.playUrl, 'http://jf');
    const estimates = stats.get('radarr-0');
    assert.equal(estimates.searching.percentiles[90]?.valueMs, 5_000);
    assert.equal(estimates.grabbed.percentiles[90]?.valueMs, 3_000);
    assert.equal(estimates.importing.percentiles[90]?.valueMs, 4_000);
    assert.equal(estimates.inJellyfin.percentiles[90]?.valueMs, 10_000);
    // Ready completes with the last unit in Jellyfin, so it takes no time of its own.
    assert.equal(estimates.playable.localCount, 0);
    assert.equal(stats.total('radarr-0').percentiles[90]?.valueMs, 22_000);
    // One sample is too few for an estimate.
    assert.equal(progress.totalEstimateMs, undefined);
    assert.ok(progress.steps.every((s) => s.estimateMs === undefined));
    assert.deepEqual(
      progress.timeline?.map((e) => e.kind),
      ['grabbed', 'downloaded', 'imported', 'inJellyfin', 'playable']
    );
  });

  it('records one sample per step and a total for a series run', () => {
    const { tracker, stats, tick } = setup();
    tracker.start({
      mediaId: 1,
      is4k: false,
      serverKey: 'sonarr-0',
      seasons: [1],
    });
    tracker.setUnits(1, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: false },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: false },
    ]);
    tick(5_000);
    tracker.grab(1, false, { downloadId: 'D1', unitIds: [101], title: 'E1' });
    tick(2_000);
    tracker.grab(1, false, { downloadId: 'D2', unitIds: [102], title: 'E2' });
    tick(3_000);
    const item = (downloadId: string, unitId: number) => ({
      downloadId,
      unitIds: [unitId],
      title: downloadId,
      size: 100,
      sizeLeft: 0,
      state: 'downloaded' as const,
    });
    tracker.setQueue(1, false, [item('D1', 101), item('D2', 102)]);
    tick(1_000);
    tracker.imported(1, false, { downloadId: 'D1', unitIds: [101] });
    tick(2_000);
    tracker.imported(1, false, { downloadId: 'D2', unitIds: [102] });
    tick(10_000);
    tracker.setUnits(1, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: true },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: true },
    ]);
    tracker.setJellyfin(1, false, {
      present: () => true,
      playUrl: 'http://jf',
    });

    assert.ok(tracker.get(1, false)!.steps.every((s) => s.status === 'done'));
    const estimates = stats.get('sonarr-0');
    const sample = (k: keyof typeof estimates) => [
      estimates[k].localCount,
      estimates[k].percentiles[90]?.valueMs,
    ];
    assert.deepEqual(sample('searching'), [1, 7_000]);
    assert.deepEqual(sample('grabbed'), [1, 5_000]);
    assert.deepEqual(sample('importing'), [1, 3_000]);
    assert.deepEqual(sample('inJellyfin'), [1, 12_000]);
    assert.equal(stats.total('sonarr-0').percentiles[90]?.valueMs, 23_000);
  });

  it('shows a step estimate from five samples on', () => {
    const { tracker, stats } = setup();
    for (let i = 0; i < MIN_STEP_SAMPLES - 1; i++) {
      stats.record('radarr-0', 'searching', 1_000);
    }
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
    const searching = () =>
      tracker.get(1, false)!.steps.find((s) => s.key === 'searching')!;
    assert.equal(searching().estimateMs, undefined);
    stats.record('radarr-0', 'searching', 1_000);
    assert.equal(searching().estimateMs, 1_000);
  });

  it('counts units per step and keeps steps when one download fails', () => {
    const { tracker, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'sonarr-0' });
    tracker.setUnits(
      1,
      false,
      [1, 2, 3].map((n) => ({
        id: 100 + n,
        seasonNumber: 1,
        episodeNumber: n,
        hasFile: false,
      }))
    );
    tick(1_000);
    tracker.grab(1, false, { downloadId: 'pack', unitIds: [101, 102] });
    tracker.grab(1, false, { downloadId: 'single', unitIds: [103] });
    tick(1_000);
    tracker.imported(1, false, { downloadId: 'pack', unitIds: [101, 102] });
    const failedAt = tick(1_000);
    mock.timers.enable({ apis: ['setTimeout'] });
    tracker.downloadFailed(1, false, {
      downloadId: 'single',
      reason: 'Download failed',
    });

    const steps = () =>
      Object.fromEntries(tracker.get(1, false)!.steps.map((s) => [s.key, s]));
    // Sonarr searches again at once, so the run searches rather than waits until that search.
    assert.equal(steps().searching.detail, 'Searching');
    assert.equal(steps().searching.waiting, undefined);
    assert.equal(steps().grabbed.waiting, undefined);
    tick(RETRY_SEARCH_MS);
    mock.timers.tick(RETRY_SEARCH_MS);
    mock.timers.reset();
    assert.equal(steps().searching.waiting, 'rss');
    assert.deepEqual(statuses(), {
      requested: 'done',
      searching: 'running',
      grabbed: 'running',
      importing: 'running',
      inJellyfin: 'running',
      playable: 'pending',
    });
    assert.deepEqual(steps().grabbed.counts, {
      done: 2,
      active: 0,
      failed: 1,
      total: 3,
    });
    assert.deepEqual(steps().importing.counts, {
      done: 2,
      active: 0,
      failed: 0,
      total: 3,
    });
    assert.equal(steps().importing.progress, 2 / 3);
    // Nothing downloads: the step waits for a new grab and its time stops at the failure.
    assert.equal(steps().grabbed.waiting, 'grab');
    assert.equal(
      steps().grabbed.waitingSince,
      new Date(failedAt).toISOString()
    );
    assert.equal(steps().importing.waiting, undefined);
    assert.ok(steps().importing.waitingSince);
    assert.equal(steps().inJellyfin.waitingSince, undefined);

    // The failure stays through the re-search until the new grab assigns another download.
    tracker.setSearch(1, false, { searchCommandId: 9 });
    assert.equal(steps().grabbed.counts?.failed, 1);
    tracker.grab(1, false, { downloadId: 'retry', unitIds: [103] });
    assert.deepEqual(steps().grabbed.counts, {
      done: 2,
      active: 1,
      failed: 0,
      total: 3,
    });
    assert.equal(steps().grabbed.waiting, undefined);
    assert.equal(steps().grabbed.waitingSince, undefined);
    assert.equal(statuses().searching, 'done');
    assert.deepEqual(
      tracker.get(1, false)!.timeline?.map((e) => [e.kind, e.units]),
      [
        ['grabbed', ['S01E01-E02']],
        ['grabbed', ['S01E03']],
        ['imported', ['S01E01-E02']],
        ['downloadFailed', ['S01E03']],
        ['searchStarted', undefined],
        ['grabbed', ['S01E03']],
      ]
    );
  });

  it('never fails a run on a failed download, which is searched for again', () => {
    const { tracker, tick } = setup();
    tracker.start({ mediaId: 1, is4k: false, requestId: 1 });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    mock.timers.enable({ apis: ['setTimeout'] });
    tracker.downloadFailed(1, false, {
      downloadId: 'D',
      reason: 'Download failed',
    });
    tick(RETRY_SEARCH_MS);
    mock.timers.tick(RETRY_SEARCH_MS);
    mock.timers.reset();
    const progress = () => tracker.get(1, false)!;
    const step = (k: string) => progress().steps.find((s) => s.key === k)!;
    assert.equal(step('grabbed').status, 'pending');
    assert.equal(step('grabbed').error, undefined);
    assert.equal(step('searching').waiting, 'rss');
    assert.equal(progress().requests[0].status, 'running');
    const failure = () =>
      progress().timeline?.find((e) => e.kind === 'downloadFailed');
    assert.equal(failure()?.resolved, undefined);
    // Grabbing the movie again resolves the failure.
    tracker.grab(1, false, { downloadId: 'E', unitIds: [0] });
    assert.equal(failure()?.resolved, true);
  });

  it('keeps searching for a download that failed during a re-search after it finished', () => {
    const { tracker, tick } = setup();
    tracker.start({ mediaId: 1, is4k: false, requestId: 1 });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    mock.timers.enable({ apis: ['setTimeout'] });
    tracker.downloadFailed(1, false, { downloadId: 'D', reason: 'Failed' });
    tick(2_000);
    tracker.setSearch(1, false, { searchCommandId: 1 });
    tracker.grab(1, false, { downloadId: 'E', unitIds: [0] });
    tick(1_000);
    tracker.downloadFailed(1, false, { downloadId: 'E', reason: 'Failed' });
    tick(1_000);
    tracker.searchFinished(1, false, { commandId: 1 });
    const searching = () =>
      tracker.get(1, false)!.steps.find((s) => s.key === 'searching')!;
    assert.equal(searching().waiting, undefined);
    tick(RETRY_SEARCH_MS);
    mock.timers.tick(RETRY_SEARCH_MS + 4_000);
    mock.timers.reset();
    assert.equal(searching().waiting, 'rss');
  });

  it('opens no search for a failure recorded after its re-search', () => {
    const { tracker, tick } = setup();
    const grabbedAt = tick(0);
    tracker.start({ mediaId: 1, is4k: false, requestId: 1 });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    tick(10_000);
    tracker.searchFinished(1, false, { commandId: 1 });
    tracker.downloadFailed(1, false, {
      downloadId: 'D',
      reason: 'Failed',
      at: grabbedAt + 1_000,
    });
    const searching = tracker
      .get(1, false)!
      .steps.find((s) => s.key === 'searching')!;
    assert.equal(searching.waiting, 'rss');
  });

  it('counts search time only while a search runs', () => {
    const { tracker, stats, tick } = setup();
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
    const searching = () =>
      tracker.get(1, false)!.steps.find((s) => s.key === 'searching')!;
    tick(60_000);
    tracker.searchFinished(1, false, { commandId: 1 });
    assert.equal(searching().searchMs, 60_000);
    assert.equal(searching().waiting, 'rss');
    assert.equal(searching().detail, WAITING_FOR_RSS);

    tick(10 * 60 * 60_000);
    assert.equal(searching().searchMs, 60_000);
    tracker.setSearch(1, false, { searchCommandId: 2 });
    assert.equal(searching().waiting, undefined);
    assert.ok(searching().searchStartedAt);
    tick(30_000);
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    assert.equal(searching().searchMs, 90_000);
    assert.equal(searching().status, 'done');
    // Only the search that found the release is a sample.
    assert.equal(
      stats.get('radarr-0').searching.percentiles[90]?.valueMs,
      30_000
    );
    // The run waited, so its end-to-end time is no total sample.
    tracker.imported(1, false, { downloadId: 'D', unitIds: [0] });
    tracker.setJellyfin(1, false, { present: () => true });
    assert.equal(stats.total('radarr-0').localCount, 0);
  });

  it('keeps searching while overlapping commands run, in one window for all of them', () => {
    const { tracker, tick } = setup();
    const startedAt = tick(0);
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'sonarr-0' });
    tracker.setUnits(1, false, [
      { id: 101, seasonNumber: 1, episodeNumber: 1, hasFile: false },
      { id: 102, seasonNumber: 1, episodeNumber: 2, hasFile: false },
    ]);
    tick(1_000);
    tracker.setSearch(1, false, { searchCommandId: 1 });
    tick(1_000);
    tracker.setSearch(1, false, { searchCommandId: 2 });
    // A progress event of the first command is no new start.
    tracker.setSearch(1, false, { searchCommandId: 1 });
    tick(1_000);
    tracker.searchFinished(1, false, { commandId: 2 });
    const progress = () => tracker.get(1, false)!;
    const searching = () =>
      progress().steps.find((s) => s.key === 'searching')!;
    assert.equal(searching().waiting, undefined);
    assert.equal(searching().detail, 'Searching');
    assert.equal(
      searching().searchStartedAt,
      new Date(startedAt).toISOString()
    );
    assert.equal(
      progress().timeline?.filter((e) => e.kind === 'searchStarted').length,
      2
    );

    tick(1_000);
    tracker.searchFinished(1, false, { commandId: 1 });
    assert.equal(searching().waiting, 'rss');
    assert.equal(searching().searchMs, 4_000);
  });

  it('never shows waiting while a search command runs', () => {
    const { tracker } = setup();
    tracker.start({ mediaId: 1, is4k: false, requestId: 1 });
    tracker.setSearch(1, false, { searchCommandId: 1 });
    // A search that started without a window, e.g. one whose start predates a restart.
    tracker.entry(1, false)!.searchStartedAt = undefined;
    tracker.setSearch(1, false, { unreleased: true });
    const progress = tracker.get(1, false)!;
    const searching = progress.steps.find((s) => s.key === 'searching')!;
    assert.equal(searching.waiting, undefined);
    assert.equal(searching.detail, 'Searching');
    assert.equal(progress.requests[0].waiting, undefined);
  });

  it('takes a grab while waiting as RSS, without a search sample', () => {
    const { tracker, stats, tick } = setup();
    tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
    tracker.setSearch(1, false, { unreleased: true });
    tick(1_000);
    tracker.searchFinished(1, false, { commandId: 1 });
    const searching = () =>
      tracker.get(1, false)!.steps.find((s) => s.key === 'searching')!;
    assert.equal(searching().waiting, 'release');
    assert.equal(searching().detail, WAITING_FOR_RELEASE);
    tick(60 * 60_000);
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    assert.equal(searching().searchMs, 1_000);
    assert.equal(stats.get('radarr-0').searching.localCount, 0);
  });

  it('fails the request at the first open step and recovers on unit progress', () => {
    const { tracker, tick, statuses } = setup();
    tracker.start({ mediaId: 1, is4k: false });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    tick(1_000);
    tracker.fail(1, false, 'Manual interaction required');
    const failed = tracker
      .get(1, false)!
      .steps.find((s) => s.key === 'grabbed')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'Manual interaction required');
    assert.equal(tracker.active().length, 0);

    tick(1_000);
    tracker.imported(1, false, { downloadId: 'D', unitIds: [0] });
    assert.equal(statuses().importing, 'done');
    assert.equal(tracker.active().length, 1);
  });

  it('reports a finished run once, and a dropped one when its requests leave', () => {
    const { tracker, tick } = setup();
    const finished: [RequestProgress, number[]][] = [];
    const removed: RequestProgress[] = [];
    tracker.on('finished', (p, ids) => finished.push([p, ids]));
    tracker.on('removed', (_id, _4k, last) => removed.push(last));
    tracker.start({ mediaId: 1, is4k: false, requestId: 7 });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0], title: 'Movie' });
    tracker.imported(1, false, { downloadId: 'D', unitIds: [0] });
    assert.equal(finished.length, 0);
    tick(1_000);
    tracker.setJellyfin(1, false, {
      present: () => true,
      playUrl: 'http://jf',
    });
    tracker.setRequests(1, false, []);
    assert.equal(finished.length, 1);
    const [progress, ids] = finished[0];
    assert.deepEqual(ids, [7]);
    assert.ok(progress.finishedAt);
    assert.equal(progress.steps.at(-1)?.status, 'done');
    assert.equal(removed[0].finishedAt, progress.finishedAt);
    assert.ok(removed[0].timeline?.length);

    tracker.start({ mediaId: 2, is4k: false, requestId: 8 });
    tracker.setRequests(2, false, []);
    assert.equal(finished.length, 2);
    assert.deepEqual(finished[1][1], [8]);
    assert.equal(finished[1][0].steps[1].status, 'running');
  });

  it('shows the failure reason of a failed request over the send error', () => {
    const { tracker } = setup();
    tracker.start({ mediaId: 1, is4k: false });
    tracker.fail(1, false, 'Sending the request to Radarr failed');
    tracker.failRequest(1, false, 'connect ECONNREFUSED');
    const failed = tracker
      .get(1, false)!
      .steps.find((s) => s.key === 'searching')!;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'connect ECONNREFUSED');
  });

  it('ignores events for untracked media and keeps 4k separate', () => {
    const { tracker, changes } = setup();
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    tracker.fail(1, false, 'x');
    assert.equal(changes.length, 0);
    tracker.start({ mediaId: 1, is4k: true });
    assert.equal(tracker.get(1, false), undefined);
    assert.ok(tracker.get(1, true));
  });

  it('ensure keeps an existing run and fills in its server', () => {
    const { tracker } = setup();
    const first = tracker.start({ mediaId: 1, is4k: false });
    tracker.grab(1, false, { downloadId: 'D', unitIds: [0] });
    const again = tracker.ensure({
      mediaId: 1,
      is4k: false,
      serverKey: 'radarr-1',
    });
    assert.equal(again, first);
    assert.equal(again.serverKey, 'radarr-1');
    assert.equal(again.steps.grabbed.status, 'running');
  });

  it('estimates the total from finished runs once there are enough', () => {
    const { tracker, stats, tick } = setup();
    // Every run takes 51s, but alternates which step is slow, so the step p90s add up to 100s.
    for (let i = 0; i < MIN_TOTAL_SAMPLES; i++) {
      tracker.start({ mediaId: 1, is4k: false, serverKey: 'radarr-0' });
      tick(i % 2 ? 1_000 : 50_000);
      tracker.grab(1, false, { downloadId: `D${i}`, unitIds: [0] });
      tracker.imported(1, false, { downloadId: `D${i}`, unitIds: [0] });
      tick(i % 2 ? 50_000 : 1_000);
      tracker.setJellyfin(1, false, { present: () => true });
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
