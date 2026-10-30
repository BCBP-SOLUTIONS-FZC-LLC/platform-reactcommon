// Browser tracing (design doc §C1 /tracing): an OTel tracer provider with gincommon's resource
// attributes and sampler, exporting OTLP/HTTP to the same-origin collector path. Consumers never
// see OTel types: they get the SDK's Span and Tracer.
import {
  SpanStatusCode,
  context as otelContext,
  isSpanContextValid,
  trace,
  type Span as OtelSpan,
  type TextMapSetter,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { StackContextManager, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';
import { NotInitializedError, getIdentity, isSensitiveKey, sanitizeString } from '../core/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { DEFAULT_QUEUE, DropOldestBatchSpanProcessor, type QueueOptions, type TracingStats } from './processor.ts';
import { platformSampler } from './sampler.ts';

export interface TracingOptions {
  /** Same-origin path of the OTLP/HTTP collector, e.g. '/otel'; spans go to `${otlpBaseUrl}/v1/traces`. */
  otlpBaseUrl: string;
  /** Root sampling ratio; default 0.1. <= 0 never samples, >= 1 always does (as in Go). */
  sampleRatio?: number;
  /** Exact origins, besides the page's own, that receive traceparent/tracestate. */
  propagationAllowlist?: readonly string[];
}

/** A span. Attributes are redacted like log fields: a sensitive key's value is '[REDACTED]'. */
export interface Span {
  setAttribute(k: string, v: string | number | boolean): void;
  /** Marks the span as failed and records the error's type and (sanitised) message. */
  recordError(e: unknown): void;
  end(): void;
  /** 32 lower-hex, or '' for a span that is not recorded (before init, or not sampled and no parent). */
  readonly traceId: string;
  /** 16 lower-hex, or '' as for traceId. */
  readonly spanId: string;
}

export interface Tracer {
  startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span;
}

interface TracingState {
  provider: TracerProvider;
  contextManager: StackContextManager;
  processor: DropOldestBatchSpanProcessor;
  allowlist: ReadonlySet<string>;
  stats: TracingStats;
  removeListeners: () => void;
}

const SDK_SCOPE = '@platform/frontend-sdk';
const TRACE_HEADERS = ['traceparent', 'tracestate'] as const;
const propagator = new W3CTraceContextPropagator();
const headerSetter: TextMapSetter<Headers> = { set: (carrier, key, value) => carrier.set(key, value) };

// Test seam: tests replace the exporter and queue sizes; the shell never touches these.
let exporterFactory: (url: string) => SpanExporter = (url) =>
  new OTLPTraceExporter({ url, timeoutMillis: 10_000, concurrencyLimit: 2 });
let queueOptions: QueueOptions = DEFAULT_QUEUE;
export function setTracingInternalsForTests(o: { exporter?: (url: string) => SpanExporter; queue?: QueueOptions }): void {
  if (o.exporter) exporterFactory = o.exporter;
  if (o.queue) queueOptions = o.queue;
}

function state(): TracingState | undefined {
  return getRuntime().tracing as TracingState | undefined;
}

function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function assertOrigin(origin: string): string {
  if (!isExactOrigin(origin)) throw new TypeError(`propagationAllowlist entries must be exact origins, got ${JSON.stringify(origin)}`);
  return origin;
}

function collectorUrl(otlpBaseUrl: string): string {
  if (!/^\/(?!\/)[^\s?#\\]*$/.test(otlpBaseUrl)) {
    throw new TypeError(`otlpBaseUrl must be a same-origin path such as '/otel', got ${JSON.stringify(otlpBaseUrl)}`);
  }
  const base = globalThis.location?.href ?? 'http://localhost/';
  return new URL(`${otlpBaseUrl.replace(/\/$/, '')}/v1/traces`, base).href;
}

/**
 * Shell only: starts tracing. Requires initializeCore (the identity becomes the resource). A
 * second call is a no-op. Spans started earlier through getTracer() start recording now.
 */
export function initializeTracing(o: TracingOptions): void {
  const identity = getIdentity();
  if (!identity) throw new NotInitializedError('initializeTracing requires initializeCore first');
  if (state()) return;
  const ratio = o.sampleRatio ?? 0.1;
  if (typeof ratio !== 'number' || Number.isNaN(ratio)) throw new RangeError(`sampleRatio must be a number, got ${ratio}`);
  const url = collectorUrl(o.otlpBaseUrl);
  const allowlist = new Set((o.propagationAllowlist ?? []).map(assertOrigin));

  const stats: TracingStats = { exported: 0, droppedQueueFull: 0, droppedNoConsent: 0, exportFailures: 0 };
  const processor = new DropOldestBatchSpanProcessor(exporterFactory(url), stats, queueOptions);
  const provider = new TracerProvider({
    // gincommon's resource (otel/setup.go). No service.instance.id: one per browser would explode cardinality.
    resource: resourceFromAttributes({
      'service.name': identity.serviceName,
      'service.version': identity.buildVersion,
      'service.namespace': identity.domain,
      'deployment.environment.name': identity.environment,
    }),
    sampler: platformSampler(ratio),
    spanProcessors: [processor],
  });
  const contextManager = new StackContextManager().enable();
  otelContext.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);

  // Flush when the page is hidden or unloaded: the exporter's fetch uses keepalive.
  const flush = () => void processor.forceFlush();
  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') flush();
  };
  globalThis.addEventListener?.('pagehide', flush);
  globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
  const removeListeners = () => {
    globalThis.removeEventListener?.('pagehide', flush);
    globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
  };

  getRuntime().tracing = { provider, contextManager, processor, allowlist, stats, removeListeners } satisfies TracingState;
}

/** Flushes and stops tracing; getTracer() falls back to no-op spans. */
export async function shutdownTracing(): Promise<void> {
  const s = state();
  if (!s) return;
  getRuntime().tracing = undefined;
  s.removeListeners();
  await s.provider.shutdown().catch(() => {});
  trace.disable();
  otelContext.disable();
}

/** Internal: counters for exports, drops and failures (logged by /logging, asserted by tests). */
export function tracingStats(): Readonly<TracingStats> | undefined {
  return state()?.stats;
}

function safeAttribute(k: string, v: string | number | boolean): string | number | boolean {
  if (isSensitiveKey(k)) return '[REDACTED]';
  return typeof v === 'string' ? sanitizeString(v) : v;
}

function safeAttributes(attrs?: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs ?? {})) out[k] = safeAttribute(k, v);
  return out;
}

class SdkSpan implements Span {
  constructor(readonly inner: OtelSpan) {}

  setAttribute(k: string, v: string | number | boolean): void {
    this.inner.setAttribute(k, safeAttribute(k, v));
  }

  recordError(e: unknown): void {
    const name = e instanceof Error ? e.name : typeof e;
    const message = sanitizeString(e instanceof Error ? e.message : String(e));
    this.inner.recordException({ name, message });
    this.inner.setStatus({ code: SpanStatusCode.ERROR, message });
  }

  end(): void {
    this.inner.end();
  }

  get traceId(): string {
    const c = this.inner.spanContext();
    return isSpanContextValid(c) ? c.traceId : '';
  }

  get spanId(): string {
    const c = this.inner.spanContext();
    return isSpanContextValid(c) ? c.spanId : '';
  }
}

/** A tracer for `scope` (instrumentation scope). Before initializeTracing its spans are no-ops. */
export function getTracer(scope: string): Tracer {
  const inner = trace.getTracer(scope);
  return {
    startSpan: (name, attrs) => new SdkSpan(inner.startSpan(name, { attributes: safeAttributes(attrs) })),
  };
}

/**
 * Runs `fn` in a new span that is ended when `fn` settles; a thrown error is recorded on the span
 * and rethrown. The span is the active one while `fn` runs synchronously (the browser has no
 * async context propagation), so start child spans and inject headers before the first await.
 */
export async function withSpan<T>(
  name: string,
  fn: (s: Span) => T | Promise<T>,
  attrs?: Record<string, string | number | boolean>,
): Promise<T> {
  const span = getTracer(SDK_SCOPE).startSpan(name, attrs) as SdkSpan;
  try {
    return await otelContext.with(trace.setSpan(otelContext.active(), span.inner), () => fn(span));
  } catch (e) {
    span.recordError(e);
    throw e;
  } finally {
    span.end();
  }
}

/** The active span's trace id (32 lower-hex), or undefined when there is none or it is invalid. */
export function currentTraceId(): string | undefined {
  const c = trace.getActiveSpan()?.spanContext();
  return c && isSpanContextValid(c) ? c.traceId : undefined;
}

/**
 * Used by /http only: writes traceparent (and tracestate) for the active span, but only for the
 * page's own origin and the exact origins in the allowlist. For any other origin it removes them,
 * so no trace context (and never baggage) reaches a third party.
 */
export function injectTraceHeaders(url: URL, headers: Headers): void {
  const s = state();
  const sameOrigin = globalThis.location !== undefined && url.origin === globalThis.location.origin;
  if (!s || !(sameOrigin || s.allowlist.has(url.origin))) {
    for (const h of TRACE_HEADERS) headers.delete(h);
    return;
  }
  propagator.inject(otelContext.active(), headers, headerSetter);
}
