// /mfe, /flags, /http, /metrics, /logging and /tracing wired together: the shell loads the manifest,
// loads a remote through a fake Module Federation container, and the remote's telemetry and API
// calls are tagged with its name and the domain the manifest says owns it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { getLogger } from '../../packages/frontend-sdk/src/logging/index.ts';
import { getServiceMeter } from '../../packages/frontend-sdk/src/metrics/index.ts';
import { RemoteDisabledError, RemoteLoadError, loadManifest, loadRemote } from '../../packages/frontend-sdk/src/mfe/index.ts';
import { setMfeInternalsForTests } from '../../packages/frontend-sdk/src/mfe/remote.ts';
import { World, endWorld, runtimeConfigJson, useFakeClock } from '../fixtures/boot.ts';
import { unloadTelemetry } from '../fixtures/telemetry.ts';

const MANIFEST = {
  tenders: { entry: '/remotes/tenders/1.4.0/remoteEntry.js', version: '1.4.0', ownerDomain: 'tender_management' },
  dashboard: { entry: '/remotes/dashboard/2.0.0/remoteEntry.js', version: '2.0.0', ownerDomain: 'portal' },
  thirdparty: { entry: 'https://cdn.evil.example/remoteEntry.js', version: '1.0.0', ownerDomain: 'portal' },
};
const OPENED = 'tender_management_tenders_opened_total';

/** What the tenders remote's ./Main module does when the shell mounts it. */
async function tendersMain(): Promise<unknown> {
  getServiceMeter({ mfe: 'tenders' }).counter(OPENED, 'Tender pages opened.', ['view']).add(1, { view: 'edit' });
  getLogger({ mfe: 'tenders' }).info('tender page opened');
  return (await createApiClient({ mfe: 'tenders' }).get('/tenders/:id', { params: { id: '1' } })).data;
}

let w: World;
let injected: string[];
let shareScopes: unknown[];

beforeEach(async () => {
  useFakeClock();
  w = new World('/t/acme/', runtimeConfigJson({ remotes: { killSwitch: ['dashboard'] } }));
  w.net.on('GET /remotes/manifest.json', MANIFEST).on('GET /api/tenders/:id', { id: '1', title: 'Road works' });
  injected = [];
  shareScopes = [];
  // The one seam: the entry <script>. Running it defines the container global, as webpack's
  // remoteEntry.js does (window.__platform_mfe_tenders = { init, get }).
  setMfeInternalsForTests({
    injectScript: async (url) => {
      injected.push(url);
      (globalThis as Record<string, unknown>).__platform_mfe_tenders = {
        init: (scope: unknown) => void shareScopes.push(scope),
        get: async (module: string) => {
          if (module !== './Main') throw new Error(`Module "${module}" does not exist in container.`);
          return () => ({ default: tendersMain });
        },
      };
    },
  });
  await w.signIn();
});

afterEach(async () => {
  delete (globalThis as Record<string, unknown>).__platform_mfe_tenders;
  await endWorld();
});

describe('remotes', () => {
  it('loads the manifest, drops an entry from another origin, and publishes each remote’s owner domain', async () => {
    const manifest = await loadManifest();
    expect(Object.keys(manifest)).toEqual(['tenders', 'dashboard']);
    expect(w.net.sent('/remotes/manifest.json')[0]!.cache).toBe('no-cache');
    await unloadTelemetry();
    expect(w.collector.logs.find((l) => l.body === 'remote dropped from the manifest')?.attributes).toMatchObject({ remote: 'thirdparty' });
  });

  it('loads a remote through its container once; its metrics, logs, spans and calls carry its name and owner domain', async () => {
    await loadManifest();
    const main = await loadRemote<{ default: () => Promise<unknown> }>('tenders', './Main');
    expect(await main.default()).toEqual({ id: '1', title: 'Road works' });
    await loadRemote('tenders', './Main'); // the container is shared by every later load

    expect(injected).toEqual(['/remotes/tenders/1.4.0/remoteEntry.js']);
    expect(shareScopes).toHaveLength(1);
    const [req] = w.net.sent('/api/tenders/1');
    expect(req!.headers.get('authorization')).toMatch(/^Bearer at-/);

    await unloadTelemetry();
    expect(w.collector.points(OPENED)).toEqual([
      // Tier 3 identity from the manifest: the remote is the service, its owner team's domain the domain.
      { name: OPENED, attributes: { view: 'edit', domain: 'tender_management', service: 'tenders', environment: 'test' }, value: 1 },
    ]);
    expect(w.collector.logs.find((l) => l.body === 'tender page opened')?.attributes.mfe).toBe('tenders');
    const spans = w.collector.spans.map((s) => [s.name, s.attributes.mfe]);
    expect(spans).toEqual(expect.arrayContaining([['remote load', 'tenders'], ['HTTP GET', 'tenders']]));
  });

  it('refuses a kill-switched remote without loading its entry, and names an unknown one', async () => {
    await loadManifest();
    await expect(loadRemote('dashboard', './Main')).rejects.toBeInstanceOf(RemoteDisabledError);
    const unknown = await loadRemote('reports', './Main').catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(RemoteLoadError);
    expect((unknown as RemoteLoadError).message).toContain('not in the remote manifest');
    expect(injected).toEqual([]);
  });

  it('a module the container does not expose is a RemoteLoadError logged with the remote’s scope', async () => {
    await loadManifest();
    await expect(loadRemote('tenders', './Missing')).rejects.toBeInstanceOf(RemoteLoadError);
    await unloadTelemetry();
    expect(w.collector.logs.find((l) => l.body === 'remote failed to load')?.attributes).toMatchObject({ mfe: 'tenders', reason: 'incompatible' });
    expect(w.collector.spans.find((s) => s.name === 'remote load')?.status.code).toBe(2); // ERROR
  });

  it('before the manifest loads, a remote has no owning domain for its metrics', () => {
    expect(() => getServiceMeter({ mfe: 'tenders' }).counter(OPENED, 'Opened.', []).add(1)).toThrow(/not in the remote manifest/);
  });
});
