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

  /** Page hidden or unloading: queued records go by beacon; what the browser refuses, by fetch. */
  drainOnHide(): void {
    const rest = this.beacon(this.batcher.takeAll());
    if (rest.length > 0) {
      this.batcher.requeue(rest);
      void this.batcher.flush();
    }
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
