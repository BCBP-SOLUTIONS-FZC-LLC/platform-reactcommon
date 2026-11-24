import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cachedWorkspace,
  chooseWorkspace,
  isWrongWorkspace,
  rememberWorkspace,
  slugFromPath,
  type Workspace,
  type WorkspaceResolver,
} from '../../../packages/frontend-sdk/src/auth/index.ts';
import { WORKSPACE_CACHE_KEY } from '../../../packages/frontend-sdk/src/auth/workspace.ts';
import { RuntimeConfigSchema, setRuntimeConfig, type RuntimeConfig } from '../../../packages/frontend-sdk/src/config/index.ts';
import { initializeCore } from '../../../packages/frontend-sdk/src/core/index.ts';
import { resetRuntimeForTests } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { clearAllAppStorage } from '../../../packages/frontend-sdk/src/storage/index.ts';
import { FakePage } from '../../fixtures/keycloak.ts';

interface ResolveCase {
  name: string;
  identifier: string;
  response: { found?: boolean; realm?: string; strategy?: 'shared' | 'dedicated'; tenant_id?: string };
  expected: Workspace | null;
}
const contract = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../../packages/frontend-sdk/contracts', name), 'utf8')) as T;
const RESOLVE = contract<{ cases: ResolveCase[] }>('tenant-resolve-cases.json').cases;
const SESSION = contract<{ cases: { name: string; response: Record<string, unknown>; expected: Record<string, unknown> }[] }>(
  'session-context-cases.json',
).cases;

let cfg: RuntimeConfig['auth'];
let page: FakePage;
let errors: ReturnType<typeof vi.spyOn>;

/** The PUB-1 mapping as tenant-resolve-cases.json documents it (the shell's port does the same). */
function toWorkspace(identifier: string, r: ResolveCase['response']): Workspace | undefined {
  if (!r.found || !r.realm) return undefined;
  const trial = r.strategy === 'shared';
  const slug = trial ? (identifier.includes('@') ? undefined : identifier) : r.realm.slice(cfg.paidRealmPrefix.length);
  return { realm: r.realm, trial, ...(slug ? { slug } : {}), ...(trial && r.tenant_id ? { tenantIdHint: r.tenant_id } : {}) };
}

function resolverFor(answers: Record<string, ResolveCase['response']>): WorkspaceResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(async (id: string) => (answers[id] ? toWorkspace(id, answers[id]) : undefined)) };
}

beforeEach(() => {
  resetRuntimeForTests();
  initializeCore({ serviceName: 'web-app', domain: 'iam', environment: 'dev', buildVersion: '1.0.0' });
  const parsed = RuntimeConfigSchema.parse({
    api: { baseUrl: '/api' },
    telemetry: {},
    auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
    remotes: { loadTimeoutMs: 10_000, retries: 0 },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
    appUpdate: { pollIntervalMs: 300_000 },
  });
  setRuntimeConfig(parsed);
  cfg = parsed.auth;
  page = new FakePage('/');
  page.install();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('contracts: PUB-1 and P-35 cases', () => {
  it.each(RESOLVE.map((c) => [c.name, c] as const))('%s maps to the expected Workspace', (_n, c) => {
    expect(toWorkspace(c.identifier, c.response) ?? null).toEqual(c.expected);
  });

  it.each(SESSION.map((c) => [c.name, c] as const))('%s: expected is the camelCase of the response', (_n, c) => {
    const camel = (k: string) => k.replace(/_([a-z])/g, (_m, ch: string) => ch.toUpperCase());
    expect(Object.fromEntries(Object.entries(c.response).map(([k, v]) => [camel(k), v]))).toEqual(c.expected);
    expect(c.expected.roles).toContain('member');
  });
});

describe('slugFromPath', () => {
  it.each([
    ['/t/acme/', 'acme'],
    ['/t/acme', 'acme'],
    ['/t/beta-labs/tenders/42', 'beta-labs'],
    ['/t/', undefined],
    ['/t/Acme/', undefined],
    ['/t/-acme/', undefined],
    ['/t/ac..me/', undefined],
    ['/tenders/acme', undefined],
    ['/x/t/acme/', undefined],
    [`/t/${'a'.repeat(64)}/`, undefined],
  ])('%s → %s', (path, slug) => {
    expect(slugFromPath(path, cfg)).toBe(slug);
  });
});

describe('chooseWorkspace', () => {
  it('no slug: the most recent cached workspace, without PUB-1', async () => {
    rememberWorkspace({ realm: 'tenant-globex', trial: false, slug: 'globex' });
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    const resolver = resolverFor({});
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(await chooseWorkspace({ pathname: '/tenders', resolver: resolverFor({}), cfg: { ...cfg } })).toBeDefined();
  });

  it('no slug and no cache: undefined (the identifier-first screen)', async () => {
    expect(await chooseWorkspace({ pathname: '/', resolver: resolverFor({}), cfg })).toBeUndefined();
  });

  it('a cached paid slug skips PUB-1 (rate-limited per IP)', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    const resolver = resolverFor({});
    expect(await chooseWorkspace({ pathname: '/t/acme/x', resolver, cfg })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  // web-shell ask 1 (2026-11-24): a trial → paid conversion moves every user to tenant-<slug>; the email
  // links to /t/<slug>/ in a fresh tab, so a cached trial entry would send them to a realm that refuses them.
  it('a cached trial entry is re-checked with PUB-1 and replaced when the tenant converted', async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const resolver = resolverFor({ acme: { found: true, realm: 'tenant-acme', strategy: 'dedicated' } });
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(resolver.resolve).toHaveBeenCalledWith('acme', expect.any(AbortSignal));
    expect(cachedWorkspace('acme')).toEqual({ slug: 'acme', realm: 'tenant-acme', trial: false });
  });

  it('a most recent trial entry (no slug in the URL) is re-checked too', async () => {
    rememberWorkspace({ realm: 'tenant-globex', trial: false, slug: 'globex' });
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const resolver = resolverFor({ acme: { found: true, realm: 'tenant-acme', strategy: 'dedicated' } });
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(cachedWorkspace()).toEqual({ slug: 'acme', realm: 'tenant-acme', trial: false });
  });

  it('a trial entry still in trial keeps its realm and gains the hint for isWrongWorkspace', async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'beta-labs' });
    const trial = RESOLVE.find((c) => c.name === 'trial workspace by slug')!;
    const resolver = resolverFor({ 'beta-labs': trial.response });
    expect(await chooseWorkspace({ pathname: '/t/beta-labs/x', resolver, cfg })).toEqual(trial.expected);
  });

  it('not found drops the stale entry, so a deleted tenant is not restored on every visit (code review)', async () => {
    rememberWorkspace({ realm: 'tenant-globex', trial: false, slug: 'globex' });
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver: resolverFor({}), cfg })).toBeUndefined();
    expect(cachedWorkspace('acme')).toBeUndefined();
    expect(cachedWorkspace('globex')).toBeDefined();
  });

  it('no slug in the URL: a most recent trial entry PUB-1 no longer knows is dropped and the next one used (code review)', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'gone' });
    const resolver = resolverFor({});
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(cachedWorkspace('gone')).toBeUndefined();
    expect(resolver.resolve).toHaveBeenCalledOnce();
  });

  it('no slug in the URL: a cache that cannot be written ends at the identifier screen, without looping', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'gone' });
    vi.spyOn(page.local, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const resolver = resolverFor({});
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg })).toBeUndefined();
    expect(resolver.resolve).toHaveBeenCalledOnce();
  });

  it('no slug in the URL: forceResolve leaves a paid most recent entry alone', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    const resolver = resolverFor({});
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg, forceResolve: true })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  // Code review (2026-11-24): a re-check of a cached entry must not hold sign-in on a slow PUB-1.
  it('a re-check slower than 5 s uses the cached entry; an unknown slug still waits for PUB-1', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
      const resolver = { resolve: vi.fn((_id: string, _s?: AbortSignal) => new Promise<Workspace | undefined>(() => {})) };
      const chosen = chooseWorkspace({ pathname: '/t/acme/', resolver, cfg });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await chosen).toEqual({ realm: 'trial', trial: true, slug: 'acme' });
      expect(resolver.resolve.mock.calls[0]![1]?.aborted).toBe(true);
      let unknown: unknown = 'pending';
      void chooseWorkspace({ pathname: '/t/globex/', resolver, cfg }).then((w) => (unknown = w));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unknown).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it("a caller's abort during a re-check is passed through", async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const ctrl = new AbortController();
    const resolver = {
      resolve: vi.fn(async (_id: string, signal?: AbortSignal) => {
        ctrl.abort(new Error('left the page'));
        throw signal?.reason;
      }),
    };
    await expect(chooseWorkspace({ pathname: '/t/acme/', resolver, cfg, signal: ctrl.signal })).rejects.toThrow('left the page');
  });

  it("a caller's abort settles the call at once when the resolver ignores the signal (code review)", async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const ctrl = new AbortController();
    const resolver = { resolve: vi.fn(() => new Promise<Workspace | undefined>(() => {})) };
    const chosen = chooseWorkspace({ pathname: '/t/acme/', resolver, cfg, signal: ctrl.signal });
    const unknown = chooseWorkspace({ pathname: '/t/globex/', resolver, cfg, signal: ctrl.signal });
    ctrl.abort(new Error('left the page'));
    await expect(chosen).rejects.toThrow('left the page');
    await expect(unknown).rejects.toThrow('left the page'); // no cached entry: no 5 s bound, but the abort still settles it
  });

  it("a caller's abort is passed through even when the resolver ignores the signal (code review)", async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const ctrl = new AbortController();
    const resolver = {
      resolve: vi.fn(async () => {
        ctrl.abort(new Error('left the page'));
        return { realm: 'tenant-acme', trial: false, slug: 'acme' };
      }),
    };
    await expect(chooseWorkspace({ pathname: '/t/acme/', resolver, cfg, signal: ctrl.signal })).rejects.toThrow('left the page');
    expect(cachedWorkspace('acme')?.realm).toBe('trial');
    const unknown = new AbortController();
    const unknownResolver = { resolve: vi.fn(async () => (unknown.abort(new Error('gone')), undefined)) };
    await expect(chooseWorkspace({ pathname: '/t/globex/', resolver: unknownResolver, cfg, signal: unknown.signal })).rejects.toThrow('gone');
  });

  // Code review (2026-11-24): a 'not found' drops the entry only while it names the realm that was checked.
  it('not found keeps an entry another tab re-cached with another realm', async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const resolver = {
      resolve: vi.fn(async () => {
        rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' }); // tab B, meanwhile
        return undefined;
      }),
    };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg })).toBeUndefined();
    expect(cachedWorkspace('acme')?.realm).toBe('tenant-acme');
  });

  it('a late answer after the 5 s re-check gave up does not change the cache', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
      let answer!: (w: Workspace | undefined) => void;
      const resolver = { resolve: vi.fn(() => new Promise<Workspace | undefined>((r) => (answer = r))) }; // ignores the signal
      const chosen = chooseWorkspace({ pathname: '/t/acme/', resolver, cfg });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await chosen).toEqual({ realm: 'trial', trial: true, slug: 'acme' });
      answer({ realm: 'tenant-acme', trial: false, slug: 'acme' });
      await new Promise((r) => setImmediate(r)); // not faked: runs after every pending microtask, the late lookup's included
      expect(cachedWorkspace('acme')).toEqual({ slug: 'acme', realm: 'trial', trial: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('PUB-1 down: a cached trial entry is still used', async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'acme' });
    const resolver = { resolve: vi.fn(async () => Promise.reject(new Error('503'))) };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg })).toEqual({ realm: 'trial', trial: true, slug: 'acme' });
    expect(await chooseWorkspace({ pathname: '/', resolver, cfg })).toEqual({ realm: 'trial', trial: true, slug: 'acme' });
  });

  it('resolves an unknown slug and caches the result without the hint', async () => {
    const trial = RESOLVE.find((c) => c.name === 'trial workspace by slug')!;
    const resolver = resolverFor({ 'beta-labs': trial.response });
    const w = await chooseWorkspace({ pathname: '/t/beta-labs/', resolver, cfg });
    expect(w).toEqual(trial.expected);
    expect(JSON.parse(page.local.getItem(WORKSPACE_CACHE_KEY)!)).toEqual([{ slug: 'beta-labs', realm: 'trial', trial: true }]);
    expect(cachedWorkspace('beta-labs')).toEqual({ slug: 'beta-labs', realm: 'trial', trial: true });
  });

  it('a resolved realm must fit the slug, else it is rejected and not cached', async () => {
    const resolver = { resolve: vi.fn(async () => ({ realm: 'tenant-globex', trial: false })) };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg })).toBeUndefined();
    const trialElsewhere = { resolve: vi.fn(async () => ({ realm: 'other-trial', trial: true })) };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver: trialElsewhere, cfg })).toBeUndefined();
    expect(page.local.getItem(WORKSPACE_CACHE_KEY)).toBeNull();
    expect(errors).toHaveBeenCalled();
  });

  it('forceResolve skips the cache and replaces the entry (trial → paid conversion)', async () => {
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'beta-labs' });
    const resolver = resolverFor({ 'beta-labs': { found: true, realm: 'tenant-beta-labs', strategy: 'dedicated' } });
    expect(await chooseWorkspace({ pathname: '/t/beta-labs/', resolver, cfg, forceResolve: true })).toEqual({
      realm: 'tenant-beta-labs',
      trial: false,
      slug: 'beta-labs',
    });
    expect(cachedWorkspace('beta-labs')?.realm).toBe('tenant-beta-labs');
  });

  it('PUB-1 unreachable or rate-limited: the cached entry is still used', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    const resolver = { resolve: vi.fn(async () => Promise.reject(new Error('429'))) };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg, forceResolve: true })).toEqual({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(await chooseWorkspace({ pathname: '/t/globex/', resolver, cfg })).toBeUndefined();
  });

  it('not found: undefined, never a fallback to another workspace', async () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(await chooseWorkspace({ pathname: '/t/nobody/', resolver: resolverFor({}), cfg })).toBeUndefined();
  });

  it('an abort is passed through', async () => {
    const ctrl = new AbortController();
    const resolver = {
      resolve: vi.fn(async (_id: string, signal?: AbortSignal) => {
        ctrl.abort();
        throw signal?.reason;
      }),
    };
    await expect(chooseWorkspace({ pathname: '/t/acme/', resolver, cfg, signal: ctrl.signal })).rejects.toBeDefined();
  });
});

describe('rememberWorkspace and the cache', () => {
  it('caches by slug, most recent first, and moves a slug-less URL to /t/<slug>/…', () => {
    page.url = new URL('https://app.example.com/tenders/42?tab=open#top');
    let popstates = 0;
    vi.stubGlobal('PopStateEvent', class extends Event {});
    vi.stubGlobal('dispatchEvent', (e: Event) => (e.type === 'popstate' && popstates++, true));
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme', tenantIdHint: 'x' } as Workspace & { slug: string });
    expect(popstates).toBe(0); // adding a missing slug keeps the route
    expect(page.url.pathname + page.url.search + page.url.hash).toBe('/t/acme/tenders/42?tab=open#top');
    expect(JSON.parse(page.local.getItem(WORKSPACE_CACHE_KEY)!)).toEqual([{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'beta-labs' });
    expect(page.url.pathname).toBe('/t/beta-labs/tenders/42'); // another slug is replaced: the next load restores beta-labs (code review)
    expect(popstates).toBe(1); // and a mounted router is told
    rememberWorkspace({ realm: 'trial', trial: true, slug: 'beta-labs' });
    expect(page.url.pathname).toBe('/t/beta-labs/tenders/42'); // the same slug: unchanged
    expect(popstates).toBe(1);
    expect(cachedWorkspace()?.slug).toBe('beta-labs');
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    expect(JSON.parse(page.local.getItem(WORKSPACE_CACHE_KEY)!).map((e: { slug: string }) => e.slug)).toEqual(['acme', 'beta-labs']);
  });

  it('refuses a slug that does not fit the realm', () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'globex' });
    rememberWorkspace({ realm: 'tenant-acme', trial: true, slug: 'acme' });
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'Bad Slug' });
    expect(page.local.getItem(WORKSPACE_CACHE_KEY)).toBeNull();
    expect(page.url.pathname).toBe('/');
  });

  it('skips malformed entries and survives clearAllAppStorage', () => {
    page.local.setItem(WORKSPACE_CACHE_KEY, JSON.stringify([{ slug: 'x y', realm: 'r', trial: false }, 'junk', { slug: 'acme', realm: 'tenant-acme', trial: false }]));
    expect(cachedWorkspace()).toEqual({ slug: 'acme', realm: 'tenant-acme', trial: false });
    clearAllAppStorage();
    expect(cachedWorkspace('acme')).toBeDefined();
    page.local.setItem(WORKSPACE_CACHE_KEY, '{not json');
    expect(cachedWorkspace()).toBeUndefined();
    page.local.setItem(WORKSPACE_CACHE_KEY, JSON.stringify({ slug: 'acme', realm: 'tenant-acme', trial: false }));
    expect(cachedWorkspace()).toBeUndefined(); // an object, not the list
  });

  it('skips cached entries whose realm does not fit the slug, or is not a realm (review: workspace cache)', () => {
    page.local.setItem(
      WORKSPACE_CACHE_KEY,
      JSON.stringify([
        { slug: 'acme', realm: 'tenant-evil', trial: false }, // another tenant's realm under acme's slug
        { slug: 'acme', realm: '../admin', trial: false }, // not a realm: would change the login URL's path
        { slug: 'beta', realm: 'tenant-beta', trial: true }, // trial uses the trial realm
        { slug: 'globex', realm: 'tenant-globex', trial: false },
      ]),
    );
    expect(cachedWorkspace('acme')).toBeUndefined();
    expect(cachedWorkspace('beta')).toBeUndefined();
    expect(cachedWorkspace()).toEqual({ slug: 'globex', realm: 'tenant-globex', trial: false });
  });

  it('localStorage denied: no cache, no throw, and the URL still gets its slug', () => {
    page.url = new URL('https://app.example.com/tenders');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(() => rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' })).not.toThrow();
    expect(cachedWorkspace('acme')).toBeUndefined();
    expect(page.url.pathname).toBe('/t/acme/tenders');
  });

  it('a full localStorage keeps the old cache', () => {
    rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' });
    page.local.failWrites = true;
    rememberWorkspace({ realm: 'tenant-globex', trial: false, slug: 'globex' });
    expect(cachedWorkspace()?.slug).toBe('acme');
  });

  it('needs the runtime config', () => {
    resetRuntimeForTests();
    expect(() => rememberWorkspace({ realm: 'tenant-acme', trial: false, slug: 'acme' })).toThrow('setRuntimeConfig');
    expect(page.local.getItem(WORKSPACE_CACHE_KEY)).toBeNull();
  });
});

describe('isWrongWorkspace', () => {
  const hint = '0b7e4c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d';
  it.each([
    ['trial, hint matches', { realm: 'trial', trial: true, tenantIdHint: hint }, { sub: 'u', tenantId: hint.toUpperCase() }, false],
    ['trial, hint differs', { realm: 'trial', trial: true, tenantIdHint: hint }, { sub: 'u', tenantId: 'other' }, true],
    ['trial, token has no tenant_id', { realm: 'trial', trial: true, tenantIdHint: hint }, { sub: 'u' }, true],
    ['trial, no hint', { realm: 'trial', trial: true }, { sub: 'u', tenantId: 'other' }, false],
    ['paid', { realm: 'tenant-acme', trial: false, tenantIdHint: hint }, { sub: 'u' }, false],
  ])('%s → %s', (_n, w, user, wrong) => {
    expect(isWrongWorkspace(w as Workspace, user)).toBe(wrong);
  });
});
