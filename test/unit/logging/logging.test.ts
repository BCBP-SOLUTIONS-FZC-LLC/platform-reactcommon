import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigSchema, setRuntimeConfig } from '../../../packages/frontend-sdk/src/config/index.ts';
import { NotInitializedError, getSessionId, initializeCore, setConsentProvider, type ConsentCategory } from '../../../packages/frontend-sdk/src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { PAGE_KEEPALIVE_BYTES, keepaliveLeft } from '../../../packages/frontend-sdk/src/internal/unload.ts';
import { getLogger, initializeLogging, serializeError, setRouteTemplate } from '../../../packages/frontend-sdk/src/logging/index.ts';
import { loggingStats, setLoggingInternalsForTests, shutdownLogging } from '../../../packages/frontend-sdk/src/logging/logging.ts';
import { ATTRIBUTES_MAX_BYTES, cleanString, scrubSecrets } from '../../../packages/frontend-sdk/src/logging/redact.ts';
import { initializeTracing, shutdownTracing, withSpan } from '../../../packages/frontend-sdk/src/tracing/index.ts';
import { setTracingInternalsForTests } from '../../../packages/frontend-sdk/src/tracing/tracing.ts';

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
/** Sets the page's runtime config with telemetry.enabled = `enabled`. */
const telemetryConfig = (enabled: boolean) =>
  setRuntimeConfig(
    RuntimeConfigSchema.parse({
      api: { baseUrl: '/api' },
      telemetry: { enabled },
      auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
      remotes: { loadTimeoutMs: 10_000, retries: 0 },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
      appUpdate: { pollIntervalMs: 300_000 },
    }),
  );
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

  it('sends nothing at any level, and does not throw, when the runtime config turns telemetry off', async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    telemetryConfig(false);
    expect(() => start()).not.toThrow();
    expect(loggingStats()).toBeUndefined();
    const log = getLogger({ mfe: 'tenders' });
    log.debug('d');
    log.info('i');
    log.warn('essential', { essential: true });
    log.error('boom', { error: new Error('x') });
    globalThis.dispatchEvent?.(new Event('pagehide'));
    expect(await sent()).toEqual([]);
    expect(exportedUrl).toBeUndefined(); // no exporter was even built
    expect(beacon).not.toHaveBeenCalled();
  });

  it('keeps the dev console when the runtime config turns telemetry off', () => {
    resetRuntimeForTests();
    core('dev');
    telemetryConfig(false);
    start();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getLogger().error('still visible');
    expect(err).toHaveBeenCalledWith('[shell] still visible', expect.anything());
    expect(exportedUrl).toBeUndefined();
  });

  it('sends as usual when the runtime config leaves telemetry on', async () => {
    telemetryConfig(true);
    start();
    getLogger().error('sent');
    expect((await sent()).map((r) => r.body)).toEqual(['sent']);
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

  it('removes URL query strings and fragments from the message and every attribute (review: redaction)', async () => {
    start();
    getLogger().info('callback https://idp.example/realms/r/cb?code=abc&state=xyz failed', {
      url: 'https://s3.example/bucket/o.pdf?X-Amz-Signature=deadbeef#page=2',
      nested: { links: ['see (https://a.example/p?token=t) now', 'ws://h.example/s#frag'] },
      plain: 'a?b#c is not a URL',
      path: 'GET /realms/r/protocol/openid-connect/auth?code=abc&state=xyz',
      ratio: '1/2?',
    });
    const [r] = await sent();
    expect(r!.body).toBe('callback https://idp.example/realms/r/cb failed');
    expect(attrsOf(r!)).toMatchObject({
      url: 'https://s3.example/bucket/o.pdf',
      nested: { links: ['see (https://a.example/p) now', 'ws://h.example/s'] },
      plain: 'a?b#c is not a URL',
      path: 'GET /realms/r/protocol/openid-connect/auth',
      ratio: '1/2?',
    });
  });

  it('caps a record\'s attributes, so one record never outgrows the unload budget (review: oversized record)', async () => {
    start();
    getLogger().error('save failed', { ids: Array.from({ length: 5_000 }, (_, i) => `id-${i}-${'x'.repeat(40)}`), after: 'kept?' });
    const [r] = await sent();
    const attrs = attrsOf(r!) as { ids: string[]; after?: string };
    expect(JSON.stringify(attrs.ids).length).toBeLessThan(ATTRIBUTES_MAX_BYTES + 1_024);
    expect(attrs.ids.at(-1)).toBe('[TRUNCATED]');
    expect(attrs.after).toBe('[TRUNCATED]');
  });

  it('strips queries after scheme-less hosts and relative paths, keeps prose, and stays linear (review 2)', () => {
    expect(cleanString('bucket.s3.amazonaws.com/k.pdf?X-Amz-Signature=abc')).toBe('bucket.s3.amazonaws.com/k.pdf');
    expect(cleanString('GET api/tenders?token=x failed')).toBe('GET api/tenders failed');
    expect(cleanString('Did you mean /help? Try')).toBe('Did you mean /help? Try');
    const started = performance.now();
    cleanString('/'.repeat(1_000_000));
    cleanString(`data:image/png;base64,${'ab+/'.repeat(250_000)}`);
    expect(performance.now() - started).toBeLessThan(200); // was ~1.5 s for 40 000 slashes
  });

  it('counts errors and keys against the attribute cap, and stops at it (review 2)', async () => {
    start();
    const stack = `Error: x\n${'    at f (https://a.example/b.js:1:1)\n'.repeat(120)}`;
    getLogger().error('many', {
      errs: Array.from({ length: 200 }, () => Object.assign(new Error('x'), { stack })),
      ...Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`k${i}`, 'v'])),
      ['x'.repeat(100_000)]: 'long key',
    });
    const [r] = await sent();
    expect(JSON.stringify(attrsOf(r!)).length).toBeLessThan(ATTRIBUTES_MAX_BYTES + 6_000); // was 853 KB / 433 KB
    expect(Object.values(attrsOf(r!)).filter((v) => v === '[TRUNCATED]')).toHaveLength(1);
  });

  it('caps nested objects too: past the budget a nested key is [TRUNCATED] and the walk stops', async () => {
    start();
    getLogger().info('nested', { rows: Array.from({ length: 100 }, (_, i) => ({ [`field_${i}`]: 'y'.repeat(200), more: 'z' })) });
    const [r] = await sent();
    const json = JSON.stringify(attrsOf(r!));
    expect(json.length).toBeLessThan(ATTRIBUTES_MAX_BYTES + 2_000);
    expect(json).toContain('[TRUNCATED]');
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

  it('logs a Map as an object of its entries and a Set as an array, redacted and with cycles replaced', async () => {
    start();
    const map = new Map<unknown, unknown>([
      ['user', 'u'],
      ['password', 'hunter2'],
      [42, { access_token: 'tok', note: `see ${JWT}` }],
      [{ id: 1 }, 'object key'],
    ]);
    map.set('self', map);
    const set = new Set<unknown>(['a', 1, new Map([['api_key', 'k']])]);
    set.add(set);
    getLogger().info('x', { map, set, nested: { inner: new Map([['n', new Set([1, 2])]]) } });
    const a = attrsOf((await sent())[0]!);
    expect(a.map).toEqual({
      user: 'u',
      password: '[REDACTED]',
      42: { access_token: '[REDACTED]', note: 'see [REDACTED]' },
      '[object Object]': 'object key',
      self: '[Circular]',
    });
    expect(a.set).toEqual(['a', 1, { api_key: '[REDACTED]' }, '[Circular]']);
    expect(a.nested).toEqual({ inner: { n: [1, 2] } });
    expect(JSON.stringify(a)).not.toMatch(/hunter2|tok"|"k"/);
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

  it('serializeError adds the cause chain (Issue 18): three deep at most, cleaned, cycles and non-errors handled', () => {
    const root = new TypeError('Shared module @bcbp-solutions-fzc-llc/frontend-sdk/problem doesn\'t exist in shared scope default');
    const mid = new Error('module ./EditTender failed to evaluate', { cause: root });
    const top = new Error('remote failed', { cause: mid });
    expect(serializeError(top).cause).toBe(
      "Error: module ./EditTender failed to evaluate ← TypeError: Shared module @bcbp-solutions-fzc-llc/frontend-sdk/problem doesn't exist in shared scope default",
    );
    expect(serializeError(new Error('no cause')).cause).toBeUndefined();
    const deep = new Error('0', { cause: new Error('1', { cause: new Error('2', { cause: new Error('3', { cause: new Error('4') }) }) }) });
    expect(serializeError(deep).cause).toBe('Error: 1 ← Error: 2 ← Error: 3');
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(serializeError(a).cause).toBe('Error: b');
    expect(serializeError(new Error('x', { cause: { code: 7 } })).cause).toBe('object: {"code":7}');
    expect(serializeError(new Error('x', { cause: 'bad\u0007 thing' })).cause).toBe('string: bad thing');
    expect(serializeError(new Error('x', { cause: new Error('y'.repeat(5000)) })).cause!.length).toBeLessThanOrEqual(1024);
  });

  it('a logged error carries its cause as exception.cause, redacted like the message', async () => {
    start();
    getLogger().error('remote failed to load', { error: new Error('outer', { cause: new Error(`token ${JWT} refused`) }) });
    expect(attrsOf((await sent())[0]!)['exception.cause']).toBe('Error: token [REDACTED] refused');
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

  it('consent withdrawn while records are queued: those that needed it are not sent, by fetch or beacon (review: consent purge)', async () => {
    start({ flushMs: 60_000 });
    const log = getLogger();
    log.info('i');
    log.warn('w');
    log.warn('essential', { essential: true });
    log.error('e');
    consent([]);
    const stats = loggingStats()!;
    const out = await sent();
    expect(out.map((r) => r.body)).toEqual(['essential', 'e']);
    expect(stats.droppedNoConsent).toBe(2);
  });

  it('consent withdrawn before pagehide: the beacon carries only what needs no consent', async () => {
    const beacons: Blob[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (_u: string, data: Blob) => (beacons.push(data), true) });
    start({ flushMs: 60_000 });
    getLogger().info('i');
    getLogger().error('e');
    consent([]);
    (getRuntime().logging as { processor: { drainOnUnload(b: number): number } }).processor.drainOnUnload(60 * 1024);
    const bodies = ((JSON.parse(await beacons[0]!.text()) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0]!.scopeLogs[0]!.logRecords).map((r) => r.body.stringValue);
    expect(bodies).toEqual(['e']);
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

  it('a record with a huge attribute is capped, so it still goes by beacon on pagehide (review: oversized record)', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const beacons: Blob[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (_u: string, data: Blob) => (beacons.push(data), true) });
    start({ flushMs: 60_000 });
    // Each string is capped at 256 bytes, and the record's attributes at ATTRIBUTES_MAX_BYTES (once about 75 KB).
    getLogger().info('huge', { rows: Array.from({ length: 300 }, () => 'y'.repeat(250)) });
    target.dispatchEvent(new Event('pagehide'));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.size).toBeLessThan(ATTRIBUTES_MAX_BYTES + 4_096);
    expect(loggingStats()!.beacons).toBe(1);
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

  it('on page hidden, one beacon of the newest records within the page budget; the rest by fetch', async () => {
    const target = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    vi.stubGlobal('document', target);
    const beacons: number[] = [];
    vi.stubGlobal('navigator', {
      sendBeacon: (_url: string, data: Blob) => (beacons.push(data.size), true),
    });
    start({ flushMs: 60_000, batchSize: 512 });
    for (let i = 0; i < 400; i++) getLogger().info('x'.repeat(250), { i });
    target.visibilityState = 'hidden';
    target.dispatchEvent(new Event('visibilitychange'));
    // One beacon, within the page budget (src/internal/unload.ts; no metrics here, so no share for them).
    expect(beacons).toHaveLength(1);
    expect(beacons[0]).toBeLessThanOrEqual(PAGE_KEEPALIVE_BYTES);
    expect(beacons[0]).toBeGreaterThan(PAGE_KEEPALIVE_BYTES - 2_000);
    // The rest goes through the exporter, which sends with keepalive while the browser's budget allows:
    // the ledger counts that too, so a pagehide right after leaves it alone (review: two keepalive ledgers).
    expect(keepaliveLeft()).toBe(0);
    // Nothing is lost while the page stays: the rest goes by fetch.
    await vi.waitFor(() => expect(loggingStats()!.exported).toBe(400));
  });

  it('on pagehide with no budget left, or a refused beacon, every record goes back for fetch', async () => {
    const records = (n: number) => {
      start({ flushMs: 60_000, batchSize: 512 });
      for (let i = 0; i < n; i++) getLogger().info(`r${i}`);
      return (getRuntime().logging as { processor: { drainOnUnload(b: number): number } }).processor;
    };
    vi.stubGlobal('navigator', { sendBeacon: () => true });
    expect(records(3).drainOnUnload(0)).toBe(0); // the spans' turn never comes before the logs', but a 0 budget is handled
    await vi.waitFor(() => expect(loggingStats()!.exported).toBe(3));
    await shutdownLogging();
    vi.stubGlobal('navigator', { sendBeacon: () => false });
    // No beacon; the exporter's fetch for the two records is counted against the budget it shares.
    const taken = records(2).drainOnUnload(60 * 1024);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(2_000);
    expect(loggingStats()!.beacons).toBe(0);
    await vi.waitFor(() => expect(loggingStats()!.exported).toBe(2));
  });

  it('on pagehide, a newest record too big for the beacon on its own does not hold back the others (review: oversized record)', async () => {
    const beacons: Blob[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (_u: string, data: Blob) => (beacons.push(data), true) });
    start({ flushMs: 60_000, batchSize: 512 });
    for (let i = 0; i < 5; i++) getLogger().info(`r${i}`);
    const processor = (getRuntime().logging as { processor: { drainOnUnload(b: number): number } }).processor;
    // A record over 1 KiB, newest in the queue, against a 1 KiB budget: it alone could never fit.
    getLogger().error('save failed', { ids: Array.from({ length: 40 }, (_, i) => `id-${i}-${'x'.repeat(40)}`) });
    expect(processor.drainOnUnload(1024)).toBeGreaterThan(0);
    expect(beacons).toHaveLength(1);
    const bodies = ((JSON.parse(await beacons[0]!.text()) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0]!.scopeLogs[0]!.logRecords).map((r) => r.body.stringValue);
    expect(bodies.at(-1)).toBe('r4'); // the newest that fit; the oversized record goes back for fetch
    await vi.waitFor(() => expect(loggingStats()!.exported).toBe(6));
  });

  it('on pagehide, the newest records that fit the page budget go in one beacon; the rest go back for fetch', async () => {
    const target = new EventTarget();
    vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
    vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
    const beacons: Blob[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (_u: string, data: Blob) => (beacons.push(data), true) });
    start({ flushMs: 60_000, batchSize: 512 });
    for (let i = 0; i < 400; i++) getLogger().info(`r${i} ${'x'.repeat(250)}`);
    target.dispatchEvent(new Event('pagehide'));
    expect(beacons).toHaveLength(1);
    expect(beacons[0]!.size).toBeLessThanOrEqual(60 * 1024);
    const bodies = ((JSON.parse(await beacons[0]!.text()) as { resourceLogs: { scopeLogs: { logRecords: { body: { stringValue: string } }[] }[] }[] }).resourceLogs[0]!.scopeLogs[0]!.logRecords).map((r) => r.body.stringValue.split(' ')[0]);
    expect(bodies.at(-1)).toBe('r399'); // the newest
    expect(bodies).toEqual(Array.from({ length: bodies.length }, (_, i) => `r${400 - bodies.length + i}`));
    await vi.waitFor(() => expect(loggingStats()!.exported).toBe(400)); // the older ones by fetch
  });
});
