// Playwright fixtures for the real-browser suite: each test gets its own run id (the server keeps
// what the page sends per run), a way to open the harness page with it, the run's collected
// requests, and an automatic guard that fails the test on any CSP violation, page error or console
// error in any page of its browser context.
import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';
import type { BootOptions } from './harness/entry.ts';
import { EXPECTED_VIOLATION_PREFIX } from './otlp.ts';
import type { RunLog } from './server.ts';

export { expect };

/**
 * Runs in every page before its own scripts (Playwright init scripts are not subject to the page's
 * CSP): records securitypolicyviolation events (and persists each with a beacon, so one during
 * unload is not lost), and every eval / Function construction by the page's code, which script-src
 * 'self' forbids (and which the engine also reports as a violation when it runs in a page task).
 */
function pageProbes(): void {
  const w = window as unknown as { __violations: unknown[]; __evalCalls: string[] };
  const run = new URLSearchParams(location.search).get('run') ?? '';
  w.__violations = [];
  w.__evalCalls = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    const v = { directive: e.violatedDirective, effective: e.effectiveDirective, blockedURI: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber };
    w.__violations.push(v);
    try {
      navigator.sendBeacon(`/__violation?run=${encodeURIComponent(run)}`, JSON.stringify(v));
    } catch {
      // kept in the page
    }
  });
  // Only calls from the page's own code (the harness bundle) count: Playwright's evaluate uses eval too.
  const fromPage = () => /\/harness\.js/.test(new Error().stack ?? '');
  const F = Function;
  window.Function = new Proxy(F, {
    construct(t, args, nt) {
      if (fromPage()) w.__evalCalls.push('new Function');
      return Reflect.construct(t, args, nt) as object;
    },
    apply(t, self, args) {
      if (fromPage()) w.__evalCalls.push('Function()');
      return Reflect.apply(t, self, args) as unknown;
    },
  });
  const E = window.eval;
  window.eval = new Proxy(E, {
    apply(t, self, args) {
      if (fromPage()) w.__evalCalls.push('eval');
      return Reflect.apply(t, self, args) as unknown;
    },
  });
}

interface Fixtures {
  /** This test's run id: the harness tags what it sends with it. */
  run: string;
  /** Set with test.use({ expectViolations: true }) by the detector controls only. */
  expectViolations: boolean;
  /** Console errors and page errors a test expects (e.g. the browser's own CSP message), by text. */
  allowedErrors: RegExp | undefined;
  /** Page errors and console errors from every page of the test's context. */
  problems: string[];
  /** Opens the harness in `page` (default: a new page of the context) for this run; boots it unless boot is false. */
  openHarness: (o?: { page?: Page; boot?: BootOptions | false; path?: string }) => Promise<Page>;
  /** What the server collected for this run. */
  collected: () => Promise<RunLog>;
  /** Automatic: after the test, nothing the pages did may have broken the production CSP or thrown. */
  guard: void;
}

export const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from its destructured first parameter: none here.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const url = process.env.BROWSER_BASE_URL;
    if (!url) throw new Error('BROWSER_BASE_URL is unset: run the suite with `pnpm run test-browser` (global-setup starts the server)');
    await use(url);
  },
  expectViolations: [false, { option: true }],
  allowedErrors: [undefined, { option: true }],
  run: async ({ expectViolations }, use) => {
    await use(`${expectViolations ? EXPECTED_VIOLATION_PREFIX : ''}${randomUUID()}`);
  },
  problems: async ({ context, allowedErrors }, use) => {
    const problems: string[] = [];
    const report = (text: string) => {
      if (!allowedErrors?.test(text)) problems.push(text);
    };
    await context.addInitScript(pageProbes);
    context.on('weberror', (e) => report(`pageerror: ${e.error().message}`));
    context.on('console', (m) => {
      if (m.type() === 'error') report(`console.error: ${m.text()}`);
    });
    await use(problems);
  },
  collected: async ({ request, baseURL, run }, use) => {
    await use(async () => (await (await request.get(`${baseURL}/__collected?run=${run}`)).json()) as RunLog);
  },
  openHarness: async ({ context, run }, use) => {
    await use(async (o = {}) => {
      const page = o.page ?? (await context.newPage());
      await page.goto(`${o.path ?? '/'}?run=${run}`);
      await page.waitForFunction(() => document.documentElement.dataset.harness === 'ready');
      if (o.boot !== false) await page.evaluate((b) => window.harness.boot(b), o.boot ?? {});
      return page;
    });
  },
  guard: [
    async ({ problems, collected, expectViolations, context }, use) => {
      await use();
      const pageSide: unknown[] = [];
      for (const p of context.pages()) {
        if (!p.isClosed()) pageSide.push(...(await p.evaluate(() => (window as unknown as { __violations?: unknown[] }).__violations ?? []).catch(() => [])));
      }
      const log = await collected();
      if (!expectViolations) {
        expect(pageSide, 'securitypolicyviolation events in the page').toEqual([]);
        expect(log?.violations ?? [], 'securitypolicyviolation events persisted by beacon').toEqual([]);
        expect(log?.cspReports ?? [], 'reports received at /csp-report').toEqual([]);
      }
      expect(problems, 'page errors and console errors').toEqual([]);
    },
    { auto: true },
  ],
});
