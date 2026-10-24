import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import type { HistoryRecord } from '@server/api/servarr/base';
import {
  ITEM_HISTORY_RECHECK_MS,
  ItemHistoryReader,
} from '@server/lib/requestProgress/itemHistory';

const record = (id: number, date: string) => ({ id, date }) as HistoryRecord;

describe('ItemHistoryReader', () => {
  const due = { named: false, queue: '', earliest: 0 };
  let records: HistoryRecord[];
  let failSince: boolean;
  let calls: string[];
  let reader: ItemHistoryReader;
  const api = {
    getItemHistory: async (id: number) => {
      calls.push(`all ${id}`);
      return records;
    },
    getItemHistorySince: async (id: number, since: Date) => {
      calls.push(`since ${id} ${since.toISOString()}`);
      if (failSince) throw new Error('timeout');
      return records.filter((r) => Date.parse(r.date) >= +since);
    },
  };

  beforeEach(() => {
    mock.timers.enable({
      apis: ['Date'],
      now: Date.parse('2026-01-10T00:00:00Z'),
    });
    records = [
      record(2, '2026-01-02T00:00:00Z'),
      record(1, '2026-01-01T00:00:00Z'),
    ];
    failSince = false;
    calls = [];
    reader = new ItemHistoryReader();
  });
  afterEach(() => mock.timers.reset());

  it('reads everything first and skips an item nothing asks for', async () => {
    assert.equal((await reader.read(api, 'a', 5, due)).length, 2);
    assert.deepEqual(await reader.read(api, 'a', 5, due), []);
    assert.deepEqual(calls, ['all 5']);
  });

  it('reads since a minute before the newest record once an event names the item', async () => {
    await reader.read(api, 'a', 5, due);
    records.unshift(record(3, '2026-01-03T00:00:00Z'));

    const read = await reader.read(api, 'a', 5, { ...due, named: true });

    assert.deepEqual(
      read.map((r) => r.id),
      [3, 2]
    );
    assert.deepEqual(calls[1], 'since 5 2026-01-01T23:59:00.000Z');
  });

  it('reads again when the queue changed, a run reaches further back or the recheck time passed', async () => {
    await reader.read(api, 'a', 5, due);
    await reader.read(api, 'a', 5, { ...due, queue: 'D:downloading' });
    assert.equal(calls.length, 2);

    // The records before the last read were not applied to this run: everything again.
    await reader.read(api, 'a', 5, {
      ...due,
      queue: 'D:downloading',
      earliest: -1,
    });
    assert.equal(calls[2], 'all 5');

    mock.timers.tick(ITEM_HISTORY_RECHECK_MS - 1);
    await reader.read(api, 'a', 5, {
      ...due,
      queue: 'D:downloading',
      earliest: -1,
    });
    assert.equal(calls.length, 3);
    mock.timers.tick(1);
    await reader.read(api, 'a', 5, {
      ...due,
      queue: 'D:downloading',
      earliest: -1,
    });
    assert.match(calls[3], /^since 5 /);
  });

  it('falls back to the whole history when the incremental read fails', async () => {
    await reader.read(api, 'a', 5, due);
    failSince = true;

    const read = await reader.read(api, 'a', 5, { ...due, named: true });

    assert.equal(read.length, 2);
    assert.match(calls[1], /^since 5 /);
    assert.equal(calls[2], 'all 5');
  });

  it('reads everything and again soon after a failed read', async () => {
    const failing = {
      ...api,
      getItemHistory: async () => {
        throw new Error('timeout');
      },
    };
    await assert.rejects(() => reader.read(failing, 'a', 5, due), /timeout/);

    await reader.read(api, 'a', 5, due);

    assert.deepEqual(calls, ['all 5']);
  });

  it('starts no second read of an item while one runs and reads again after it', async () => {
    let release: () => void = () => {};
    const slow = {
      ...api,
      getItemHistory: async () => {
        calls.push('slow');
        await new Promise<void>((resolve) => (release = resolve));
        return records;
      },
    };
    const first = reader.read(slow, 'a', 5, due);

    assert.deepEqual(
      await reader.read(slow, 'a', 5, { ...due, named: true }),
      []
    );
    assert.deepEqual(calls, ['slow']);
    release();
    await first;

    assert.equal((await reader.read(api, 'a', 5, due)).length, 1);
    assert.match(calls[1], /^since 5 /);
  });

  it('keeps the items of other keys apart', async () => {
    await reader.read(api, 'a', 5, due);
    await reader.read(api, 'b', 5, due);
    assert.deepEqual(calls, ['all 5', 'all 5']);
  });
});
