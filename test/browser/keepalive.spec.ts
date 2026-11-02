// Scenario 1: the keepalive budget. Browsers cap the bodies of in-flight keepalive requests (fetch
// keepalive and sendBeacon) at 64 KiB per page, and only those outlive a closing tab. The SDK sends
// the NEWEST queued spans that fit one keepalive request first (tracing/processor.ts flushOnHidden,
// drainOnUnload) and logs by sendBeacon (logging/processor.ts drainOnHide). jsdom/happy-dom have no
// keepalive budget and no tab close, so this runs in real engines.
import type { Page } from '@playwright/test';
import { counterValues, distinct, logSeqs, spanSeqs } from './otlp.ts';
import { expect, test } from './fixtures.ts';
import type { CollectedRequest, RunLog } from './server.ts';
import { CLOSE_LOSS, METRICS_AFTER_PAGEHIDE } from './engine-notes.ts';

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
  const LOGS = 40; // under the batch size (50): all still queued at close; ~56 KiB, most of the budget

  test('spans alone: the newest that fit one keepalive request outlive the page', async ({ openHarness, collected, browserName }) => {
    const page = await openHarness();
    await page.evaluate((s) => window.harness.spans(s, 1500), SPANS);
    const before = await page.evaluate(() => window.harness.stats());
    expect(before.tracing.exported, 'nothing sent before the close (the batch timer is 5 s)').toBe(0);

    await closeTab(page);
    const traces = await traceRequests(collected);
    test.skip(traces.length === 0, `${browserName}: ${CLOSE_LOSS}`);
    await new Promise((r) => setTimeout(r, 1_000)); // stragglers
    const log = await collected();
    const all = ofSignal(log, 'traces');
    test.info().annotations.push(
      { type: 'lifecycle on close', description: (log.pages[0]?.events ?? []).map((e) => `${e.type}(${e.visibilityState})`).join(' → ') },
      { type: 'span requests after close', description: describe(all, spanSeqs) },
    );

    // The first span request is the keepalive one, the whole page budget, carrying the newest spans.
    const first = all[0]!;
    const seqs = distinct(spanSeqs(first));
    expect(['beacon', 'keepalive']).toContain(first.via);
    expect(first.bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
    expect(seqs.length).toBeGreaterThan(10);
    expect(seqs).toEqual(range(SPANS - seqs.length, SPANS));
  });

  test('spans, logs and metrics: the logs go first by beacon, the spans take what is left short of the metrics\' share, the metrics fit it', async ({ openHarness, collected, browserName }) => {
    const page = await openHarness();
    await page.evaluate(([s, l]) => (window.harness.spans(s, 1500), window.harness.logs(l, 800), window.harness.count(3)), [SPANS, LOGS] as const);
    await closeTab(page);
    const arrived = await traceRequests(collected);
    // Either request can be lost with the closing page (Firefox drops the logs' beacon in about 1 close
    // in 6 while the spans' arrives): what is asserted is what was sent, so skip a close that lost one.
    let logsArrived = false;
    await expect.poll(async () => (logsArrived = ofSignal(await collected(), 'logs').length > 0), { timeout: 5_000 }).toBe(true).catch(() => {});
    test.skip(arrived.length === 0 || !logsArrived, `${browserName}: ${CLOSE_LOSS}`);

    // Over 127.0.0.1 even a plain fetch from a closing tab usually lands; on a real network it is
    // cancelled. So the transport is asserted: only a beacon or a keepalive fetch outlives the page.
    await expect.poll(async () => distinct(ofSignal(await collected(), 'logs').flatMap(logSeqs)), { timeout: 10_000 }).toEqual(range(0, LOGS));
    const logs = ofSignal(await collected(), 'logs');
    const traces = await traceRequests(collected);
    test.info().annotations.push(
      { type: 'log requests after close', description: describe(logs, logSeqs) },
      { type: 'span requests after close', description: describe(traces, spanSeqs) },
    );
    for (const r of logs) expect(['beacon', 'keepalive'], `log request sent by ${r.via}`).toContain(r.via);
    // The spans' keepalive request: the newest that fit what the logs left, and together within the
    // browser's per-page budget (src/internal/unload.ts), so neither is refused.
    const first = traces[0]!;
    const seqs = distinct(spanSeqs(first));
    expect(['beacon', 'keepalive']).toContain(first.via);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual(range(SPANS - seqs.length, SPANS));
    // The metrics interval, collected after both, went by beacon in the share they left it
    // (src/internal/unload.ts metricsShare), and all three fit the page's budget together.
    const clicks = async () => ofSignal(await collected(), 'metrics').filter((r) => counterValues(r, 'portal_browser_harness_clicks_total').length > 0);
    await expect.poll(async () => (await clicks()).length, { timeout: 5_000 }).toBeGreaterThan(0).catch(() => {});
    const metrics = await clicks();
    test.skip(metrics.length === 0, `${browserName}: ${METRICS_AFTER_PAGEHIDE}`);
    expect(metrics.map((r) => r.via)).toEqual(['beacon']);
    expect(metrics.flatMap((r) => counterValues(r, 'portal_browser_harness_clicks_total'))).toEqual([3]);
    expect(logs.reduce((n, r) => n + r.bytes, 0) + first.bytes + metrics[0]!.bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
  });
});

test.describe('metrics', () => {
  // The interval is collected and sent when the page is hidden or closing (metrics.ts sendOnHide):
  // by sendBeacon, so it outlives the tab. The exporter's own interval is 60 s, so nothing else sends.
  const CLICKS = 'portal_browser_harness_clicks_total';

  test('a tab switch sends the interval by beacon, once', async ({ openHarness, collected }) => {
    const page = await openHarness();
    await page.evaluate(() => window.harness.count(5));
    await page.evaluate(() => window.harness.setVisibility('hidden'));
    await expect.poll(async () => ofSignal(await collected(), 'metrics').flatMap((r) => counterValues(r, CLICKS)), { timeout: 10_000 }).toEqual([5]);
    const sent = ofSignal(await collected(), 'metrics').filter((r) => counterValues(r, CLICKS).length > 0);
    expect(sent.map((r) => r.via)).toEqual(['beacon']);
    await page.evaluate(() => window.harness.setVisibility('visible'));
    await page.evaluate(() => window.harness.setVisibility('hidden')); // nothing new: no second point
    await new Promise((r) => setTimeout(r, 1_000));
    expect(ofSignal(await collected(), 'metrics').flatMap((r) => counterValues(r, CLICKS))).toEqual([5]);
    expect((await page.evaluate(() => window.harness.stats())).metrics.beacons).toBe(1);
  });

  test('a tab close delivers the last interval by beacon', async ({ openHarness, collected, browserName }) => {
    const page = await openHarness();
    await page.evaluate(() => window.harness.count(7));
    await closeTab(page);
    let values: number[] = [];
    await expect.poll(async () => (values = ofSignal(await collected(), 'metrics').flatMap((r) => counterValues(r, CLICKS))).length, { timeout: 5_000 }).toBeGreaterThan(0).catch(() => {});
    test.skip(values.length === 0, `${browserName}: ${CLOSE_LOSS}`);
    expect(values).toEqual([7]);
    const via = ofSignal(await collected(), 'metrics').filter((r) => counterValues(r, CLICKS).length > 0).map((r) => r.via);
    expect(via).toEqual(['beacon']);
  });
});

test.describe('a close as browsers do it: hidden, then pagehide', () => {
  // Headless engines keep every page visible and Playwright's close fires no visibilitychange, so the
  // hidden phase a real tab close starts with is emulated (harness.setVisibility), then the tab closes.
  test('spans, logs and metrics all leave the page, within one keepalive budget', async ({ openHarness, collected, browserName }) => {
    const page = await openHarness();
    await page.evaluate(() => (window.harness.spans(400, 1500), window.harness.logs(40, 800), window.harness.count(3)));
    await page.evaluate(() => window.harness.setVisibility('hidden'));
    await closeTab(page);
    const metricsOf = async () => ofSignal(await collected(), 'metrics').filter((r) => counterValues(r, 'portal_browser_harness_clicks_total').length > 0);
    // Sent while the page was alive (hidden), so no engine loses these: no skip.
    await expect.poll(async () => (await metricsOf()).flatMap((r) => counterValues(r, 'portal_browser_harness_clicks_total')), { timeout: 10_000 }).toEqual([3]);
    await expect.poll(async () => ofSignal(await collected(), 'logs').length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(async () => ofSignal(await collected(), 'traces').length, { timeout: 10_000 }).toBeGreaterThan(0);
    const metrics = await metricsOf();
    expect(metrics.map((r) => r.via), browserName).toEqual(['beacon']);
    // The hidden phase's keepalive requests (the first of each signal) fit the page budget together.
    const log = await collected();
    const keepalive = log.requests.filter((r) => r.via === 'beacon' || r.via === 'keepalive');
    const firstOf = (signal: string) => keepalive.find((r) => r.signal === signal)?.bytes ?? 0;
    expect(firstOf('logs') + firstOf('traces') + metrics[0]!.bytes).toBeLessThanOrEqual(KEEPALIVE_MAX_BYTES);
  });
});

test('unload: the SDK starts its span and log requests within the pagehide listener', async ({ openHarness }) => {
  // What a closing engine is certain to send is what the listeners start before they return. Logs go
  // by sendBeacon and spans by fetch keepalive, both started inside the listener (src/internal/unload.ts);
  // spans once went through the OTLP exporter, which awaits headers() first, and Firefox often closed the
  // tab before that microtask ran. Deterministic in every engine.
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
