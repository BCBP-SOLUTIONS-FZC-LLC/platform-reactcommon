// The span processor (design doc §C1 /tracing): ended, sampled spans go to the shared bounded
// Batcher (drops the oldest when full, at most two sends in flight), only with telemetry consent.
// Export failures are swallowed and counted: telemetry must never break the app. When the page is
// hidden (it may come back) the whole queue is flushed through the Batcher, two sends at a time,
// so nothing is lost; when it unloads, the newest spans that fit one keepalive request are sent
// and the rest are counted as dropped.
import type { Context } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { hasConsent } from '../core/index.ts';
import { Batcher, exportWith, type BatcherStats } from '../internal/batcher.ts';

export interface TracingStats extends BatcherStats {
  /** Spans dropped because telemetry consent was not granted when they ended. */
  droppedNoConsent: number;
  /** Spans still queued at unload (pagehide) that did not fit the one keepalive request sent then. */
  droppedOnUnload: number;
}

export interface QueueOptions {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000 };

/**
 * keepalive fetch bodies are limited to 64 KiB in total per page, and the OTLP exporter drops
 * keepalive (so an unload cancels the request) once that budget would be exceeded: the request
 * sent on unload stays under it.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

/** The Batcher's concurrent sends. */
export const MAX_IN_FLIGHT = 2;

/**
 * The exporter's concurrencyLimit: the Batcher's sends plus the one unload request, which may
 * start while a page-hidden flush still has both of its sends pending (visibilitychange fires
 * before pagehide). The OTLP exporter fails an export at once beyond its limit.
 */
export const EXPORTER_CONCURRENCY = MAX_IN_FLIGHT + 1;

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
      maxInFlight: MAX_IN_FLIGHT,
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

  /** The longest run of the newest spans in `queue` whose OTLP JSON body fits KEEPALIVE_MAX_BYTES. */
  private newestThatFit(queue: ReadableSpan[]): ReadableSpan[] {
    const fits = (n: number) => {
      try {
        return (JsonTraceSerializer.serializeRequest(queue.slice(queue.length - n))?.byteLength ?? Infinity) <= KEEPALIVE_MAX_BYTES;
      } catch {
        return false; // the exporter could not send it either; never throw from a pagehide listener
      }
    };
    // The body grows with n: double n until it no longer fits, then binary search. Each probe
    // serialises at most about twice the budget, not the whole queue (up to 2048 spans).
    let lo = 0;
    let hi = 1;
    while (hi <= queue.length && fits(hi)) {
      lo = hi;
      hi *= 2;
    }
    hi = Math.min(hi - 1, queue.length);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return queue.slice(queue.length - lo);
  }

  /** Page hidden (it may come back): sends the whole queue, MAX_IN_FLIGHT requests at a time. */
  flushOnHidden(): void {
    void this.batcher.flush();
  }

  /**
   * Page unloading (pagehide): only a keepalive request outlives the page, and the browser's
   * keepalive budget is 64 KiB per page, so one request carries the newest queued spans that fit
   * (newest first, as the queue drops the oldest when it is full: the last interactions before the
   * user left matter most) and the rest are counted in droppedOnUnload.
   */
  drainOnUnload(): void {
    const queue = this.batcher.takeAll();
    const batch = this.newestThatFit(queue);
    this.stats.droppedOnUnload += queue.length - batch.length;
    if (batch.length === 0) return;
    // A throwing exporter rejects the promise (exportWith calls it inside the executor).
    void exportWith<ReadableSpan>(this.exporter)(batch)
      .catch(() => false)
      .then((ok) => {
        if (ok) this.stats.exported += batch.length;
        else this.stats.exportFailures++;
      });
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
