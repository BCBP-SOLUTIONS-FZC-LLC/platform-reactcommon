// Log batching (design doc §C1 /logging "Transport"): records go to the shared bounded Batcher
// (drops the oldest when full, at most two sends in flight) and out through the OTLP exporter
// (fetch keepalive). When the page is hidden or unloading, everything queued is sent with
// navigator.sendBeacon; what the browser refuses goes back to the queue for fetch.
import type { Context } from '@opentelemetry/api';
import { JsonLogsSerializer } from '@opentelemetry/otlp-transformer';
import type { LogRecordExporter, LogRecordProcessor, ReadWriteLogRecord, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { Batcher, exportWith, type BatcherStats } from '../internal/batcher.ts';

export interface LoggingStats extends BatcherStats {
  /** Beacons the browser accepted on page hide. */
  beacons: number;
}

export interface LogQueueOptions {
  maxQueueSize: number;
  batchSize: number;
  flushMs: number;
}

/** sendBeacon payloads are limited to 64 KiB per page; stay under it per beacon. */
const BEACON_MAX_BYTES = 60 * 1024;

export class DropOldestLogProcessor implements LogRecordProcessor {
  private readonly batcher: Batcher<ReadableLogRecord>;

  constructor(
    private readonly exporter: LogRecordExporter,
    private readonly beaconUrl: string,
    readonly stats: LoggingStats,
    opts: LogQueueOptions,
  ) {
    this.batcher = new Batcher(exportWith<ReadableLogRecord>(exporter), stats, {
      maxQueueSize: opts.maxQueueSize,
      batchSize: opts.batchSize,
      delayMs: opts.flushMs,
      maxInFlight: 2,
    });
  }

  onEmit(record: ReadWriteLogRecord, _context?: Context): void {
    this.batcher.add(record);
  }

  /** Sends `batch` as one or more beacons; returns the records the browser did not take. */
  private beacon(batch: ReadableLogRecord[]): ReadableLogRecord[] {
    const nav = globalThis.navigator;
    if (typeof nav?.sendBeacon !== 'function' || batch.length === 0) return batch;
    const body = JsonLogsSerializer.serializeRequest(batch);
    if (!body) return batch;
    if (body.byteLength > BEACON_MAX_BYTES) {
      if (batch.length === 1) return batch; // one record over the limit goes through fetch
      const half = Math.ceil(batch.length / 2);
      return [...this.beacon(batch.slice(0, half)), ...this.beacon(batch.slice(half))];
    }
    let accepted: boolean;
    try {
      accepted = nav.sendBeacon(this.beaconUrl, new Blob([body as BlobPart], { type: 'application/json' }));
    } catch {
      accepted = false;
    }
    if (!accepted) return batch;
    this.stats.beacons++;
    this.stats.exported += batch.length;
    return [];
  }

  /**
   * Page unloading (pagehide, through src/internal/unload.ts), first in the page's keepalive budget:
   * the newest queued records that fit `budget` go in one beacon; the rest, and anything the browser
   * refuses, go back to the queue for fetch. Returns the bytes the beacon took.
   */
  drainOnUnload(budget: number, deferRest = false): number {
    const queue = this.batcher.takeAll();
    const max = Math.min(budget, BEACON_MAX_BYTES);
    const size = (n: number) => {
      try {
        return JsonLogsSerializer.serializeRequest(queue.slice(queue.length - n))?.byteLength ?? Infinity;
      } catch {
        return Infinity;
      }
    };
    let lo = 0;
    let hi = queue.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(mid) <= max) lo = mid;
      else hi = mid - 1;
    }
    const batch = queue.slice(queue.length - lo);
    const rest = [...queue.slice(0, queue.length - lo), ...this.beacon(batch)];
    if (rest.length > 0) {
      this.batcher.requeue(rest);
      // Hidden: the rest goes a task later, after the metrics interval took its share of the keepalive
      // budget (the exporter sends with keepalive whenever its own count allows). A tab that closes first
      // sends it on pagehide (drainOnUnload), within what the budget has left.
      if (deferRest) setTimeout(() => void this.batcher.flush(), 0);
      else void this.batcher.flush();
    }
    return rest.length === queue.length || lo === 0 ? 0 : size(lo);
  }

  /**
   * Page hidden (it may come back, or be closing): the newest queued records that fit `budget` (what
   * the page's keepalive budget has left, src/internal/unload.ts) go in one beacon, which outlives a
   * closing tab; the rest by fetch a task later, which completes while the page stays. Returns the
   * beacon's bytes.
   */
  drainOnHide(budget: number): number {
    return this.drainOnUnload(budget, true);
  }

  async forceFlush(): Promise<void> {
    await this.batcher.flush();
    await this.exporter.forceFlush?.().catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    await this.exporter.shutdown().catch(() => {});
  }
}
