// A batch span processor with a bounded queue that drops the OLDEST spans when full (design doc
// §C1 /tracing; OTel's BatchSpanProcessor drops the newest). Ended spans are exported only with
// telemetry consent. Export failures are swallowed and counted: telemetry must never break the app.
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace';
import { hasConsent } from '../core/index.ts';

export interface TracingStats {
  /** Spans handed to the exporter successfully. */
  exported: number;
  /** Spans dropped because the queue was full (the oldest ones). */
  droppedQueueFull: number;
  /** Spans dropped because telemetry consent was not granted when they ended. */
  droppedNoConsent: number;
  /** Batches the exporter failed to send (their spans are lost). */
  exportFailures: number;
}

export interface QueueOptions {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
}

export const DEFAULT_QUEUE: QueueOptions = { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 5000 };

const SUCCESS = 0; // ExportResultCode.SUCCESS

export class DropOldestBatchSpanProcessor implements SpanProcessor {
  private queue: ReadableSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly exporter: SpanExporter,
    readonly stats: TracingStats,
    private readonly opts: QueueOptions = DEFAULT_QUEUE,
  ) {}

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (this.closed || !span.spanContext().traceFlags) return; // not sampled
    if (!hasConsent('telemetry')) {
      this.stats.droppedNoConsent++;
      return;
    }
    this.queue.push(span);
    if (this.queue.length > this.opts.maxQueueSize) {
      this.queue.shift();
      this.stats.droppedQueueFull++;
    }
    if (this.queue.length >= this.opts.maxExportBatchSize) this.exportBatch();
    else this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flushQueued();
    }, this.opts.scheduledDelayMillis);
  }

  /** Exports up to one batch now. */
  private exportBatch(): void {
    const batch = this.queue.splice(0, this.opts.maxExportBatchSize);
    if (batch.length === 0) return;
    const done = new Promise<void>((resolve) => {
      try {
        this.exporter.export(batch, (result) => {
          if (result.code === SUCCESS) this.stats.exported += batch.length;
          else this.stats.exportFailures++;
          resolve();
        });
      } catch {
        this.stats.exportFailures++;
        resolve();
      }
    });
    this.inFlight.add(done);
    void done.then(() => this.inFlight.delete(done));
  }

  private flushQueued(): void {
    while (this.queue.length > 0) this.exportBatch();
  }

  async forceFlush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flushQueued();
    await Promise.all([...this.inFlight]);
    await this.exporter.forceFlush?.().catch(() => {});
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.closed = true;
    await this.exporter.shutdown().catch(() => {});
  }
}
