// Subresource Integrity for a remote's lazily loaded chunks (@bcbp-solutions-fzc-llc/webpack-preset
// ChunkIntegrityPlugin), in each engine, under the production CSP, for the remote built with webpack and
// with Rspack (the /rspack preset). The real tenders remote (built in production by the server,
// remote-build.ts) is loaded as the shell does: remoteEntry.js with the
// manifest's integrity, then its container. Every chunk its webpack runtime injects must carry its
// sha384, and a chunk altered in transit (a compromised CDN or origin) must be refused, its code never run.
import type { Page } from '@playwright/test';
import { SDK_SUBPATHS, SDK_VERSION, SDK_PACKAGE } from '../../packages/webpack-preset/src/generated/sdk.ts';
import { expect, test } from './fixtures.ts';

interface Loaded {
  ok: boolean;
  error?: string;
  /** Scripts added to the page while loading: src and integrity, as the runtime set them. */
  scripts: { src: string; integrity: string }[];
  /** Whether the altered chunk's code ran. */
  tampered: boolean;
}

/** Loads remoteEntry.js (with its integrity) and the remote's ./EditTender module, as loadRemote does. */
async function loadTenders(page: Page, base: string): Promise<Loaded> {
  const { entry } = (await (await page.request.get(`${base}/integrity`)).json()) as { entry: string };
  const shared = SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `${SDK_PACKAGE}/${s}`);
  return page.evaluate(
    async ({ entry, shared, version, base }) => {
      const scripts: { src: string; integrity: string }[] = [];
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) if (n instanceof HTMLScriptElement) scripts.push({ src: n.src, integrity: n.integrity });
      }).observe(document.documentElement, { childList: true, subtree: true });
      const w = window as unknown as {
        trustedTypes?: { createPolicy(n: string, r: { createScriptURL(u: string): string }): { createScriptURL(u: string): string } };
        tenders?: { init(scope: unknown): Promise<void>; get(m: string): Promise<() => { default?: unknown }> };
        __tampered?: boolean;
      };
      // The shell's script URL goes through a Trusted Types policy (require-trusted-types-for 'script').
      const policy = w.trustedTypes?.createPolicy('platform-webpack', { createScriptURL: (u) => u });
      const s = document.createElement('script');
      s.integrity = entry;
      s.crossOrigin = 'anonymous';
      (s as unknown as { src: unknown }).src = policy ? policy.createScriptURL(`${base}/remoteEntry.js`) : `${base}/remoteEntry.js`;
      await new Promise((res, rej) => {
        s.onload = res;
        s.onerror = () => rej(new Error('remoteEntry.js failed to load'));
        document.head.append(s);
      });
      // The shell's share scope: the SDK (the remote has no copy of it); React comes from the remote's fallback.
      const stub = () => Promise.resolve(() => ({}));
      await w.tenders!.init(Object.fromEntries(shared.map((k) => [k, { [version]: { get: stub, loaded: 1, from: 'shell' } }])));
      try {
        const factory = await w.tenders!.get('./EditTender');
        return { ok: typeof factory().default === 'function', scripts, tampered: w.__tampered === true };
      } catch (e) {
        return { ok: false, error: String((e as Error).message ?? e), scripts, tampered: w.__tampered === true };
      }
    },
    { entry, shared, version: SDK_VERSION, base },
  );
}

const chunkScripts = (r: Loaded, base: string) => r.scripts.filter((s) => new RegExp(`${base}/(?!remoteEntry\\.js)[\\w.-]+\\.js$`).test(s.src));

for (const [bundler, base] of [['webpack', '/remotes/tenders'], ['rspack', '/remotes/tenders-rspack']] as const) {
  test.describe(`built with ${bundler}`, () => {
    test('every chunk the remote loads carries its sha384, and the module loads', async ({ openHarness }) => {
      const page = await openHarness({ boot: false });
      const r = await loadTenders(page, base);
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      const chunks = chunkScripts(r, base);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) expect(c.integrity, c.src).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    });

    test.describe('a chunk altered in transit', () => {
      // The browser's own SRI message (each engine words it differently) is the expected console error.
      test.use({ allowedErrors: /integrity|digest|subresource|Loading chunk|ChunkLoadError/i });

      test('is refused: its code never runs, and the module load fails as a chunk-load error', async ({ openHarness }) => {
        const page = await openHarness({ boot: false });
        await page.route(new RegExp(`${base}/(?!remoteEntry\\.js)[\\w.-]+\\.js$`), async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: `${await response.text()}\n;window.__tampered=true;` });
        });
        const r = await loadTenders(page, base);
        expect(chunkScripts(r, base).length).toBeGreaterThan(0);
        expect(r.tampered).toBe(false);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Loading chunk \S+ failed/);
      });
    });
  });
}
