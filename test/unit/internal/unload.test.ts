// The page's pagehide senders and their one keepalive budget (src/internal/unload.ts), and the two
// real senders sharing it (known browser bug 1: spans and log beacons each took the whole 64 KiB).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCore, setConsentProvider } from '../../../packages/frontend-sdk/src/core/index.ts';
import { KEEPALIVE_IN_FLIGHT_MS, METRICS_SHARE_DEFAULT_BYTES, METRICS_SHARE_MAX_BYTES, METRICS_SHARE_MIN_BYTES, PAGE_KEEPALIVE_BYTES, keepaliveLeft, metricsShare, onUnload, reserveKeepalive, setMetricsShare, spendKeepalive } from '../../../packages/frontend-sdk/src/internal/unload.ts';
import { getServiceMeter, initializeMetrics } from '../../../packages/frontend-sdk/src/metrics/index.ts';
import { shutdownMetrics } from '../../../packages/frontend-sdk/src/metrics/metrics.ts';
import { resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { getLogger, initializeLogging } from '../../../packages/frontend-sdk/src/logging/index.ts';
import { shutdownLogging } from '../../../packages/frontend-sdk/src/logging/logging.ts';
import { getTracer, initializeTracing, shutdownTracing } from '../../../packages/frontend-sdk/src/tracing/index.ts';

let target: EventTarget;
beforeEach(() => {
  resetRuntimeForTests();
  target = new EventTarget();
  vi.stubGlobal('addEventListener', vi.fn(target.addEventListener.bind(target)));
  vi.stubGlobal('removeEventListener', vi.fn(target.removeEventListener.bind(target)));
});
afterEach(async () => {
  await shutdownTracing().catch(() => {});
  await shutdownLogging().catch(() => {});
  await shutdownMetrics().catch(() => {});
  vi.unstubAllGlobals();
  resetRuntimeForTests();
});

describe('onUnload', () => {
  it('calls the senders in priority order, each with what the earlier ones left, clamped to the budget', () => {
    const seen: [string, number][] = [];
    onUnload({ priority: 1, send: (b) => (seen.push(['spans', b]), 70_000) }); // claims more than it had
    onUnload({ priority: 0, send: (b) => (seen.push(['logs', b]), 20_000) });
    onUnload({ priority: 2, send: (b) => (seen.push(['last', b]), 0) });
    target.dispatchEvent(new Event('pagehide'));
    expect(seen).toEqual([
      ['logs', PAGE_KEEPALIVE_BYTES],
      ['spans', PAGE_KEEPALIVE_BYTES - 20_000],
      ['last', 0],
    ]);
  });

  it('a throwing sender never stops the next; one pagehide listener, removed with the last sender', () => {
    const next = vi.fn(() => 0);
    const stopA = onUnload({
      priority: 0,
      send: () => {
        throw new Error('boom');
      },
    });
    const stopB = onUnload({ priority: 1, send: next });
    expect(globalThis.addEventListener).toHaveBeenCalledTimes(1);
    expect(() => target.dispatchEvent(new Event('pagehide'))).not.toThrow();
    expect(next).toHaveBeenCalledWith(PAGE_KEEPALIVE_BYTES);
    stopA();
    expect(globalThis.removeEventListener).not.toHaveBeenCalled();
    stopB();
    expect(globalThis.removeEventListener).toHaveBeenCalledTimes(1);
    next.mockClear();
    target.dispatchEvent(new Event('pagehide'));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('the keepalive ledger: what the hidden phase sent is not handed out again on pagehide', () => {
  it('the metrics share: none without metrics, the default before the first interval, then the last one\'s size x1.25 within bounds', () => {
    expect(metricsShare()).toBe(0);
    setMetricsShare(undefined);
    expect(metricsShare()).toBe(METRICS_SHARE_DEFAULT_BYTES);
    setMetricsShare(100);
    expect(metricsShare()).toBe(METRICS_SHARE_MIN_BYTES);
    setMetricsShare(4_000);
    expect(metricsShare()).toBe(5_000);
    setMetricsShare(100_000);
    expect(metricsShare()).toBe(METRICS_SHARE_MAX_BYTES);
    setMetricsShare(0);
    expect(metricsShare()).toBe(0);
  });

  it('a reservation is left to its holder until released, once', () => {
    const release = reserveKeepalive(8_000);
    expect(keepaliveLeft()).toBe(PAGE_KEEPALIVE_BYTES - 8_000);
    release();
    release();
    expect(keepaliveLeft()).toBe(PAGE_KEEPALIVE_BYTES);
  });

  it('pagehide without a hidden phase: metrics (first) reserves its share before logs and spans are served', async () => {
    initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'test', buildVersion: '1.0.0' });
    setConsentProvider({ has: () => true, subscribe: () => () => {} });
    const beacons: { url: string; size: number }[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (url: string, data: Blob) => (beacons.push({ url, size: data.size }), true) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    initializeLogging({ otlpBaseUrl: '/otel', level: 'debug', flushMs: 60_000, batchSize: 512 });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const filler = 'x'.repeat(800);
    for (let i = 0; i < 80; i++) getLogger().error(`log ${i} ${filler}`);
    for (let i = 0; i < 300; i++) getTracer('t').startSpan(`s${i}`, { a: filler }).end();
    getServiceMeter().counter('portal_web_app_closes_total', 'Closes.', []).add(1);

    target.dispatchEvent(new Event('pagehide'));
    const sync = beacons.map((b) => b.size).reduce((n, b) => n + b, 0); // logs and spans, started in the listener
    expect(sync).toBeLessThanOrEqual(PAGE_KEEPALIVE_BYTES - METRICS_SHARE_DEFAULT_BYTES);
    await vi.waitFor(() => expect(beacons.map((b) => b.url)).toContain('http://localhost/otel/v1/metrics'));
    expect(beacons.map((b) => b.size).reduce((n, b) => n + b, 0)).toBeLessThanOrEqual(PAGE_KEEPALIVE_BYTES);
  });

  it('a spend lowers what is left until it is assumed done (KEEPALIVE_IN_FLIGHT_MS)', () => {
    expect(keepaliveLeft(1_000)).toBe(PAGE_KEEPALIVE_BYTES);
    spendKeepalive(20_000, 1_000);
    spendKeepalive(0, 1_000); // nothing sent: nothing recorded
    spendKeepalive(10_000, 3_000);
    expect(keepaliveLeft(1_000 + KEEPALIVE_IN_FLIGHT_MS - 1)).toBe(PAGE_KEEPALIVE_BYTES - 30_000);
    expect(keepaliveLeft(1_000 + KEEPALIVE_IN_FLIGHT_MS)).toBe(PAGE_KEEPALIVE_BYTES - 10_000);
    expect(keepaliveLeft(3_000 + KEEPALIVE_IN_FLIGHT_MS)).toBe(PAGE_KEEPALIVE_BYTES);
    spendKeepalive(PAGE_KEEPALIVE_BYTES * 2, 10_000);
    expect(keepaliveLeft(10_000)).toBe(0); // never negative
  });

  it('pagehide right after a hidden phase hands the senders only what it left, and records their spending', () => {
    const seen: number[] = [];
    onUnload({ priority: 0, send: (b) => (seen.push(b), 5_000) });
    spendKeepalive(40_000); // the hidden phase's beacons, just sent
    target.dispatchEvent(new Event('pagehide'));
    expect(seen).toEqual([PAGE_KEEPALIVE_BYTES - 40_000]);
    expect(keepaliveLeft()).toBe(PAGE_KEEPALIVE_BYTES - 45_000);
  });
});

describe('logs, spans and metrics when the page is hidden: one budget, the metrics\' share kept', () => {
  it('logs and spans leave the metrics share, a pagehide meanwhile leaves it too; the metrics interval, collected last, goes by beacon in it', async () => {
    initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'test', buildVersion: '1.0.0' });
    setConsentProvider({ has: () => true, subscribe: () => () => {} });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const beacons: { url: string; size: number }[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (url: string, data: Blob) => (beacons.push({ url, size: data.size }), true) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
    initializeLogging({ otlpBaseUrl: '/otel', level: 'debug', flushMs: 60_000, batchSize: 512 });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const filler = 'x'.repeat(800);
    for (let i = 0; i < 80; i++) getLogger().error(`log ${i} ${filler}`); // ~110 KiB: more than the whole budget
    for (let i = 0; i < 300; i++) getTracer('t').startSpan(`s${i}`, { a: filler }).end();
    getServiceMeter().counter('portal_web_app_hides_total', 'Hides.', []).add(1);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    // The metrics' share is held while the interval is collected: logs and spans left it, and a pagehide
    // arriving now would see only what is beyond it.
    const beyondTheReserve = keepaliveLeft();
    expect(beyondTheReserve).toBeGreaterThanOrEqual(0);
    target.dispatchEvent(new Event('pagehide'));
    const afterPagehide = keepaliveLeft(); // the pagehide senders had only what was beyond the reserve
    expect(afterPagehide).toBeLessThanOrEqual(beyondTheReserve);
    await vi.waitFor(() => expect(beacons.map((b) => b.url)).toContain('http://localhost/otel/v1/metrics'));

    const metrics = beacons.filter((b) => b.url.endsWith('/v1/metrics'));
    expect(metrics).toHaveLength(1); // the pagehide during the collection started no second send
    expect(metrics[0]!.size).toBeLessThanOrEqual(METRICS_SHARE_DEFAULT_BYTES);
    expect(keepaliveLeft()).toBe(afterPagehide + METRICS_SHARE_DEFAULT_BYTES - metrics[0]!.size); // all three within the page budget
    expect(metricsShare()).toBe(Math.max(METRICS_SHARE_MIN_BYTES, Math.ceil(metrics[0]!.size * 1.25))); // the next share: this interval's size
  });
});

describe('the hidden phase runs in priority order, whatever order the signals were initialised in', () => {
  it('tracing initialised first (as the shell and the harness do): on hide the logs still go first, the spans get what is left', async () => {
    initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'test', buildVersion: '1.0.0' });
    setConsentProvider({ has: () => true, subscribe: () => () => {} });
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('document', doc);
    const sent: { url: string; size: number }[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (url: string, data: Blob) => (sent.push({ url, size: data.size }), true) });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => (sent.push({ url: String(url), size: (init.body as Uint8Array).byteLength }), new Response(null, { status: 200 }))));
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    initializeLogging({ otlpBaseUrl: '/otel', level: 'debug', flushMs: 60_000, batchSize: 512 });
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const filler = 'x'.repeat(800);
    for (let i = 0; i < 40; i++) getLogger().error(`log ${i} ${filler}`); // ~56 KiB: fits the budget less the metrics' share
    for (let i = 0; i < 300; i++) getTracer('t').startSpan(`s${i}`, { a: filler }).end();
    getServiceMeter().counter('portal_web_app_hides_total', 'Hides.', []).add(1);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    // Synchronously within the listener: the logs' beacon carries every queued record, first.
    const logBeacon = sent.find((r) => r.url.endsWith('/v1/logs'));
    expect(logBeacon, 'the logs\' beacon, started in the listener').toBeDefined();
    const logs = (await import('../../../packages/frontend-sdk/src/logging/logging.ts')).loggingStats()!;
    expect(logs.exported).toBe(40);
    await vi.waitFor(() => expect(sent.map((r) => r.url)).toContain('http://localhost/otel/v1/metrics'));
    expect(keepaliveLeft()).toBeGreaterThanOrEqual(0);
  });
});

describe('logs and spans on one budget (known browser bug 1)', () => {
  it('the logs go first by beacon, the spans get what is left; together they never exceed the page budget', async () => {
    initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'test', buildVersion: '1.0.0' });
    setConsentProvider({ has: () => true, subscribe: () => () => {} });
    const beacons: { url: string; data: Blob }[] = [];
    vi.stubGlobal('navigator', { sendBeacon: (url: string, data: Blob) => (beacons.push({ url, data }), true) });
    initializeTracing({ otlpBaseUrl: '/otel', sampleRatio: 1 });
    initializeLogging({ otlpBaseUrl: '/otel', level: 'debug', flushMs: 60_000, batchSize: 512 });
    const filler = 'x'.repeat(800);
    for (let i = 0; i < 40; i++) getLogger().error(`log ${i} ${filler}`);
    for (let i = 0; i < 300; i++) getTracer('t').startSpan(`s${i}`, { a: filler }).end();

    target.dispatchEvent(new Event('pagehide'));

    // Both started inside the listener: the logs' beacon first, then the spans'.
    expect(beacons.map((b) => b.url)).toEqual(['http://localhost/otel/v1/logs', 'http://localhost/otel/v1/traces']);
    const logBytes = beacons[0]!.data.size;
    const spanBytes = beacons[1]!.data.size;
    const logs = (JSON.parse(await beacons[0]!.data.text()) as { resourceLogs: { scopeLogs: { logRecords: unknown[] }[] }[] }).resourceLogs[0]!.scopeLogs[0]!.logRecords;
    expect(logs).toHaveLength(40); // every error log, first
    expect(spanBytes).toBeGreaterThan(0);
    expect(logBytes + spanBytes).toBeLessThanOrEqual(PAGE_KEEPALIVE_BYTES);
  });
});
