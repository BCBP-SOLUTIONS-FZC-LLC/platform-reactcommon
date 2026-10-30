import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotInitializedError, getSessionId, initializeCore, setConsentProvider, type ConsentCategory } from '../../src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { getLogger, initializeLogging, serializeError, setRouteTemplate } from '../../src/logging/index.ts';
import { loggingStats, setLoggingInternalsForTests, shutdownLogging } from '../../src/logging/logging.ts';
import { cleanString, scrubSecrets } from '../../src/logging/redact.ts';
import { initializeTracing, shutdownTracing, withSpan } from '../../src/tracing/index.ts';
import { setTracingInternalsForTests } from '../../src/tracing/tracing.ts';

let records: ReadableLogRecord[];
let exportedUrl: string | undefined;
const exporter: LogRecordExporter = {
  export: (batch, cb) => {
    records.push(...batch);
    cb({ code: 0 });
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};

const consent = (granted: ConsentCategory[]) => setConsentProvider({ has: (c) => granted.includes(c), subscribe: () => () => {} });
const core = (environment = 'prod') => initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment, buildVersion: '1.2.3' });
const start = (o: Partial<Parameters<typeof initializeLogging>[0]> = {}) => initializeLogging({ otlpBaseUrl: '/otel', level: 'debug', ...o });
const sent = async () => {
  await shutdownLogging();
  return records;
};
const attrsOf = (r: ReadableLogRecord) => r.attributes as Record<string, unknown>;
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

beforeEach(() => {
  resetRuntimeForTests();
  records = [];
  exportedUrl = undefined;
  setLoggingInternalsForTests({
    exporter: (url) => {
      exportedUrl = url;
      return exporter;
    },
  });
  core();
  consent(['telemetry']);
});

afterEach(async () => {
  await shutdownLogging();
  await shutdownTracing();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('initializeLogging', () => {
  it('requires initializeCore and validates its options', async () => {
    resetRuntimeForTests();
    expect(() => start()).toThrow(NotInitializedError);
    core();
    expect(() => start({ otlpBaseUrl: 'https://collector.example' })).toThrow(TypeError);
    expect(() => start({ batchSize: 0 })).toThrow(RangeError);
    expect(() => start({ flushMs: 10 })).toThrow(RangeError);
    expect(() => start({ level: 'trace' as never })).toThrow(RangeError);
  });

  it('sends OTLP log records with gincommon resource attributes to <otlpBaseUrl>/v1/logs', async () => {
    start();
    getLogger().info('hello');
    const [r] = await sent();
    expect(exportedUrl).toBe('http://localhost/otel/v1/logs');
    expect(r!.body).toBe('hello');
    expect(r!.severityText).toBe('INFO');
    expect(r!.severityNumber).toBe(9);
    expect(r!.resource.attributes).toMatchObject({
      'service.name': 'web-app',
      'service.version': '1.2.3',
      'service.namespace': 'tender_management',
      'deployment.environment.name': 'prod',
    });
    expect(r!.resource.attributes['service.instance.id']).toBeUndefined();
  });

  it('starts sending through loggers obtained before it, and is a no-op the second time', async () => {
    const early = getLogger({ mfe: 'tenders' });
    early.info('dropped: not started');
    start();
    start({ level: 'error' });
    early.info('sent');
    expect((await sent()).map((r) => r.body)).toEqual(['sent']);
  });
});

describe('envelope', () => {
  it('carries session_id, mfe, page_route and, inside a span, trace_id and span_id', async () => {
    setTracingInternalsForTests({ exporter: () => ({ export: (_s, cb) => cb({ code: 0 }), shutdown: async () => {} }) });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    start();
    setRouteTemplate('/tenders/:id');
    let traceId = '';
    let spanId = '';
    await withSpan('op', (s) => {
      traceId = s.traceId;
      spanId = s.spanId;
      getLogger({ mfe: 'tenders' }).info('in span', { request_id: 'req-1' });
    });
    getLogger().info('outside');
    const [inSpan, outside] = await sent();
    expect(attrsOf(inSpan!)).toEqual({
      trace_id: traceId,
      span_id: spanId,
      request_id: 'req-1',
      session_id: getSessionId(),
      mfe: 'tenders',
      page_route: '/tenders/:id',
    });
    expect(inSpan!.spanContext?.traceId).toBe(traceId); // also the record's native trace id
    expect(attrsOf(outside!)).toEqual({ session_id: getSessionId(), mfe: 'shell', page_route: '/tenders/:id' });
  });

  it("drops caller attributes that would overwrite the envelope", async () => {
    start();
    getLogger({ mfe: 'tenders' }).info('x', { trace_id: 'forged', session_id: 'forged', mfe: 'forged', page_route: '/forged', ok: 1 });
    const [r] = await sent();
    expect(attrsOf(r!)).toMatchObject({ mfe: 'tenders', page_route: 'unknown', ok: 1 });
    expect(attrsOf(r!).trace_id).toBeUndefined();
    expect(attrsOf(r!).session_id).toBe(getSessionId());
  });

  it('adds child scope attributes', async () => {
    start();
    getLogger({ mfe: 'tenders' }).child({ feature: 'bids' }).child({ step: 'submit' }).warn('x', { essential: true });
    expect(attrsOf((await sent())[0]!)).toMatchObject({ mfe: 'tenders', feature: 'bids', step: 'submit' });
  });
});

describe('redaction (sanitizeFields, then strings, then JWT/Bearer, then the message)', () => {
  it('redacts sensitive keys at any depth and cleans every string', async () => {
    start();
    getLogger().info(`line1\nline2 Bearer ${JWT}`, {
      password: 'p',
      user: { name: 'a\u0000b', api_key: 'k', notes: [`see ${JWT}`, 'Authorization: bearer abc.def'] },
      when: new Date(0),
      big: 10n,
      fn: () => 1,
      missing: undefined,
      inf: Number.POSITIVE_INFINITY,
    });
    const [r] = await sent();
    expect(r!.body).toBe('line1line2 Bearer [REDACTED]');
    expect(attrsOf(r!)).toMatchObject({
      password: '[REDACTED]',
      user: { name: 'ab', api_key: '[REDACTED]', notes: ['see [REDACTED]', 'Authorization: bearer [REDACTED]'] },
      when: '1970-01-01T00:00:00.000Z',
      big: '10',
      inf: 'Infinity',
    });
    expect(attrsOf(r!)).not.toHaveProperty('fn');
    expect(attrsOf(r!)).not.toHaveProperty('missing');
  });

  it('redacts sensitive keys inside class instances, which sanitizeFields passes through', async () => {
    class Creds {
      user = 'u';
      password = 'hunter2';
      nested = { access_token: 'tok' };
    }
    start();
    getLogger().info('x', { c: new Creds(), list: [new Creds()] });
    const [r] = await sent();
    const redacted = { user: 'u', password: '[REDACTED]', nested: { access_token: '[REDACTED]' } };
    expect(attrsOf(r!)).toMatchObject({ c: redacted, list: [redacted] });
    expect(JSON.stringify(attrsOf(r!))).not.toMatch(/hunter2|tok"/);
  });

  it('catches a JWT cut short by the 256-byte limit', () => {
    const long = `${'x'.repeat(200)} ${JWT}`;
    expect(cleanString(long)).not.toContain('eyJ');
    expect(scrubSecrets('token eyJhbGciOiJIUzI1NiJ9.')).toBe('token [REDACTED]');
    expect(scrubSecrets('eyJ alone is fine')).toBe('eyJ alone is fine');
  });

  it('keeps booleans and null, serialises nested errors and invalid dates, and replaces cycles through class instances', async () => {
    start();
    class Node {
      name = 'n';
      next: Node | undefined;
    }
    const node = new Node();
    node.next = node;
    const cause = new Error(`refresh failed: Bearer ${JWT}`);
    cause.stack = `Error: refresh failed\n    at https://app.example/x.js?token=abc:1:2`;
    getLogger().info('x', { cause, list: [new TypeError('bad'), undefined], when: new Date(Number.NaN), node, ok: false, none: null });
    const a = attrsOf((await sent())[0]!);
    expect(a.cause).toEqual({ name: 'Error', message: 'refresh failed: Bearer [REDACTED]', stack: 'Error: refresh failed\n    at https://app.example/x.js:1:2' });
    expect(a.list).toMatchObject([{ name: 'TypeError', message: 'bad' }, null]); // undefined in an array keeps its slot
    expect(a.ok).toBe(false);
    expect(a.none).toBeNull();
    expect(a.when).toBe('Invalid Date');
    expect(a.node).toEqual({ name: 'n', next: '[Circular]' });
  });

  it('replaces cycles', async () => {
    start();
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    getLogger().info('x', { a });
    expect(attrsOf((await sent())[0]!).a).toEqual({ n: 1, self: '[Circular]' });
  });
});

describe('errors', () => {
  it('serialise into exception.* attributes, with URL query strings stripped from the stack', async () => {
    start();
    const err = new TypeError(`token ${JWT} rejected`);
    err.stack = `TypeError: x\n    at f (https://app.bcbpsolutions.com/assets/app.js?token=secret#frag:10:5)\n    at g (https://app.bcbpsolutions.com/x.js:1:1)`;
    getLogger().error('save failed', { error: err });
    const a = attrsOf((await sent())[0]!);
    expect(a['exception.type']).toBe('TypeError');
    expect(a['exception.message']).toBe('token [REDACTED] rejected');
    expect(a['exception.stacktrace']).toBe(
      'TypeError: x\n    at f (https://app.bcbpsolutions.com/assets/app.js:10:5)\n    at g (https://app.bcbpsolutions.com/x.js:1:1)',
    );
    expect(a).not.toHaveProperty('error');
  });

  it('serializeError handles non-errors and caps the stack', () => {
    expect(serializeError('boom')).toEqual({ name: 'string', message: 'boom' });
    expect(serializeError({ code: 7 })).toEqual({ name: 'object', message: '{"code":7}' });
    expect(serializeError(null)).toEqual({ name: 'null', message: 'null' });
    expect(serializeError(undefined)).toEqual({ name: 'undefined', message: 'undefined' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeError(cyclic).message).toBe('[object Object]');
    const e = new Error('x');
    e.stack = 'a'.repeat(10_000);
    expect(new TextEncoder().encode(serializeError(e).stack!).length).toBe(4096);
    const noStack = new Error('y');
    noStack.stack = '';
    expect(serializeError(noStack)).toEqual({ name: 'Error', message: 'y' });
  });
});

describe('consent and level', () => {
  it('without telemetry consent sends only errors and essential warns, never the flag itself', async () => {
    consent([]);
    start();
    const log = getLogger();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.warn('csp violation', { essential: true, directive: 'script-src' });
    log.error('e');
    const stats = loggingStats()!;
    const out = await sent();
    expect(out.map((r) => r.body)).toEqual(['csp violation', 'e']);
    expect(attrsOf(out[0]!)).not.toHaveProperty('essential');
    expect(stats.droppedNoConsent).toBe(3);
  });

  it('with telemetry consent sends every level at or above the configured one', async () => {
    start({ level: 'warn' });
    const log = getLogger();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect((await sent()).map((r) => r.severityText)).toEqual(['WARN', 'ERROR']);
  });
});

describe('console fallback', () => {
  it('logs to the console in local/dev before and after init, never in other environments', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    getLogger().info('prod, before init');
    expect(info).not.toHaveBeenCalled();
    resetRuntimeForTests();
    core('dev');
    getLogger({ mfe: 'tenders' }).info(`dev with ${JWT}`);
    expect(info).toHaveBeenCalledWith('[tenders] dev with [REDACTED]', expect.objectContaining({ mfe: 'tenders' }));
    resetRuntimeForTests(); // no identity: a remote run standalone
    getLogger().info('standalone');
    expect(info).toHaveBeenCalledTimes(2);
  });
});

describe('setRouteTemplate', () => {
  it('sets page_route and records the template for /metrics', () => {
    setRouteTemplate('/tenders/:id');
    setRouteTemplate('/tenders/:id');
    setRouteTemplate('/dashboard');
    expect(getRuntime().pageRoute).toBe('/dashboard');
    expect([...getRuntime().routeTemplates]).toEqual(['/tenders/:id', '/dashboard']);
  });

  it("records anything that is not a template as 'unknown', without remembering it", () => {
    for (const bad of ['tenders', '/tenders?id=1', '/a b', 42 as unknown as string]) {
      setRouteTemplate(bad);
      expect(getRuntime().pageRoute).toBe('unknown');
    }
    setRouteTemplate('unknown');
    expect(getRuntime().routeTemplates.size).toBe(0);
  });

  it('remembers at most 1000 templates', () => {
    for (let i = 0; i < 1100; i++) setRouteTemplate(`/r${i}`);
    expect(getRuntime().routeTemplates.size).toBe(1000);
    expect(getRuntime().pageRoute).toBe('/r1099');
  });
});

describe('transport', () => {
  it('batches by batchSize', async () => {
    start({ batchSize: 2, flushMs: 60_000 });
    getLogger().info('a');
    expect(records).toEqual([]);
    getLogger().info('b');
    await vi.waitFor(() => expect(records.map((r) => r.body)).toEqual(['a', 'b']));
  });

  it('drains the queue with sendBeacon on pagehide, as OTLP JSON', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const beacons: { url: string; body: unknown }[] = [];
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string, data: Blob) => {
        beacons.push({ url, body: data });
        return true;
      },
    });
    start({ flushMs: 60_000 });
    getLogger().info('one');
    getLogger().warn('two', { essential: true });
    target.dispatchEvent(new Event('pagehide'));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.url).toBe('http://localhost/otel/v1/logs');
    const json = JSON.parse(await (beacons[0]!.body as Blob).text()) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] };
    expect(json.resourceLogs[0]!.scopeLogs[0]!.logRecords.map((r) => r.body.stringValue)).toEqual(['one', 'two']);
    expect(loggingStats()!.beacons).toBe(1);
    expect(records).toEqual([]); // nothing went through fetch
  });

  it('falls back to fetch when the browser refuses the beacon', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    vi.stubGlobal('navigator', { sendBeacon: () => false });
    start({ flushMs: 60_000 });
    getLogger().info('refused');
    target.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(records.map((r) => r.body)).toEqual(['refused']));
  });

  it('sends nothing by beacon when the queue is empty, and only when the page becomes hidden', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    start({ flushMs: 60_000 });
    target.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).not.toHaveBeenCalled(); // empty queue
    getLogger().info('queued');
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).not.toHaveBeenCalled(); // still visible
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(loggingStats()).toMatchObject({ beacons: 1, exported: 1 });
    await shutdownLogging();
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(sendBeacon).toHaveBeenCalledTimes(1); // listeners removed
    expect(records).toEqual([]);
  });

  it('falls back to fetch without sendBeacon, or when sendBeacon throws', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    vi.stubGlobal('navigator', {});
    start({ flushMs: 60_000 });
    getLogger().info('no-beacon');
    target.dispatchEvent(new Event('pagehide'));
    await vi.waitFor(() => expect(records.map((r) => r.body)).toEqual(['no-beacon']));

    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        throw new TypeError('Illegal invocation');
      },
    });
    getLogger().info('beacon-threw');
    expect(() => target.dispatchEvent(new Event('pagehide'))).not.toThrow();
    await vi.waitFor(() => expect(records.map((r) => r.body)).toEqual(['no-beacon', 'beacon-threw']));
    expect(loggingStats()!.beacons).toBe(0);
  });

  it('sends a single record over 60 KiB by fetch, not by beacon', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    start({ flushMs: 60_000 });
    // Each string is capped at 256 bytes, but not how many an array holds (OTel caps attributes at 128).
    getLogger().info('huge', { rows: Array.from({ length: 300 }, () => 'y'.repeat(250)) });
    target.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(records.map((r) => r.body)).toEqual(['huge']));
    expect(attrsOf(records[0]!).rows).toHaveLength(300);
    expect(loggingStats()!.beacons).toBe(0);
  });

  it('never rejects on shutdown when the exporter fails to flush or shut down', async () => {
    const rejecting: LogRecordExporter = {
      export: exporter.export,
      forceFlush: () => Promise.reject(new Error('flush failed')),
      shutdown: () => Promise.reject(new Error('shutdown failed')),
    };
    const throwing: LogRecordExporter = {
      export: exporter.export,
      forceFlush: () => {
        throw new Error('not a promise');
      },
      shutdown: async () => {},
    };
    for (const e of [rejecting, throwing]) {
      setLoggingInternalsForTests({ exporter: () => e });
      records = [];
      start();
      getLogger().info('delivered');
      await expect(shutdownLogging()).resolves.toBeUndefined();
      expect(records.map((r) => r.body)).toEqual(['delivered']);
      expect(loggingStats()).toBeUndefined();
    }
  });

  it('splits beacons over 60 KiB', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    let count = 0;
    vi.stubGlobal('navigator', {
      sendBeacon: (_url: string, data: Blob) => {
        expect(data.size).toBeLessThanOrEqual(60 * 1024);
        count++;
        return true;
      },
    });
    start({ flushMs: 60_000, batchSize: 512 });
    for (let i = 0; i < 400; i++) getLogger().info('x'.repeat(250), { i });
    target.dispatchEvent(new Event('pagehide'));
    expect(count).toBeGreaterThan(1);
    expect(loggingStats()!.exported).toBe(400);
  });
});
