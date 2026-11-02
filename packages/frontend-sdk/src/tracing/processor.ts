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
 * The exporter's concurrencyLimit: the Batcher's sends, the page-hidden keepalive request and the
 * unload request, which may start while the hidden flush is still pending (visibilitychange fires
 * before pagehide). The OTLP exporter fails an export at once beyond its limit.
 */
export const EXPORTER_CONCURRENCY = MAX_IN_FLIGHT + 2;

export class DropOldestBatchSpanProcessor implements SpanProcessor {
  private readonly batcher: Batcher<ReadableSpan>;
  private closed = false;

  constructor(
    private readonly exporter: SpanExporter,
    readonly stats: TracingStats,
    opts: QueueOptions = DEFAULT_QUEUE,
    /** The collector's traces URL: on unload the spans go there directly (see drainOnUnload). */
    private readonly unloadUrl?: string,
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

  /** The longest run of the newest spans in `queue` whose OTLP JSON body fits `maxBytes`. */
  private newestThatFit(queue: ReadableSpan[], maxBytes = KEEPALIVE_MAX_BYTES): ReadableSpan[] {
    const fits = (n: number) => {
      try {
        return (JsonTraceSerializer.serializeRequest(queue.slice(queue.length - n))?.byteLength ?? Infinity) <= maxBytes;
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

  /**
   * Page hidden: it may come back, or be closing (visibilitychange fires before pagehide). The
   * newest spans that fit `budget` (what the page's keepalive budget has left, src/internal/unload.ts)
   * go first in one keepalive request, which outlives a closing tab; the rest are flushed MAX_IN_FLIGHT
   * requests at a time from the next task, which completes while the page stays. Returns the first
   * request's bytes.
   */
  flushOnHidden(budget: number = KEEPALIVE_MAX_BYTES): number {
    const queue = this.batcher.takeAll();
    const first = this.newestThatFit(queue, Math.min(budget, KEEPALIVE_MAX_BYTES));
    this.batcher.requeue(queue.slice(0, queue.length - first.length));
    let bytes: number;
    try {
      bytes = first.length > 0 ? (JsonTraceSerializer.serializeRequest(first)?.byteLength ?? 0) : 0;
    } catch {
      bytes = 0;
    }
    this.sendOne(first);
    // The rest a task later, after the metrics interval took its share of the keepalive budget (the
    // exporter sends with keepalive whenever its own count allows); a closing tab sends it on pagehide.
    setTimeout(() => void this.batcher.flush(), 0);
    return bytes;
  }

  /**
   * Page unloading (pagehide, through src/internal/unload.ts): only a keepalive request outlives the
   * page, within the `budget` the page's other senders left. One request carries the newest queued
   * spans that fit (the last interactions before the user left matter most); the rest are counted in
   * droppedOnUnload. The request starts here, synchronously, by sendBeacon (else fetch keepalive): the
   * OTLP exporter awaits its headers before fetch, a microtask a closing tab may never run (known browser
   * bug 2). Returns the body's bytes.
   */
  drainOnUnload(budget: number = KEEPALIVE_MAX_BYTES): number {
    const queue = this.batcher.takeAll();
    const batch = this.newestThatFit(queue, Math.min(budget, KEEPALIVE_MAX_BYTES));
    this.stats.droppedOnUnload += queue.length - batch.length;
    if (batch.length === 0) return 0;
    let body: Uint8Array | undefined;
    try {
      body = JsonTraceSerializer.serializeRequest(batch);
    } catch {
      body = undefined;
    }
    if (!body || !this.unloadUrl) {
      this.sendOne(batch); // no direct transport: the exporter, as best it can
      return body?.byteLength ?? 0;
    }
    // sendBeacon first: the unload transport browsers deliver most reliably (a closing Firefox or WebKit
    // tab lost about 1 keepalive fetch in 10, never a beacon). fetch keepalive where it is refused.
    try {
      if (globalThis.navigator?.sendBeacon?.(this.unloadUrl, new Blob([body as BlobPart], { type: 'application/json' }))) {
        this.stats.exported += batch.length;
        return body.byteLength;
      }
    } catch {
      // fall through to fetch
    }
    if (typeof globalThis.fetch !== 'function') {
      this.stats.exportFailures++;
      return 0;
    }
    let sent: Promise<Response>;
    try {
      sent = globalThis.fetch(this.unloadUrl, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body: body as BodyInit });
    } catch {
      this.stats.exportFailures++;
      return 0;
    }
    void sent.then(
      (res) => {
        if (res.ok) this.stats.exported += batch.length;
        else this.stats.exportFailures++;
      },
      () => this.stats.exportFailures++,
    );
    return body.byteLength;
  }

  /** One export outside the Batcher (a keepalive-sized batch), counted like the Batcher's. */
  private sendOne(batch: ReadableSpan[]): void {
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
