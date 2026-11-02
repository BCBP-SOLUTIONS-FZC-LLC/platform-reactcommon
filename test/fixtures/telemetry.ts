// An in-memory OTLP collector for the integration and e2e suites: it takes the place of the three
// exporters through the SDK's test seams, so a suite asserts what would have left the page.
import { context as otelContext, trace } from '@opentelemetry/api';
import { vi } from 'vitest';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, type PushMetricExporter, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { setLoggingInternalsForTests, shutdownLogging } from '../../packages/frontend-sdk/src/logging/logging.ts';
import { setMetricsInternalsForTests, shutdownMetrics } from '../../packages/frontend-sdk/src/metrics/metrics.ts';
import { DEFAULT_QUEUE } from '../../packages/frontend-sdk/src/tracing/processor.ts';
import { setTracingInternalsForTests, shutdownTracing } from '../../packages/frontend-sdk/src/tracing/tracing.ts';

/** One exported log record, as the collector would index it. */
export interface CollectedLog {
  level: string;
  body: string;
  attributes: Record<string, unknown>;
}

/** One exported metric data point. */
export interface CollectedPoint {
  name: string;
  attributes: Record<string, unknown>;
  value: unknown;
}

export class Collector {
  readonly spans: ReadableSpan[] = [];
  private readonly records: ReadableLogRecord[] = [];
  private readonly metrics: ResourceMetrics[] = [];
  /** The collector URLs the SDK built an exporter for (one per signal that started). */
  readonly urls: string[] = [];

  /** Makes this collector the exporter of every signal the SDK starts from now on. */
  install(): this {
    const spanExporter: SpanExporter = {
      export: (batch, cb) => {
        this.spans.push(...batch);
        cb({ code: 0 });
      },
      shutdown: async () => {},
    };
    const logExporter: LogRecordExporter = {
      export: (batch, cb) => {
        this.records.push(...batch);
        cb({ code: 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
    // Unlike OTel's InMemoryMetricExporter, it keeps accepting after a shutdown: a page reload
    // (a new MeterProvider) exports into the same collector.
    const metricExporter: PushMetricExporter = {
      export: (rm, cb) => {
        this.metrics.push(rm);
        cb({ code: 0 });
      },
      forceFlush: async () => {},
      shutdown: async () => {},
      selectAggregationTemporality: () => AggregationTemporality.DELTA,
    };
    setTracingInternalsForTests({ exporter: (url) => (this.urls.push(url), spanExporter), queue: DEFAULT_QUEUE });
    setLoggingInternalsForTests({ exporter: (url) => (this.urls.push(url), logExporter) });
    setMetricsInternalsForTests({ exporter: (url) => (this.urls.push(url), metricExporter) });
    return this;
  }

  get logs(): CollectedLog[] {
    return this.records.map((r) => ({ level: String(r.severityText).toLowerCase(), body: String(r.body), attributes: { ...(r.attributes as Record<string, unknown>) } }));
  }

  points(name?: string): CollectedPoint[] {
    return this.metrics
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .filter((m) => name === undefined || m.descriptor.name === name)
      .flatMap((m) => m.dataPoints.map((p) => ({ name: m.descriptor.name, attributes: { ...p.attributes }, value: p.value })));
  }

  /** Everything that left the page, of any signal. */
  get exported(): number {
    return this.spans.length + this.records.length + this.points().length;
  }
}

/**
 * The page unloads: every signal flushes into its exporter and stops, and the OTel globals are freed
 * for the next page. Safe when a signal never started.
 */
export async function unloadTelemetry(): Promise<void> {
  await settled(shutdownTracing());
  await settled(shutdownLogging());
  await settled(shutdownMetrics());
  trace.disable();
  otelContext.disable();
}

/**
 * Awaits `p`, turning a fake clock's zero-delay timers and the event loop until it settles: the OTel
 * metric reader chains its export through both.
 */
export async function settled<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const tracked = p.finally(() => (done = true));
  for (let i = 0; i < 100 && !done; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
  }
  return tracked;
}
