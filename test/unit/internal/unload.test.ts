// The page's pagehide senders and their one keepalive budget (src/internal/unload.ts), and the two
// real senders sharing it (known browser bug 1: spans and log beacons each took the whole 64 KiB).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCore, setConsentProvider } from '../../../packages/frontend-sdk/src/core/index.ts';
import { PAGE_KEEPALIVE_BYTES, onUnload } from '../../../packages/frontend-sdk/src/internal/unload.ts';
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
