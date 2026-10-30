import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { SamplingDecision, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotInitializedError, initializeCore, setConsentProvider, type ConsentCategory } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { DEFAULT_QUEUE } from '../../src/tracing/processor.ts';
import { GoTraceIdRatioSampler, rootSampler } from '../../src/tracing/sampler.ts';
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
