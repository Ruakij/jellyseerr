import logger from '@server/logger';

export const DEBOUNCE_MS = 2000;

/**
 * Trailing debounce per key: values pushed within `delayMs` of each other are handed to `flush`
 * together, once the key has been quiet for `delayMs`.
 */
// ponytail: an endless stream of events on one key never flushes; add a max wait if that happens.
export class KeyedDebouncer<T = void> {
  private pending = new Map<string, { timer: NodeJS.Timeout; values: T[] }>();

  constructor(
    private readonly flush: (key: string, values: T[]) => unknown,
    private readonly delayMs = DEBOUNCE_MS
  ) {}

  public push(key: string, value: T): void {
    const entry = this.pending.get(key);
    clearTimeout(entry?.timer);
    const values = [...(entry?.values ?? []), value];
    const timer = setTimeout(() => {
      this.pending.delete(key);
      Promise.resolve()
        .then(() => this.flush(key, values))
        .catch((e: Error) =>
          logger.error(`Refresh of ${key} failed: ${e.message}`, {
            label: 'Request Progress',
          })
        );
    }, this.delayMs);
    this.pending.set(key, { timer, values });
  }

  public clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
