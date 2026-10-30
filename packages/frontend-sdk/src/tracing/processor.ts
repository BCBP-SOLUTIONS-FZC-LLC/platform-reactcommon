// The span processor (design doc §C1 /tracing): ended, sampled spans go to the shared bounded
// Batcher (drops the oldest when full, at most two sends in flight), only with telemetry consent.
// Export failures are swallowed and counted: telemetry must never break the app. When the page is
// hidden or unloading, everything queued goes out at once in requests small enough for keepalive.
import type { Context } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { hasConsent } from '../core/index.ts';
import { Batcher, exportWith, type BatcherStats } from '../internal/batcher.ts';

export interface TracingStats extends BatcherStats {
  /** Spans dropped because telemetry consent was not granted when they ended. */
  droppedNoConsent: number;
}

export interface QueueOptions {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000 };

/**
 * keepalive fetch bodies are limited to 64 KiB per page, and the OTLP exporter drops keepalive
 * (so an unload cancels the request) for a larger one: stay under it per request on page hide.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

export class DropOldestBatchSpanProcessor implements SpanProcessor {
  private readonly batcher: Batcher<ReadableSpan>;
  private closed = false;

  constructor(
    private readonly exporter: SpanExporter,
    readonly stats: TracingStats,
    opts: QueueOptions = DEFAULT_QUEUE,
  ) {
    this.batcher = new Batcher(exportWith<ReadableSpan>(exporter), stats, {
      maxQueueSize: opts.maxQueueSize,
      batchSize: opts.maxExportBatchSize,
      delayMs: opts.scheduledDelayMillis,
      maxInFlight: 2,
    });
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.closed || !span.spanContext().traceFlags) return; // not sampled
    if (!hasConsent('telemetry')) {
      this.stats.droppedNoConsent++;
      return;
    }
    this.batcher.add(span);
  }

  /** Splits `batch` into runs whose OTLP JSON body fits KEEPALIVE_MAX_BYTES (one span over it goes alone). */
  private keepaliveBatches(batch: ReadableSpan[]): ReadableSpan[][] {
    if (batch.length <= 1) return batch.length === 0 ? [] : [batch];
    const body = JsonTraceSerializer.serializeRequest(batch);
    if (!body || body.byteLength <= KEEPALIVE_MAX_BYTES) return [batch];
    const half = Math.ceil(batch.length / 2);
    return [...this.keepaliveBatches(batch.slice(0, half)), ...this.keepaliveBatches(batch.slice(half))];
  }

  /** Page hidden or unloading: sends everything queued now, in keepalive-sized requests. */
  drainOnHide(): void {
    const send = exportWith<ReadableSpan>(this.exporter);
    for (const batch of this.keepaliveBatches(this.batcher.takeAll())) {
      // A throwing exporter rejects the promise (exportWith calls it inside the executor).
      void send(batch)
        .catch(() => false)
        .then((ok) => {
          if (ok) this.stats.exported += batch.length;
          else this.stats.exportFailures++;
        });
    }
  }

  async forceFlush(): Promise<void> {
    await this.batcher.flush();
    await this.exporter.forceFlush?.().catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.closed = true;
    await this.exporter.shutdown().catch(() => {});
  }
}
