// The span processor (design doc §C1 /tracing): ended, sampled spans go to the shared bounded
// Batcher (drops the oldest when full, at most two sends in flight), only with telemetry consent.
// Export failures are swallowed and counted: telemetry must never break the app.
import type { Context } from '@opentelemetry/api';
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
