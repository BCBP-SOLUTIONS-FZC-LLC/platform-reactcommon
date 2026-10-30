import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeConfigSchema, setRuntimeConfig } from '../../src/config/index.ts';
import { initializeCore } from '../../src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import {
  RemoteDisabledError,
  RemoteLoadError,
  isChunkLoadError,
  loadManifest,
  loadRemote,
  reloadOnceForChunkError,
  startVersionPolling,
  subscribeAppUpdate,
} from '../../src/mfe/index.ts';
import { containerGlobal, resetContainersForTests, setMfeInternalsForTests } from '../../src/mfe/remote.ts';
import { FakeStorage } from '../core/helpers.ts';

const PAGE = 'https://app.bcbpsolutions.com/t/acme/';
const manifestBody = {
  tenders: { entry: '/remotes/tenders/1.4.0/remoteEntry.js', version: '1.4.0', ownerDomain: 'tender_management' },
  'iam-admin': { entry: '/remotes/iam-admin/2.0.0/remoteEntry.js', version: '2.0.0', ownerDomain: 'iam', integrity: 'sha384-abc+/=' },
};

function config(patch: { killSwitch?: string[]; allowedOrigins?: string[]; flags?: Record<string, boolean> } = {}) {
  setRuntimeConfig(
    RuntimeConfigSchema.parse({
      api: { baseUrl: '/api' },
      telemetry: {},
      auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
      flags: patch.flags ?? {},
      remotes: { loadTimeoutMs: 1_000, retries: 2, killSwitch: patch.killSwitch ?? [], allowedOrigins: patch.allowedOrigins ?? [] },
      i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
      appUpdate: { pollIntervalMs: 60_000 },
    }),
  );
}

const respond = (body: unknown, status = 200) => vi.fn(async (_url?: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

/** A Module Federation container whose modules are `exposed`. */
function fakeContainer(exposed: Record<string, unknown>) {
  return {
    init: vi.fn(async () => {}),
    get: vi.fn(async (m: string) => {
      if (!(m in exposed)) throw new Error(`Module "${m}" does not exist in container.`);
      return () => exposed[m];
    }),
  };
}

let metrics: { mfe: string; outcome: string; reason?: string }[];
let errorLog: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetRuntimeForTests();
  resetContainersForTests();
  vi.stubGlobal('location', Object.assign(new URL(PAGE), { reload: vi.fn() }));
  vi.spyOn(Math, 'random').mockReturnValue(0);
  initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev', buildVersion: '1.0.0' });
  config();
  metrics = [];
  getRuntime().instruments = { httpClient: () => {}, remoteLoad: (_s, l) => metrics.push(l), webError: () => {} };
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const name of ['tenders', 'iam_admin']) delete (globalThis as Record<string, unknown>)[name];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadManifest', () => {
  it('validates, publishes the manifest and the remote → owning-domain map', async () => {
    const fetchMock = respond(manifestBody);
    vi.stubGlobal('fetch', fetchMock);
    const m = await loadManifest();
    expect(Object.keys(m)).toEqual(['tenders', 'iam-admin']);
    expect(getRuntime().remotes).toEqual({ tenders: 'tender_management', 'iam-admin': 'iam' });
    expect(Object.isFrozen(m)).toBe(true);
    expect(fetchMock.mock.calls[0]![0]).toBe('/remotes/manifest.json');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ cache: 'no-cache' });
  });

  it('drops each invalid remote with an error log and keeps the rest', async () => {
    vi.stubGlobal(
      'fetch',
      respond({
        ...manifestBody,
        Bad_Name: manifestBody.tenders,
        shell: manifestBody.tenders,
        evil: { entry: 'https://evil.example/remoteEntry.js', version: '1.0.0', ownerDomain: 'iam' },
        js: { entry: 'javascript:alert(1)', version: '1.0.0', ownerDomain: 'iam' },
        nodomain: { entry: '/remotes/x.js', version: '1.0.0', ownerDomain: 'portal' },
        badversion: { entry: '/remotes/x.js', version: '-1', ownerDomain: 'iam' },
        badsri: { entry: '/remotes/x.js', version: '1.0.0', ownerDomain: 'iam', integrity: 'md5-x' },
        extra: { entry: '/remotes/x.js', version: '1.0.0', ownerDomain: 'iam', debug: true },
        notobject: 'x',
      }),
    );
    expect(Object.keys(await loadManifest())).toEqual(['tenders', 'iam-admin']);
    expect(errorLog).toHaveBeenCalledTimes(9);
  });

  it('accepts entries from configured remote origins', async () => {
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
    config({ allowedOrigins: ['https://cdn.bcbpsolutions.com'] });
    vi.stubGlobal('fetch', respond({ cdn: { entry: 'https://cdn.bcbpsolutions.com/cdn/1/remoteEntry.js', version: '1', ownerDomain: 'documents' } }));
    expect(Object.keys(await loadManifest())).toEqual(['cdn']);
  });

  it('throws when the manifest is unreachable or not an object', async () => {
    vi.stubGlobal('fetch', respond({}, 404));
    await expect(loadManifest()).rejects.toThrow('HTTP 404');
    vi.stubGlobal('fetch', respond([1, 2]));
    await expect(loadManifest()).rejects.toThrow(TypeError);
  });
});

describe('loadRemote', () => {
  let injected: string[];
  let shareInit: ReturnType<typeof vi.fn>;
  const scope = { react: {} };

  beforeEach(async () => {
    vi.stubGlobal('fetch', respond(manifestBody));
    await loadManifest();
    injected = [];
    shareInit = vi.fn(async () => {});
    vi.stubGlobal('__webpack_init_sharing__', shareInit);
    vi.stubGlobal('__webpack_share_scopes__', { default: scope });
  });

  const install = (name: string, exposed: Record<string, unknown>) => {
    const c = fakeContainer(exposed);
    setMfeInternalsForTests({
      injectScript: async (url) => {
        injected.push(url);
        (globalThis as Record<string, unknown>)[containerGlobal(name)] = c;
      },
    });
    return c;
  };

  it('loads the entry once, initialises the share scope and returns the module', async () => {
    const c = install('iam-admin', { './Users': 'users-module', './Roles': 'roles-module' });
    expect(await loadRemote('iam-admin', './Users')).toBe('users-module');
    expect(await loadRemote('iam-admin', './Roles')).toBe('roles-module');
    expect(injected).toEqual(['/remotes/iam-admin/2.0.0/remoteEntry.js']);
    expect(shareInit).toHaveBeenCalledWith('default');
    expect(c.init).toHaveBeenCalledWith(scope);
    expect(c.init).toHaveBeenCalledTimes(1);
    expect(metrics).toEqual([
      { mfe: 'iam-admin', outcome: 'success' },
      { mfe: 'iam-admin', outcome: 'success' },
    ]);
  });

  it('refuses a killed remote without loading it', async () => {
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
    config({ killSwitch: ['tenders'], flags: { 'remote.iam-admin.disabled': true } });
    getRuntime().instruments = { httpClient: () => {}, remoteLoad: (_s, l) => metrics.push(l), webError: () => {} };
    install('tenders', {});
    for (const name of ['tenders', 'iam-admin']) {
      const e = await loadRemote(name, './X').catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RemoteDisabledError);
      expect((e as RemoteDisabledError).remote).toBe(name);
    }
    expect(injected).toEqual([]);
    expect(metrics).toEqual([
      { mfe: 'tenders', outcome: 'failure', reason: 'disabled' },
      { mfe: 'iam-admin', outcome: 'failure', reason: 'disabled' },
    ]);
  });

  it('fails a remote that is not in the manifest', async () => {
    install('nope', {});
    await expect(loadRemote('nope', './X', { retries: 0 })).rejects.toBeInstanceOf(RemoteLoadError);
  });

  it('retries a failing entry with backoff, then succeeds', async () => {
    let n = 0;
    const c = fakeContainer({ './Tender': 'ok' });
    setMfeInternalsForTests({
      injectScript: async () => {
        if (n++ < 2) throw Object.assign(new Error('entry failed'), {});
        (globalThis as Record<string, unknown>).tenders = c;
      },
    });
    expect(await loadRemote('tenders', './Tender')).toBe('ok');
    expect(n).toBe(3);
  });

  it('gives up after the retries with a RemoteLoadError and an error metric', async () => {
    setMfeInternalsForTests({ injectScript: async () => Promise.reject(new Error('net::ERR_FAILED')) });
    const e = (await loadRemote('tenders', './Tender', { retries: 1 }).catch((x: unknown) => x)) as RemoteLoadError;
    expect(e).toBeInstanceOf(RemoteLoadError);
    expect(e.remote).toBe('tenders');
    expect(metrics).toEqual([{ mfe: 'tenders', outcome: 'error', reason: 'network' }]);
    expect(errorLog).toHaveBeenCalled();
  });

  it('does not retry an incompatible remote: missing container, unexposed or failing module, share clash', async () => {
    let injects = 0;
    setMfeInternalsForTests({ injectScript: async () => void injects++ });
    await expect(loadRemote('tenders', './X')).rejects.toThrow('container global');
    expect(injects).toBe(1);

    const c = install('tenders', { './Ok': 'ok' });
    await expect(loadRemote('tenders', './Missing')).rejects.toThrow('not exposed');
    c.get.mockResolvedValueOnce(() => {
      throw new Error('boom');
    });
    await expect(loadRemote('tenders', './Ok')).rejects.toThrow('failed to evaluate');

    resetContainersForTests();
    delete (globalThis as Record<string, unknown>).tenders;
    const clash = install('tenders', {});
    clash.init.mockRejectedValueOnce(new Error('Unsatisfied version 18.2.0 of shared singleton module react'));
    await expect(loadRemote('tenders', './X')).rejects.toThrow('share scope negotiation failed');
    expect(metrics.at(-1)).toEqual({ mfe: 'tenders', outcome: 'error', reason: 'incompatible' });
  });

  it('tolerates a container that was already initialised', async () => {
    const c = install('tenders', { './X': 1 });
    c.init.mockRejectedValueOnce(new Error('Container initialization failed as it has already been initialized with a different share scope'));
    expect(await loadRemote('tenders', './X')).toBe(1);
  });

  it('stops on the caller abort, without logging an error', async () => {
    setMfeInternalsForTests({ injectScript: () => new Promise(() => {}) });
    const controller = new AbortController();
    const p = loadRemote('tenders', './X', { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toThrow('aborted');
    expect(metrics).toEqual([{ mfe: 'tenders', outcome: 'error', reason: 'aborted' }]);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('loads without webpack sharing (a remote run standalone)', async () => {
    vi.stubGlobal('__webpack_init_sharing__', undefined);
    vi.stubGlobal('__webpack_share_scopes__', undefined);
    const c = install('tenders', { './X': 'x' });
    expect(await loadRemote('tenders', './X')).toBe('x');
    expect(c.init).toHaveBeenCalledWith({});
  });
});

describe('the entry <script>', () => {
  type FakeScript = { src: unknown; async: boolean; integrity: string; crossOrigin: string; onload: (() => void) | null; onerror: (() => void) | null; remove: ReturnType<typeof vi.fn> };
  let appended: FakeScript[];

  beforeEach(async () => {
    appended = [];
    vi.stubGlobal('fetch', respond(manifestBody));
    await loadManifest();
    vi.stubGlobal('document', {
      createElement: () => ({ src: '', async: false, integrity: '', crossOrigin: '', onload: null, onerror: null, remove: vi.fn() }),
      head: { appendChild: (s: FakeScript) => appended.push(s) },
    });
    // the real injectScript (the module's default)
    vi.resetModules();
  });

  it('is added with SRI and a TrustedScriptURL from the platform-sdk policy, and resolves on load', async () => {
    const remote = await import('../../src/mfe/remote.ts');
    getRuntime().trustedTypesPolicy = { createScriptURL: (u: string) => ({ trusted: u }) };
    const p = remote.loadRemote('iam-admin', './X', { retries: 0 });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    const s = appended[0]!;
    expect(s.src).toEqual({ trusted: '/remotes/iam-admin/2.0.0/remoteEntry.js' });
    expect(s.integrity).toBe('sha384-abc+/=');
    expect(s.crossOrigin).toBe('anonymous');
    (globalThis as Record<string, unknown>).iam_admin = fakeContainer({ './X': 'x' });
    s.onload!();
    expect(await p).toBe('x');
  });

  it('is removed when it fails or times out', async () => {
    const remote = await import('../../src/mfe/remote.ts');
    const failing = remote.loadRemote('tenders', './X', { retries: 0 });
    await vi.waitFor(() => expect(appended).toHaveLength(1));
    appended[0]!.onerror!();
    await expect(failing).rejects.toThrow('failed to load');
    expect(appended[0]!.remove).toHaveBeenCalled();

    const slow = remote.loadRemote('tenders', './X', { retries: 0, timeoutMs: 20 });
    await expect(slow).rejects.toThrow('within 20 ms');
    expect(appended[1]!.remove).toHaveBeenCalled();
  });
});

describe('chunk errors', () => {
  it('recognises chunk-load failures, also inside a RemoteLoadError', () => {
    expect(isChunkLoadError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /a.js'))).toBe(true);
    expect(isChunkLoadError(new RemoteLoadError('t', 'x', new Error('Loading CSS chunk app failed')))).toBe(true);
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(isChunkLoadError('Loading chunk 1 failed')).toBe(false);
  });

  it('reloads once per version, never in a loop, and never without a guard', () => {
    const store = new FakeStorage();
    vi.stubGlobal('sessionStorage', store);
    const chunk = new Error('Loading chunk 7 failed');
    expect(reloadOnceForChunkError(new Error('other'))).toBe(false);
    expect(reloadOnceForChunkError(chunk)).toBe(true);
    expect(reloadOnceForChunkError(chunk)).toBe(false);
    expect(globalThis.location.reload).toHaveBeenCalledTimes(1);
    store.failWrites = true;
    store.clear();
    expect(reloadOnceForChunkError(chunk)).toBe(false);
    vi.stubGlobal('sessionStorage', undefined);
    expect(reloadOnceForChunkError(chunk)).toBe(false);
    expect(globalThis.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('app updates', () => {
  it('notifies once a newer /version.json than the running build is deployed', async () => {
    vi.useFakeTimers();
    try {
      let version = '1.0.0';
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version }), { headers: { 'content-type': 'application/json' } })));
      const l = vi.fn();
      subscribeAppUpdate(l);
      const stop = startVersionPolling({ intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(l).not.toHaveBeenCalled();
      version = '1.1.0';
      await vi.advanceTimersByTimeAsync(1_000);
      expect(l).toHaveBeenCalledWith({ current: '1.0.0', available: '1.1.0' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(l).toHaveBeenCalledTimes(1);
      const late = vi.fn();
      subscribeAppUpdate(late);
      expect(late).toHaveBeenCalledWith({ current: '1.0.0', available: '1.1.0' });
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the first version seen as the running one when the build has none', async () => {
    resetRuntimeForTests();
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev' });
    let version = '7';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version }))));
    const l = vi.fn();
    subscribeAppUpdate(l);
    const stop = startVersionPolling({ intervalMs: 10 });
    await vi.waitFor(() => expect(getRuntime().appUpdate).toMatchObject({ current: '7' }));
    version = '8';
    await vi.waitFor(() => expect(l).toHaveBeenCalledWith({ current: '7', available: '8' }));
    stop();
  });

  it('ignores failed or malformed polls', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(new Response('nope', { status: 503 })).mockResolvedValue(new Response('{"v":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const l = vi.fn();
    subscribeAppUpdate(l);
    const stop = startVersionPolling({ intervalMs: 5 });
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3));
    stop();
    expect(l).not.toHaveBeenCalled();
  });
});
