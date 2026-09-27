/** Bound viewport requests before they reach the shared server device queue. */
export class VisibleResourceQueue {
  private active = 0;
  private pending: Array<{ signal: AbortSignal; run: () => Promise<void>; cancel: () => void }> = [];
  private limit: number;
  constructor(limit = 2) { this.limit = Math.max(1, limit); }
  request<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => reject(new DOMException("已离开可见区域", "AbortError"));
      const task = { signal, cancel: cancelled, run: async () => {
        signal.removeEventListener("abort", abort);
        try { if (signal.aborted) cancelled(); else resolve(await work()); }
        catch (error) { reject(error); }
      } };
      const abort = () => { const index = this.pending.indexOf(task); if (index >= 0) { this.pending.splice(index, 1); cancelled(); } };
      if (signal.aborted) { cancelled(); return; }
      signal.addEventListener("abort", abort, { once: true });
      this.pending.push(task); this.drain();
    });
  }
  private drain() {
    while (this.active < this.limit && this.pending.length) {
      const task = this.pending.shift()!;
      if (task.signal.aborted) { task.cancel(); continue; }
      this.active++;
      void task.run().finally(() => { this.active--; this.drain(); });
    }
  }
}
