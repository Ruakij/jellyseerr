import logger from '@server/logger';

export const DEBOUNCE_MS = 2000;
export const MAX_WAIT_MS = 10_000;

/**
 * Trailing debounce per key: values pushed within `delayMs` of each other are handed to `flush`
 * together, once the key has been quiet for `delayMs` or `maxWaitMs` after its first value.
 */
export class KeyedDebouncer<T = void> {
  private pending = new Map<
    string,
    { timer: NodeJS.Timeout; values: T[]; firstAt: number }
  >();

  constructor(
    private readonly flush: (key: string, values: T[]) => unknown,
    private readonly delayMs = DEBOUNCE_MS,
    private readonly maxWaitMs = MAX_WAIT_MS
  ) {}

  public push(key: string, value: T): void {
    const entry = this.pending.get(key);
    clearTimeout(entry?.timer);
    const values = [...(entry?.values ?? []), value];
    const firstAt = entry?.firstAt ?? Date.now();
    const wait = Math.min(this.delayMs, firstAt + this.maxWaitMs - Date.now());
    const timer = setTimeout(
      () => {
        this.pending.delete(key);
        Promise.resolve()
          .then(() => this.flush(key, values))
          .catch((e: Error) =>
            logger.error(`Refresh of ${key} failed: ${e.message}`, {
              label: 'Request Progress',
            })
          );
      },
      Math.max(0, wait)
    );
    this.pending.set(key, { timer, values, firstAt });
  }

  public clear(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
