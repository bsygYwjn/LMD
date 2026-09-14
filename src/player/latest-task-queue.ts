export type LatestTaskContext = { isLatest: () => boolean };

type PendingTask<T> = { revision: number; value: T };
type Waiter = { revision: number; resolve: () => void; reject: (error: unknown) => void };

/**
 * Debounces replaceable work, serializes requests that have already started and
 * lets the worker discard a response when a newer intent arrived meanwhile.
 */
export class LatestTaskQueue<T> {
  private readonly worker: (value: T, context: LatestTaskContext) => Promise<void>;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: PendingTask<T> | null = null;
  private waiters: Waiter[] = [];
  private revision = 0;
  private running = false;
  private stopped = false;

  constructor(worker: (value: T, context: LatestTaskContext) => Promise<void>, delayMs = 120) {
    this.worker = worker;
    this.delayMs = delayMs;
  }

  enqueue(value: T): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const revision = ++this.revision;
    this.pending = { revision, value };
    this.schedule(this.delayMs);
    return new Promise<void>((resolve, reject) => this.waiters.push({ revision, resolve, reject }));
  }

  cancel() {
    this.revision++;
    this.pending = null;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.settle(this.revision);
  }

  dispose() {
    this.stopped = true;
    this.cancel();
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }

  private settle(revision: number, error?: unknown) {
    const settled = this.waiters.filter(waiter => waiter.revision <= revision);
    this.waiters = this.waiters.filter(waiter => waiter.revision > revision);
    for (const waiter of settled) error === undefined ? waiter.resolve() : waiter.reject(error);
  }

  private async drain() {
    if (this.stopped || this.running || !this.pending) return;
    const task = this.pending;
    this.pending = null;
    this.running = true;
    const context: LatestTaskContext = { isLatest: () => !this.stopped && task.revision === this.revision };
    try {
      await this.worker(task.value, context);
      if (context.isLatest()) this.settle(task.revision);
    } catch (error) {
      if (context.isLatest()) this.settle(task.revision, error);
    } finally {
      this.running = false;
      if (!this.stopped && this.pending && !this.timer) this.schedule(0);
    }
  }
}
