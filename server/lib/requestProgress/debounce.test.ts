import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { KeyedDebouncer } from '@server/lib/requestProgress/debounce';

describe('KeyedDebouncer', () => {
  it('collapses a burst into one flush after the key is quiet', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const flushed: [string, number[]][] = [];
      const debouncer = new KeyedDebouncer<number>(
        (key, values) => void flushed.push([key, values]),
        2000
      );
      debouncer.push('radarr-0', 1);
      mock.timers.tick(1500);
      debouncer.push('radarr-0', 2);
      debouncer.push('sonarr-0', 3);
      mock.timers.tick(1999);
      await Promise.resolve();
      assert.deepEqual(flushed, []);

      mock.timers.tick(1);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(flushed, [
        ['radarr-0', [1, 2]],
        ['sonarr-0', [3]],
      ]);

      debouncer.push('radarr-0', 4);
      mock.timers.tick(2000);
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(flushed.at(-1), ['radarr-0', [4]]);
    } finally {
      mock.timers.reset();
    }
  });

  it('drops pending flushes on clear', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let calls = 0;
      const debouncer = new KeyedDebouncer(() => calls++, 2000);
      debouncer.push('a', undefined);
      debouncer.clear();
      mock.timers.tick(5000);
      await new Promise((r) => setImmediate(r));
      assert.equal(calls, 0);
    } finally {
      mock.timers.reset();
    }
  });
});
