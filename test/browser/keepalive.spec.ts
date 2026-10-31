// Scenario 1: the keepalive budget. Browsers cap the bodies of in-flight keepalive requests (fetch
// keepalive and sendBeacon) at 64 KiB per page, and only those outlive a closing tab. The SDK sends
// the NEWEST queued spans that fit one keepalive request first (tracing/processor.ts flushOnHidden,
// drainOnUnload) and logs by sendBeacon (logging/processor.ts drainOnHide). jsdom/happy-dom have no
// keepalive budget and no tab close, so this runs in real engines.
import type { Page } from '@playwright/test';
import { UNLOAD_LOSS, SHARED_BUDGET } from './known-bugs.ts';
import { distinct, logSeqs, spanSeqs } from './otlp.ts';
import { expect, test } from './fixtures.ts';
import type { CollectedRequest, RunLog } from './server.ts';

const KEEPALIVE_MAX_BYTES = 60 * 1024;
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const ofSignal = (log: RunLog | null, signal: CollectedRequest['signal']) => (log?.requests ?? []).filter((r) => r.signal === signal).sort((a, b) => a.seq - b.seq);
const describe = (rs: CollectedRequest[], seqs: (r: CollectedRequest) => number[]) => rs.map((r) => `${r.via} ${r.bytes} B, ${seqs(r).length} items`).join('; ');

async function closeTab(page: Page): Promise<void> {
  // runBeforeUnload: the browser closes the tab as a user would (beforeunload, then the page's hide
  // and unload events); close() returns before the page is gone, so wait for it.
  const gone = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await gone;
}

/** Waits up to `ms` for the run's span requests; [] when none came. */
async function traceRequests(collected: () => Promise<RunLog>, ms = 5_000): Promise<CollectedRequest[]> {
  const until = Date.now() + ms;
  for (;;) {
    const traces = ofSignal(await collected(), 'traces');
    if (traces.length > 0 || Date.now() > until) return traces;
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.describe('tab close', () => {
  const SPANS = 400; // ~1.5 KiB each: ~600 KiB queued, far over the 64 KiB keepalive budget
  const LOGS = 40; // under the batch size (50): all still queued at close

  test('the newest spans that fit one keepalive request outlive the page', async ({ openHarness, collected, browserName }) => {
    const page = await openHarness();
    await page.evaluate(([s, l]) => (window.harness.spans(s, 1500), window.harness.logs(l, 800)), [SPANS, LOGS] as const);
    const before = await page.evaluate(() => window.harness.stats());
    expect(before.tracing.exported, 'nothing sent before the close (the batch timer is 5 s)').toBe(0);
    expect(before.logging.exported).toBe(0);

    await closeTab(page);
    const traces = await traceRequests(collected);
    test.skip(traces.length === 0, `${browserName}: ${UNLOAD_LOSS}`);
    await new Promise((r) => setTimeout(r, 1_000)); // stragglers
    const log = await collected();
    const all = ofSignal(log, 'traces');
    test.info().annotations.push(
      { type: 'lifecycle on close', description: (log.pages[0]?.events ?? []).map((e) => `${e.type}(${e.visibilityState})`).join(' → ') },
      { type: 'span requests after close', description: describe(all, spanSeqs) },
      { type: 'log requests after close', description: describe(ofSignal(log, 'logs'), logSeqs) },
    );

    // The first span request is the keepalive one, within budget, carrying the newest spans.
    const first = all[0]!;
    const seqs = distinct(spanSeqs(first));
    expect(first.via).toBe('keepalive');
    expect(first.bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(seqs.length).toBeGreaterThan(10);
    expect(seqs).toEqual(range(SPANS - seqs.length, SPANS));
  });

  test('queued logs leave by beacon even when the spans fill the keepalive budget', async ({ openHarness, collected, browserName }) => {
    test.fail(browserName !== 'firefox', SHARED_BUDGET);
    const page = await openHarness();
    await page.evaluate(([s, l]) => (window.harness.spans(s, 1500), window.harness.logs(l, 800)), [SPANS, LOGS] as const);
    await closeTab(page);

    // Over 127.0.0.1 even a plain fetch from a closing tab usually lands; on a real network it is
    // cancelled. So the transport is asserted: only a beacon or a keepalive fetch outlives the page.
    await expect.poll(async () => distinct(ofSignal(await collected(), 'logs').flatMap(logSeqs)), { timeout: 10_000 }).toEqual(range(0, LOGS));
    const logs = ofSignal(await collected(), 'logs');
    test.info().annotations.push({ type: 'log requests after close', description: describe(logs, logSeqs) });
    for (const r of logs) expect(['beacon', 'keepalive'], `log request sent by ${r.via}`).toContain(r.via);
  });
});

test('unload: the SDK starts its span and log requests within the pagehide listener', async ({ openHarness }) => {
  // What a closing engine is certain to send is what the listeners start before they return. Logs go
  // by sendBeacon, synchronously. Spans go through the OTLP exporter, whose fetch transport awaits
  // headers() before calling fetch(): the request starts a microtask later, which Firefox does not
  // always run while closing a tab (UNLOAD_LOSS). Deterministic in every engine.
  test.fail(true, UNLOAD_LOSS);
  const page = await openHarness();
  await page.evaluate(() => (window.harness.spans(20, 300), window.harness.logs(5, 200)));
  const { during } = await page.evaluate(() => window.harness.requestsStartedInPagehide());
  expect(during.logs, 'log beacons started in the listener').toBeGreaterThanOrEqual(1);
  expect(during.traces, 'span requests started in the listener').toBeGreaterThanOrEqual(1);
});

test.describe('tab switch', () => {
  // WebKit logs the refused keepalive request (the spans' fetch, after the logs' beacon took the
  // shared budget: SHARED_BUDGET); the exporter retries it once the beacon is done, so nothing is lost.
  test.use({ allowedErrors: /Reached maximum amount of queued data of 64Kb for keepalive requests|\/otel\/v1\/traces\?.*via=keepalive due to access control checks/ });

  test('hidden then visible again delivers every queued span and log, with no export failures', async ({ openHarness, collected }) => {
    const SPANS = 1_500; // two full batches of 512 go at once; the rest is queued when the tab is hidden
    const LOGS = 40;
    const page = await openHarness();
    await page.evaluate(([s, l]) => (window.harness.spans(s, 1500), window.harness.logs(l, 800)), [SPANS, LOGS] as const);

    await page.evaluate(() => window.harness.setVisibility('hidden'));
    await page.evaluate(() => window.harness.setVisibility('visible'));

    await expect.poll(async () => distinct(ofSignal(await collected(), 'traces').flatMap(spanSeqs)).length, { timeout: 15_000 }).toBe(SPANS);
    await expect.poll(async () => distinct(ofSignal(await collected(), 'logs').flatMap(logSeqs)).length, { timeout: 10_000 }).toBe(LOGS);
    await expect.poll(async () => (await page.evaluate(() => window.harness.stats())).tracing.exported, { timeout: 10_000 }).toBe(SPANS);

    const stats = await page.evaluate(() => window.harness.stats());
    const log = await collected();
    test.info().annotations.push(
      { type: 'span requests', description: describe(ofSignal(log, 'traces'), spanSeqs) },
      { type: 'log requests', description: describe(ofSignal(log, 'logs'), logSeqs) },
    );
    // No "Concurrent export limit" (or any other) failure, nothing dropped, nothing sent twice.
    expect(stats.tracing).toMatchObject({ exportFailures: 0, droppedQueueFull: 0, droppedOnUnload: 0, exported: SPANS });
    expect(stats.logging).toMatchObject({ exportFailures: 0, droppedQueueFull: 0, exported: LOGS });
    expect(ofSignal(log, 'traces').flatMap(spanSeqs)).toHaveLength(SPANS);
    expect(ofSignal(log, 'logs').flatMap(logSeqs)).toHaveLength(LOGS);
    // The newest spans went first, in one keepalive request within budget.
    const first = ofSignal(log, 'traces').find((t) => t.via === 'keepalive');
    expect(first?.bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(Math.max(...spanSeqs(first!))).toBe(SPANS - 1);
  });
});
