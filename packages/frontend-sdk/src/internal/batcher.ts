// The bounded export queue shared by /tracing and /logging (design doc §C1: "the batch queue is
// bounded and drops the oldest entries"). At most `maxInFlight` batches are being sent at once;
// while they are, items wait in the queue, and once it is full the oldest are dropped. So a slow
// or unreachable collector costs a fixed amount of memory and never more than `maxInFlight`
// pending requests. A failed send is counted and its items are lost: telemetry never retries
// into a page that is already struggling.

/** Adapts an OTel exporter's callback (code 0 = success) to the Batcher's send promise. */
export function exportWith<T>(exporter: { export(items: T[], cb: (r: { code: number }) => void): void }) {
  return (batch: T[]) => new Promise<boolean>((resolve) => exporter.export(batch, (r) => resolve(r.code === 0)));
}

export interface BatcherOptions<T = unknown> {
  /** Items kept while sends are busy; beyond it the oldest are dropped. */
  maxQueueSize: number;
  /** Items per send; a full batch is sent at once (if a send slot is free). */
  batchSize: number;
  /** A partial batch is sent this long after its first item. */
  delayMs: number;
  /** Concurrent sends. */
  maxInFlight: number;
  /**
   * Run on the queue before every send and by takeAll: returns the items still allowed to leave (say,
   * consent was withdrawn since they were queued), counting the rest itself.
   */
  purge?: (items: T[]) => T[];
}

export interface BatcherStats {
  exported: number;
  droppedQueueFull: number;
  exportFailures: number;
}

export class Batcher<T> {
  private queue: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    /** Sends one batch; resolves true on success. A throw or rejection counts as a failure. */
    private readonly send: (batch: T[]) => Promise<boolean>,
    readonly stats: BatcherStats,
    private readonly opts: BatcherOptions<T>,
  ) {}

  get size(): number {
    return this.queue.length;
  }

  add(item: T): void {
    this.queue.push(item);
    if (this.queue.length > this.opts.maxQueueSize) {
      this.queue.shift();
      this.stats.droppedQueueFull++;
    }
    if (this.queue.length >= this.opts.batchSize) this.pump(false);
    else this.timer ??= setTimeout(() => this.onTimer(), this.opts.delayMs);
  }

  /** Removes and returns everything queued (e.g. to send it by beacon on page hide). */
  takeAll(): T[] {
    this.clearTimer();
    const items = this.queue.splice(0);
    return this.opts.purge ? this.opts.purge(items) : items;
  }

  /** Puts items back at the front, e.g. what a beacon could not take. */
  requeue(items: T[]): void {
    this.queue.unshift(...items);
    while (this.queue.length > this.opts.maxQueueSize) {
      this.queue.shift();
      this.stats.droppedQueueFull++;
    }
  }

  /** Sends everything queued and waits for every send, respecting the in-flight limit. */
  async flush(): Promise<void> {
    this.clearTimer();
    for (;;) {
      this.pump(true);
      if (this.inFlight.size === 0) return;
      await Promise.race(this.inFlight);
    }
  }

  private onTimer(): void {
    this.timer = undefined;
    this.pump(true);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Starts sends while slots are free: full batches only, or partial ones too when `all`. */
  private pump(all: boolean): void {
    if (this.opts.purge) this.queue = this.opts.purge(this.queue);
    while (
      this.inFlight.size < this.opts.maxInFlight &&
      this.queue.length > 0 &&
      (all || this.queue.length >= this.opts.batchSize)
    ) {
      const batch = this.queue.splice(0, this.opts.batchSize);
      const done = this.sendSafely(batch).then(() => {
        this.inFlight.delete(done);
        // A slot is free: send what accumulated meanwhile (partial batches wait for their timer).
        if (this.queue.length >= this.opts.batchSize) this.pump(false);
        else if (this.queue.length > 0) this.timer ??= setTimeout(() => this.onTimer(), this.opts.delayMs);
      });
      this.inFlight.add(done);
    }
  }

  private async sendSafely(batch: T[]): Promise<void> {
    let ok: boolean;
    try {
      ok = await this.send(batch);
    } catch {
      ok = false;
    }
    if (ok) this.stats.exported += batch.length;
    else this.stats.exportFailures++;
  }
}

/** How many oversized newest items newestThatFit skips before it gives up (each skip costs one probe). */
const OVERSIZED_SKIP_MAX = 8;

/**
 * The newest items of `queue` (oldest first) whose serialised body (`sizeOf`, Infinity when it cannot be
 * serialised) fits `maxBytes`, for the page's keepalive budget. The run grows by doubling, then a binary
 * search: each probe serialises at most about twice the budget, not the whole queue. A newest item that
 * alone exceeds `maxBytes` is skipped (up to OVERSIZED_SKIP_MAX), so one oversized record never leaves the
 * budget unused and the records before it unsent. `rest` is everything not in `batch`, oldest first.
 */
export function newestThatFit<T>(queue: readonly T[], maxBytes: number, sizeOf: (items: T[]) => number): { batch: T[]; bytes: number; rest: T[] } {
  const skipped: T[] = [];
  for (let end = queue.length; end > 0 && skipped.length <= OVERSIZED_SKIP_MAX; end--) {
    const fits = (n: number) => sizeOf(queue.slice(end - n, end)) <= maxBytes;
    let lo = 0;
    let hi = 1;
    while (hi <= end && fits(hi)) {
      lo = hi;
      hi *= 2;
    }
    hi = Math.min(hi - 1, end);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) {
      const batch = queue.slice(end - lo, end);
      return { batch, bytes: sizeOf(batch), rest: [...queue.slice(0, end - lo), ...skipped] };
    }
    skipped.unshift(queue[end - 1]!); // the newest alone is over the budget
  }
  return { batch: [], bytes: 0, rest: [...queue] };
}

/**
 * The keepalive bytes the exporter may still take for `count` items sent after a beacon of `batch` items
 * and `bytes` (it sends with keepalive while its own count allows: the browser's budget is the same).
 * Estimated from the beacon's average, so nothing more is serialised; at most `budget`.
 */
export function leftoverKeepaliveBytes(count: number, batch: number, bytes: number, budget: number): number {
  if (count === 0 || budget <= 0) return 0;
  const average = batch > 0 ? bytes / batch : budget;
  return Math.min(budget, Math.ceil(average * count));
}
