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

export interface BatcherOptions {
  /** Items kept while sends are busy; beyond it the oldest are dropped. */
  maxQueueSize: number;
  /** Items per send; a full batch is sent at once (if a send slot is free). */
  batchSize: number;
  /** A partial batch is sent this long after its first item. */
  delayMs: number;
  /** Concurrent sends. */
  maxInFlight: number;
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
    private readonly opts: BatcherOptions,
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
    return this.queue.splice(0);
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
