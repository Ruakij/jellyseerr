import type {
  ProgressSeason,
  ProgressStep,
  ProgressStepKey,
} from '@server/interfaces/api/progressInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultSeason } from './seasons';

const KEYS: ProgressStepKey[] = [
  'requested',
  'searching',
  'grabbed',
  'importing',
  'inJellyfin',
  'playable',
];

// The steps before `key` are done, `key` has `status`, the rest are pending
const season = (
  n: number,
  key?: ProgressStepKey,
  status: ProgressStep['status'] = 'running',
  waiting?: ProgressStep['waiting']
): ProgressSeason => ({
  season: n,
  steps: KEYS.map((k, i) => ({
    key: k,
    status:
      !key || i < KEYS.indexOf(key) ? 'done' : k === key ? status : 'pending',
    waiting: k === key ? waiting : undefined,
  })),
});

describe('defaultSeason', () => {
  const ready = season(1);

  it('opens the first season that is downloading', () => {
    const seasons = [ready, season(2, 'grabbed'), season(3, 'importing')];
    assert.equal(defaultSeason(seasons).season, 2);
  });

  it('stays on the first season while the others wait for a release', () => {
    assert.equal(
      defaultSeason([ready, season(2, 'searching', 'running', 'release')])
        .season,
      1
    );
    assert.equal(
      defaultSeason([ready, season(2, 'searching', 'running', 'rss')]).season,
      1
    );
  });

  it('skips seasons awaiting approval, failed and not released', () => {
    const seasons = [
      season(1, 'requested'),
      season(2, 'grabbed', 'failed'),
      { season: 3 },
      season(4, 'searching'),
    ];
    assert.equal(defaultSeason(seasons).season, 4);
  });

  it('opens the first season when none is in progress', () => {
    const seasons = [season(1, 'requested'), { season: 2 }, ready];
    assert.equal(defaultSeason(seasons).season, 1);
  });
});
