// docs/e2e/integrated-deployment-report.md, Issue 19: a request in flight when the page navigates away is
// cancelled by the browser, and the leaving page still sees the rejection: Chromium, Firefox and WebKit all
// ran its catch handler, so the old page could act on it (a prompt=none redirect replaced the navigation).
// /auth tells that apart from a network failure by listening for beforeunload and pagehide while its
// refresh request is in flight (oidc.ts watchLeaving). This pins the engine behaviour it relies on: when a
// leaving page sees its request rejected, beforeunload or pagehide has already fired, for a navigation the
// user starts from the browser (address bar, reload) and one the page starts (a link).
import { expect, test } from './fixtures.ts';
import type { Page } from '@playwright/test';

/** Starts a request that never answers, noting the leaving events seen while it is in flight; the
 * rejection, if this page lives to see it, is reported by beacon with what had fired by then. */
async function hangWhileWatching(page: Page, pageId: string): Promise<void> {
  await page.evaluate((id) => {
    const seen: string[] = [];
    const note = (e: Event) => seen.push(e.type);
    addEventListener('beforeunload', note);
    addEventListener('pagehide', note);
    const run = new URLSearchParams(location.search).get('run');
    void fetch('/api/hang', { method: 'POST', body: '{}' }).catch(() => {
      const event = { type: `rejected-after:${seen.join(',') || 'nothing'}`, visibilityState: document.visibilityState, t: performance.now() };
      navigator.sendBeacon(`/__events?run=${run}`, JSON.stringify({ pageId: id, url: location.href, events: [event] }));
    });
  }, pageId);
  await page.waitForTimeout(200); // the request is on the wire
}

for (const how of ['browser', 'link'] as const) {
  test(`a leaving page that sees its request cancelled has already seen beforeunload or pagehide (${how} navigation)`, async ({ openHarness, collected, run, baseURL }) => {
    const page = await openHarness({ boot: false });
    const pageId = `leaving-${how}`;
    await hangWhileWatching(page, pageId);
    const next = `${baseURL}/other.html?run=${run}`;
    if (how === 'browser') {
      await page.goto(next);
    } else {
      await page.evaluate((href) => {
        const a = document.createElement('a');
        a.href = href;
        document.body.append(a);
        a.click();
      }, next);
      await page.waitForURL(next);
    }
    await page.waitForTimeout(1_000); // a beacon from the old page lands
    const report = (await collected()).pages.find((p) => p.pageId === pageId);
    const rejection = report?.events[0]?.type;
    // Seen in every engine: the old page runs its handler, after beforeunload.
    expect(rejection, 'the leaving page saw its request rejected').toMatch(/^rejected-after:(beforeunload|pagehide)/);
  });
}
