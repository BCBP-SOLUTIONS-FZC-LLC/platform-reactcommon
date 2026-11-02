// Scenario 2: page lifecycle event order. The SDK flushes on visibilitychange(hidden) and drains on
// pagehide (tracing.ts, logging.ts, metrics.ts). Which of them fire on close and on navigation, and
// in which order, is engine behaviour that jsdom/happy-dom do not model. The harness records the
// events in the page and persists each one at once with a beacon, so the order survives the page.
//
// Observed with Playwright's engines (headless): see README.md "Lifecycle events". The expectations
// below pin that behaviour, so an engine change shows up here first, and the SDK's delivery is
// asserted whatever the order.
import { UNLOAD_LOSS } from './known-bugs.ts';
import { distinct, spanSeqs } from './otlp.ts';
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';
import type { PageEventLog, RunLog } from './server.ts';

/** The page's unload-related events (pageshow and resume are left out), as type(visibilityState). */
const order = (p: PageEventLog | undefined) =>
  (p?.events ?? []).filter((e) => !['pageshow', 'resume'].includes(e.type)).map((e) => `${e.type}(${e.visibilityState})`);

const traceSeqs = (log: RunLog | null) => distinct((log?.requests ?? []).filter((r) => r.signal === 'traces').flatMap(spanSeqs));

async function eventsOf(collected: () => Promise<RunLog>, pageId: string): Promise<PageEventLog | undefined> {
  return (await collected()).pages.find((p) => p.pageId === pageId);
}

async function closeTab(page: Page): Promise<void> {
  const gone = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await gone;
}

/**
 * What every engine was seen to fire (README.md "Lifecycle events"): beforeunload, then pagehide,
 * and visibilitychange(hidden), when it fires at all, only AFTER pagehide: Gecko and WebKit follow
 * the HTML "unload a document" steps (pagehide, then the visibility update); headless Chromium never
 * hides a page, so its visibilitychange on close is the same late update, when it is seen at all.
 */
function expectUnloadOrder(seen: string[]): void {
  expect(seen.slice(0, 2)).toEqual(['beforeunload(visible)', 'pagehide(visible)']);
  expect(seen.slice(2).every((e) => e === 'visibilitychange(hidden)')).toBe(true);
}

/** Waits for all `n` spans; skips (with the bug's note) when the unload request never came (UNLOAD_LOSS). */
async function expectSpansDelivered(collected: () => Promise<RunLog>, n: number, browserName: string): Promise<void> {
  const until = Date.now() + 5_000;
  while (Date.now() < until && traceSeqs(await collected()).length === 0) await new Promise((r) => setTimeout(r, 100));
  test.skip(traceSeqs(await collected()).length === 0, `${browserName}: ${UNLOAD_LOSS}`);
  await expect.poll(async () => traceSeqs(await collected()), { timeout: 10_000 }).toEqual(Array.from({ length: n }, (_, i) => i));
  const requests = (await collected()).requests.filter((r) => r.signal === 'traces');
  expect(requests.flatMap(spanSeqs)).toHaveLength(n); // each span once
}

test('close: lifecycle events fire in the engine\'s order and the SDK delivers either way', async ({ openHarness, collected, browserName }) => {
  const page = await openHarness();
  const { pageId } = await page.evaluate(() => window.harness.boot());
  await page.evaluate(() => window.harness.spans(50, 300));
  await closeTab(page);

  await expect.poll(async () => order(await eventsOf(collected, pageId)), { timeout: 10_000 }).toEqual(expect.arrayContaining(['pagehide(visible)']));
  await new Promise((r) => setTimeout(r, 500));
  const seen = order(await eventsOf(collected, pageId));
  test.info().annotations.push({ type: `close order (${browserName})`, description: seen.join(' → ') });
  // tracing/processor.ts assumes "visibilitychange fires before pagehide" on close; no engine here
  // does that. It is harmless: pagehide's drainOnUnload takes the queue, and the late
  // flushOnHidden finds it empty, so nothing is lost or sent twice (asserted below).
  expectUnloadOrder(seen);
  await expectSpansDelivered(collected, 50, browserName);
});

test('navigation: lifecycle events fire in the engine\'s order and the SDK delivers either way', async ({ openHarness, collected, browserName }) => {
  const page = await openHarness();
  const { pageId } = await page.evaluate(() => window.harness.boot());
  await page.evaluate(() => window.harness.spans(50, 300));
  await openHarness({ page, path: '/other.html', boot: false });

  await expect.poll(async () => order(await eventsOf(collected, pageId)), { timeout: 10_000 }).toEqual(expect.arrayContaining(['pagehide(visible)']));
  await new Promise((r) => setTimeout(r, 500));
  const log = await eventsOf(collected, pageId);
  const seen = order(log);
  test.info().annotations.push({
    type: `navigation order (${browserName})`,
    description: `${seen.join(' → ')}; pagehide.persisted=${String(log?.events.find((e) => e.type === 'pagehide')?.persisted)}`,
  });
  // On a navigation the document stays visible until it is gone: pagehide is the SDK's signal.
  expectUnloadOrder(seen);
  await expectSpansDelivered(collected, 50, browserName);
});

test('pagehide alone: with visibilitychange kept from the SDK, closing still sends the newest spans that fit', async ({ openHarness, collected, browserName }) => {
  const SPANS = 400;
  const page = await openHarness({ boot: { suppressVisibilityChange: true } });
  await page.evaluate((n) => window.harness.spans(n, 1500), SPANS);
  await closeTab(page);

  const until = Date.now() + 5_000;
  while (Date.now() < until && traceSeqs(await collected()).length === 0) await new Promise((r) => setTimeout(r, 100));
  test.skip(traceSeqs(await collected()).length === 0, `${browserName}: ${UNLOAD_LOSS}`);
  await new Promise((r) => setTimeout(r, 500));
  const traces = (await collected()).requests.filter((r) => r.signal === 'traces');
  // drainOnUnload: one keepalive request with the newest spans that fit; the rest are counted as dropped.
  expect(traces).toHaveLength(1);
  expect(traces[0]!.via).toBe('keepalive');
  expect(traces[0]!.bytes).toBeLessThanOrEqual(60 * 1024);
  const seqs = distinct(spanSeqs(traces[0]!));
  expect(seqs.length).toBeGreaterThan(10);
  expect(seqs.at(-1)).toBe(SPANS - 1);
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => SPANS - seqs.length + i));
});
