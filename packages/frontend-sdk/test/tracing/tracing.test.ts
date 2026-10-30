import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { SamplingDecision, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotInitializedError, initializeCore, setConsentProvider, type ConsentCategory } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { DEFAULT_QUEUE, DropOldestBatchSpanProcessor, KEEPALIVE_MAX_BYTES, type TracingStats } from '../../src/tracing/processor.ts';
import { GoTraceIdRatioSampler, goFormatG, platformSampler, rootSampler } from '../../src/tracing/sampler.ts';
import {
  currentTraceId,
  getTracer,
  initializeTracing,
  injectTraceHeaders,
  shutdownTracing,
  withSpan,
} from '../../src/tracing/index.ts';
import { setTracingInternalsForTests, tracingStats } from '../../src/tracing/tracing.ts';

const vectors = JSON.parse(readFileSync(join(import.meta.dirname, 'go-sampler-vectors.json'), 'utf8')) as {
  decisions: Record<string, Record<string, boolean>>;
};

/** Keeps every exported span, also after shutdown (OTel's InMemorySpanExporter clears them). */
let collected: ReadableSpan[];
const exporter: SpanExporter = {
  export: (batch, cb) => {
    collected.push(...batch);
    cb({ code: 0 });
  },
  shutdown: async () => {},
};
let exportedUrl: string | undefined;

const consent = (granted: ConsentCategory[]) =>
  setConsentProvider({ has: (c) => granted.includes(c), subscribe: () => () => {} });

function start(o: Partial<Parameters<typeof initializeTracing>[0]> = {}) {
  initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1, ...o });
}

const spans = (): ReadableSpan[] => collected;

beforeEach(() => {
  resetRuntimeForTests();
  collected = [];
  exportedUrl = undefined;
  setTracingInternalsForTests({
    exporter: (url) => {
      exportedUrl = url;
      return exporter;
    },
    queue: DEFAULT_QUEUE,
  });
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev', buildVersion: '1.2.3' });
  consent(['telemetry']);
});

afterEach(async () => {
  await shutdownTracing();
  vi.unstubAllGlobals();
});

describe('sampler (gincommon semantics)', () => {
  it.each(Object.entries(vectors.decisions))("agrees with Go's TraceIDRatioBased(%s) on every trace id", (ratio, ids) => {
    const sampler = new GoTraceIdRatioSampler(Number(ratio));
    for (const [traceId, sampled] of Object.entries(ids)) {
      const d = sampler.shouldSample(ROOT_CONTEXT, traceId).decision;
      expect(d === SamplingDecision.RECORD_AND_SAMPLED, `${ratio} ${traceId}`).toBe(sampled);
    }
  });

  it('uses AlwaysOn for >= 1 and AlwaysOff for <= 0, as Go does', () => {
    const id = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(rootSampler(1).shouldSample(ROOT_CONTEXT, id, 'x', 0, {}, []).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(rootSampler(7).shouldSample(ROOT_CONTEXT, id, 'x', 0, {}, []).decision).toBe(SamplingDecision.RECORD_AND_SAMPLED);
    expect(rootSampler(0).shouldSample(ROOT_CONTEXT, id, 'x', 0, {}, []).decision).toBe(SamplingDecision.NOT_RECORD);
    expect(rootSampler(-1).shouldSample(ROOT_CONTEXT, id, 'x', 0, {}, []).decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it("describes itself as Go's TraceIDRatioBased{<fraction>} and is the root sampler for 0 < ratio < 1", () => {
    // Go: fmt.Sprintf("TraceIDRatioBased{%g}", fraction); below 1e-4 %g switches to 1e-05 form.
    for (const [ratio, text] of [
      [0.1, 'TraceIDRatioBased{0.1}'],
      [0.25, 'TraceIDRatioBased{0.25}'],
      [0.5, 'TraceIDRatioBased{0.5}'],
      [0.001, 'TraceIDRatioBased{0.001}'],
      [0.0001, 'TraceIDRatioBased{0.0001}'],
      [0.00001, 'TraceIDRatioBased{1e-05}'],
      [1.5e-7, 'TraceIDRatioBased{1.5e-07}'],
      [1e-7, 'TraceIDRatioBased{1e-07}'],
    ] as const) {
      const root = rootSampler(ratio);
      expect(root).toBeInstanceOf(GoTraceIdRatioSampler);
      expect(root.toString()).toBe(text);
      expect(platformSampler(ratio).toString()).toContain(`root=${text}`);
    }
    expect(rootSampler(1).toString()).toBe('AlwaysOnSampler');
    expect(rootSampler(0).toString()).toBe('AlwaysOffSampler');
  });

  it("formats numbers like Go's %g", () => {
    // Go: fmt.Sprintf("%g", f) for each input.
    for (const [f, text] of [
      [1, '1'],
      [0.1, '0.1'],
      [0.25, '0.25'],
      [0.001, '0.001'],
      [0.0001, '0.0001'],
      [0.00001, '1e-05'],
      [1e-7, '1e-07'],
      [1.25e-10, '1.25e-10'],
      [123456, '123456'],
      [1234567, '1.234567e+06'],
      [1e21, '1e+21'],
      [2.5e100, '2.5e+100'],
      [-0.00001, '-1e-05'],
      [0, '0'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, '+Inf'],
    ] as const) {
      expect(goFormatG(f), String(f)).toBe(text);
    }
    expect(new GoTraceIdRatioSampler(1).toString()).toBe('TraceIDRatioBased{1}');
  });

  it('never samples a malformed trace id', () => {
    expect(new GoTraceIdRatioSampler(0.999).shouldSample(ROOT_CONTEXT, 'not-hex').decision).toBe(SamplingDecision.NOT_RECORD);
  });

  it('records nothing at ratio 0 and follows the parent for children', async () => {
    await shutdownTracing();
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
    consent(['telemetry']);
    start({ sampleRatio: 0 });
    await withSpan('root', () => withSpan('child', () => undefined));
    await shutdownTracing();
    expect(spans()).toHaveLength(0);
  });
});

describe('initializeTracing', () => {
  it('requires initializeCore', async () => {
    await shutdownTracing();
    resetRuntimeForTests();
    expect(() => start()).toThrow(NotInitializedError);
  });

  it('exports to <otlpBaseUrl>/v1/traces with gincommon resource attributes and no instance id', async () => {
    start();
    getTracer('test').startSpan('op').end();
    await shutdownTracing();
    expect(exportedUrl).toBe('http://localhost/otel/v1/traces');
    const attrs = spans()[0]!.resource.attributes;
    expect(attrs).toMatchObject({
      'service.name': 'web-app',
      'service.version': '1.2.3',
      'service.namespace': 'tender_management',
      'deployment.environment.name': 'dev',
    });
    expect(attrs['service.instance.id']).toBeUndefined();
  });

  it('validates its options', () => {
    expect(() => start({ otlpBaseUrl: 'https://collector.example' })).toThrow(TypeError);
    expect(() => start({ otlpBaseUrl: '//collector.example' })).toThrow(TypeError);
    expect(() => start({ propagationAllowlist: ['https://api.example.com/'] })).toThrow(TypeError);
    expect(() => start({ sampleRatio: Number.NaN })).toThrow(RangeError);
  });

  it('is a no-op the second time', async () => {
    start();
    start({ sampleRatio: 0 });
    getTracer('t').startSpan('still-sampled').end();
    await shutdownTracing();
    expect(spans().map((s) => s.name)).toEqual(['still-sampled']);
  });

  it('turns tracers obtained before init into recording ones', async () => {
    const early = getTracer('early');
    const before = early.startSpan('before');
    expect(before.traceId).toBe('');
    before.end();
    start();
    const after = early.startSpan('after');
    expect(after.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(after.spanId).toMatch(/^[0-9a-f]{16}$/);
    after.end();
    await shutdownTracing();
    expect(spans().map((s) => s.name)).toEqual(['after']);
  });

  it('stops recording after shutdown', async () => {
    start();
    await shutdownTracing();
    expect(getTracer('t').startSpan('x').traceId).toBe('');
    expect(tracingStats()).toBeUndefined();
  });

  it('flushes on pagehide', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    start();
    getTracer('t').startSpan('queued').end();
    expect(spans()).toHaveLength(0); // waiting for the 5 s batch timer
    target.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(spans().map((s) => s.name)).toEqual(['queued']));
  });
});

describe('export queue', () => {
  it('flushes when the page becomes hidden, not while visible, and stops listening after shutdown', async () => {
    const win = new EventTarget();
    vi.stubGlobal('addEventListener', win.addEventListener.bind(win));
    vi.stubGlobal('removeEventListener', win.removeEventListener.bind(win));
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    start();
    getTracer('t').startSpan('queued').end();
    doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(spans()).toHaveLength(0); // still visible: waiting for the 5 s batch timer
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(spans().map((s) => s.name)).toEqual(['queued']));
    const stats = tracingStats()!;
    await vi.waitFor(() => expect(stats.exported).toBe(1));
    await shutdownTracing();
    getTracer('t').startSpan('after').end(); // a no-op span: nothing is queued anywhere
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
    expect(spans().map((s) => s.name)).toEqual(['queued']);
  });

  it('on page hide sends the queue in several requests that each fit the keepalive budget', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const batches: ReadableSpan[][] = [];
    setTracingInternalsForTests({ exporter: () => ({ ...exporter, export: (b, cb) => (batches.push(b), exporter.export(b, cb)) }) });
    start();
    const filler = 'x'.repeat(200);
    for (let i = 0; i < 300; i++) getTracer('t').startSpan(`s${i}`, { a: filler, b: filler, c: filler, d: filler }).end();
    expect(batches).toHaveLength(0); // under the 512-span batch size: waiting for the timer
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(spans()).toHaveLength(300));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(JsonTraceSerializer.serializeRequest(b)!.byteLength).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(spans().map((s) => s.name)).toEqual(Array.from({ length: 300 }, (_, i) => `s${i}`));
    await vi.waitFor(() => expect(tracingStats()).toMatchObject({ exported: 300, exportFailures: 0 }));
  });

  it('on page hide counts a refused or throwing export as a failure', () => {
    const stats: TracingStats = { exported: 0, droppedQueueFull: 0, droppedNoConsent: 0, exportFailures: 0 };
    const sampled = { name: 's', spanContext: () => ({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags: 1 }) };
    for (const e of [
      { export: (_b: unknown, cb: (r: { code: number }) => void) => cb({ code: 1 }), shutdown: async () => {} },
      { export: () => { throw new Error('boom'); }, shutdown: async () => {} },
    ]) {
      const processor = new DropOldestBatchSpanProcessor(e as SpanExporter, stats, { maxQueueSize: 10, maxExportBatchSize: 10, scheduledDelayMillis: 60_000 });
      processor.onEnd(sampled as unknown as ReadableSpan);
      processor.drainOnHide();
    }
    return vi.waitFor(() => expect(stats).toMatchObject({ exported: 0, exportFailures: 2 }));
  });

  it('never rejects on shutdown when the exporter fails to flush or shut down', async () => {
    const rejecting: SpanExporter = {
      export: exporter.export,
      forceFlush: () => Promise.reject(new Error('flush failed')),
      shutdown: () => Promise.reject(new Error('shutdown failed')),
    };
    const throwing: SpanExporter = {
      export: exporter.export,
      forceFlush: () => {
        throw new Error('not a promise');
      },
      shutdown: async () => {},
    };
    for (const e of [rejecting, throwing]) {
      setTracingInternalsForTests({ exporter: () => e });
      collected = [];
      start();
      getTracer('t').startSpan('delivered').end();
      await expect(shutdownTracing()).resolves.toBeUndefined();
      expect(spans().map((s) => s.name)).toEqual(['delivered']);
      expect(tracingStats()).toBeUndefined();
      expect(getTracer('t').startSpan('after').traceId).toBe(''); // tracing is off even though the exporter failed
    }
  });

  it('does not export a span that ends after shutdown', async () => {
    start();
    const open = getTracer('t').startSpan('open');
    const stats = tracingStats()!;
    await shutdownTracing();
    open.end();
    await Promise.resolve();
    expect(spans()).toEqual([]);
    expect(stats).toEqual({ exported: 0, droppedQueueFull: 0, droppedNoConsent: 0, exportFailures: 0 });
  });

  it('ignores ended spans that are recorded but not sampled', async () => {
    const stats: TracingStats = { exported: 0, droppedQueueFull: 0, droppedNoConsent: 0, exportFailures: 0 };
    const processor = new DropOldestBatchSpanProcessor(exporter, stats, { maxQueueSize: 10, maxExportBatchSize: 1, scheduledDelayMillis: 60_000 });
    const span = (name: string, traceFlags: number) =>
      ({ name, spanContext: () => ({ traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', traceFlags }) }) as unknown as ReadableSpan;
    processor.onEnd(span('record-only', 0));
    processor.onEnd(span('sampled', 1));
    await processor.shutdown();
    expect(spans().map((s) => s.name)).toEqual(['sampled']);
    expect(stats).toEqual({ exported: 1, droppedQueueFull: 0, droppedNoConsent: 0, exportFailures: 0 });
  });

  it('exports only with telemetry consent', async () => {
    consent([]);
    start();
    getTracer('t').startSpan('no-consent').end();
    consent(['telemetry']);
    getTracer('t').startSpan('consented').end();
    const stats = tracingStats()!;
    await shutdownTracing();
    expect(spans().map((s) => s.name)).toEqual(['consented']);
    expect(stats.droppedNoConsent).toBe(1);
  });

  it('drops the oldest spans when the queue is full', async () => {
    setTracingInternalsForTests({ queue: { maxQueueSize: 3, maxExportBatchSize: 100, scheduledDelayMillis: 60_000 } });
    start();
    for (const n of ['s1', 's2', 's3', 's4', 's5']) getTracer('t').startSpan(n).end();
    const stats = tracingStats()!;
    await shutdownTracing();
    expect(spans().map((s) => s.name)).toEqual(['s3', 's4', 's5']);
    expect(stats.droppedQueueFull).toBe(2);
    expect(stats.exported).toBe(3);
  });

  it('exports a full batch right away', async () => {
    setTracingInternalsForTests({ queue: { maxQueueSize: 10, maxExportBatchSize: 2, scheduledDelayMillis: 60_000 } });
    start();
    getTracer('t').startSpan('a').end();
    getTracer('t').startSpan('b').end();
    await vi.waitFor(() => expect(spans()).toHaveLength(2));
  });

  it('swallows and counts export failures', async () => {
    const failing: SpanExporter = {
      export: (_spans, cb) => cb({ code: 1, error: new Error('collector down') }),
      shutdown: async () => {},
    };
    const throwing: SpanExporter = {
      export: () => {
        throw new Error('boom');
      },
      shutdown: async () => {},
    };
    for (const e of [failing, throwing]) {
      setTracingInternalsForTests({ exporter: () => e });
      resetRuntimeForTests();
      initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
      consent(['telemetry']);
      start();
      getTracer('t').startSpan('lost').end();
      const stats = tracingStats()!;
      await expect(shutdownTracing()).resolves.toBeUndefined();
      expect(stats.exportFailures).toBe(1);
    }
  });
});

describe('spans', () => {
  it('redact sensitive attributes and sanitise strings, at start and later', async () => {
    start();
    const s = getTracer('t').startSpan('op', { route: '/tenders/:id', api_key: 'k', note: 'a\nb' });
    s.setAttribute('session_id', 'abc');
    s.setAttribute('count', 3);
    s.end();
    await shutdownTracing();
    expect(spans()[0]!.attributes).toEqual({ route: '/tenders/:id', api_key: '[REDACTED]', note: 'ab', session_id: '[REDACTED]', count: 3 });
  });

  it('record errors with a sanitised message and an error status', async () => {
    start();
    const s = getTracer('t').startSpan('op');
    s.recordError(new TypeError('bad\r\ninput'));
    s.recordError('plain string');
    s.end();
    await shutdownTracing();
    const span = spans()[0]!;
    expect(span.status).toEqual({ code: 2, message: 'plain string' });
    expect(span.events.map((e) => e.attributes)).toEqual([
      expect.objectContaining({ 'exception.type': 'TypeError', 'exception.message': 'badinput' }),
      expect.objectContaining({ 'exception.type': 'string', 'exception.message': 'plain string' }),
    ]);
  });

  it('scrub JWT and Bearer credentials from attribute values and error messages, as logs do', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    start();
    const s = getTracer('t').startSpan('op', { note: `got ${jwt}` });
    s.setAttribute('header', 'Bearer abc.def-ghi');
    s.recordError(new Error(`token ${jwt} rejected`));
    s.end();
    await shutdownTracing();
    const span = spans()[0]!;
    expect(span.attributes).toEqual({ note: 'got [REDACTED]', header: 'Bearer [REDACTED]' });
    expect(span.status).toEqual({ code: 2, message: 'token [REDACTED] rejected' });
    expect(span.events[0]!.attributes).toMatchObject({ 'exception.message': 'token [REDACTED] rejected' });
  });
});

describe('withSpan and currentTraceId', () => {
  it('makes the span active while fn runs synchronously, then ends it', async () => {
    start();
    expect(currentTraceId()).toBeUndefined();
    let inside: string | undefined;
    let child: string | undefined;
    const result = await withSpan('outer', (s) => {
      inside = currentTraceId();
      expect(inside).toBe(s.traceId);
      child = getTracer('t').startSpan('child').traceId;
      return 42;
    });
    expect(result).toBe(42);
    expect(child).toBe(inside);
    expect(currentTraceId()).toBeUndefined();
    await shutdownTracing();
    expect(spans().map((s) => s.name).sort()).toEqual(['outer']);
  });

  it('records a thrown error, ends the span and rethrows', async () => {
    start();
    const err = new Error('nope');
    await expect(withSpan('failing', async () => Promise.reject(err))).rejects.toBe(err);
    await shutdownTracing();
    expect(spans()[0]!.status.code).toBe(2);
  });

  it('works as a plain call before tracing starts', async () => {
    await expect(withSpan('early', () => 'ok')).resolves.toBe('ok');
  });
});

describe('injectTraceHeaders', () => {
  const traceparent = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

  beforeEach(() => vi.stubGlobal('location', new URL('https://app.bcbpsolutions.com/t/acme/')));

  it('writes traceparent for the page origin and allowlisted origins only', async () => {
    start({ propagationAllowlist: ['https://files.bcbpsolutions.com'] });
    await withSpan('call', () => {
      for (const target of ['https://app.bcbpsolutions.com/api/x', 'https://files.bcbpsolutions.com/up']) {
        const h = new Headers();
        injectTraceHeaders(new URL(target), h);
        expect(h.get('traceparent'), target).toMatch(traceparent);
        expect(h.get('baggage')).toBeNull();
      }
    });
  });

  it('removes trace headers for any other origin, including look-alikes', async () => {
    start({ propagationAllowlist: ['https://files.bcbpsolutions.com'] });
    await withSpan('call', () => {
      for (const target of ['https://evil.example/x', 'http://app.bcbpsolutions.com/api', 'https://files.bcbpsolutions.com:8443/x']) {
        const h = new Headers({ traceparent: '00-forged', tracestate: 'x=1' });
        injectTraceHeaders(new URL(target), h);
        expect(h.has('traceparent'), target).toBe(false);
        expect(h.has('tracestate'), target).toBe(false);
      }
    });
  });

  it('writes nothing without an active span, and nothing before init', async () => {
    const h = new Headers();
    injectTraceHeaders(new URL('https://app.bcbpsolutions.com/api'), h);
    expect(h.has('traceparent')).toBe(false);
    start();
    injectTraceHeaders(new URL('https://app.bcbpsolutions.com/api'), h);
    expect(h.has('traceparent')).toBe(false);
  });
});
