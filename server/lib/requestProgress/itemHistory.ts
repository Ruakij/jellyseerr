import type { HistoryRecord } from '@server/api/servarr/base';
import logger from '@server/logger';

/** An item without a named event or a changed queue is read again after this long. */
export const ITEM_HISTORY_RECHECK_MS = 5 * 60_000;

// Records are dated by the server's clock and can be written late: read a little further back.
const SINCE_OVERLAP_MS = 60_000;

interface ItemHistoryApi {
  getItemHistory(id: number): Promise<HistoryRecord[]>;
  getItemHistorySince(id: number, since: Date): Promise<HistoryRecord[]>;
}

interface ItemRead {
  /** Start of the last read. */
  at: number;
  /** Newest record date of the last successful read; unset reads everything. */
  seen?: number;
  /** The queue entries of the item at the last read. */
  queue: string;
  /** Earliest request start the last read served. */
  earliest: number;
  running: boolean;
  /** A read was due while another one ran. */
  missed: boolean;
}

/**
 * Reads the history of Radarr/Sonarr items for the refresh, which would load several MB per
 * large series each time. An item is read again when an event named it, its queue entries changed,
 * a run reaches back further than the last read served or {@link ITEM_HISTORY_RECHECK_MS} passed.
 * A read takes only the records since the newest one seen and falls back to the whole history
 * on an error. One read per item runs at a time.
 */
export class ItemHistoryReader {
  private items = new Map<string, ItemRead>();

  /**
   * The records to apply, or none when no read is due or one is running. Applying records twice
   * is harmless, so the ones from before the last seen date are read again.
   */
  async read(
    api: ItemHistoryApi,
    id: string,
    arrId: number,
    due: { named: boolean; queue: string; earliest: number }
  ): Promise<HistoryRecord[]> {
    const now = Date.now();
    const read = this.items.get(id);
    if (
      read &&
      !read.missed &&
      !due.named &&
      due.queue === read.queue &&
      due.earliest >= read.earliest &&
      now - read.at < ITEM_HISTORY_RECHECK_MS
    ) {
      return [];
    }
    if (read?.running) {
      read.missed = true;
      return [];
    }
    const since =
      read?.seen !== undefined && due.earliest >= read.earliest
        ? new Date(read.seen - SINCE_OVERLAP_MS)
        : undefined;
    const item: ItemRead = read ?? {
      at: now,
      queue: due.queue,
      earliest: due.earliest,
      running: true,
      missed: false,
    };
    this.items.set(id, item);
    Object.assign(item, { at: now, running: true, missed: false });
    try {
      let records: HistoryRecord[];
      try {
        records = since
          ? await api.getItemHistorySince(arrId, since)
          : await api.getItemHistory(arrId);
      } catch (e) {
        if (!since) throw e;
        logger.warn(
          `Loading the item history since ${since.toISOString()} failed: ${e.message}`,
          { label: 'Request Progress', id }
        );
        records = await api.getItemHistory(arrId);
      }
      const newest = records.reduce(
        (n, r) => Math.max(n, Date.parse(r.date)),
        0
      );
      Object.assign(item, {
        // Without records the date stays, unless the whole history was empty.
        seen: newest || (since ? item.seen : undefined),
        queue: due.queue,
        earliest: due.earliest,
      });
      return records;
    } catch (e) {
      item.seen = undefined;
      item.missed = true;
      throw e;
    } finally {
      item.running = false;
    }
  }
}
