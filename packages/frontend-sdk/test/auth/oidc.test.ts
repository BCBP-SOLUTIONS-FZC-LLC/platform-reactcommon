import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOidcProvider,
  getSession,
  initializeAuth,
  signInAgain,
  type IdentityProvider,
  type SessionState,
  type Workspace,
  type WorkspaceResolver,
} from '../../src/auth/index.ts';
import { ACTIVITY_KEY, PENDING_PREFIX, RESTORE_MARK_KEY, SIGNED_OUT_KEY } from '../../src/auth/oidc.ts';
import { WORKSPACE_CACHE_KEY } from '../../src/auth/workspace.ts';
import { RuntimeConfigSchema, setRuntimeConfig, type RuntimeConfig } from '../../src/config/index.ts';
import { initializeCore } from '../../src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { SESSION_ID_STORAGE_KEY } from '../../src/internal/session.ts';
import { storage } from '../../src/storage/index.ts';
import { CLIENT, FakeBroadcastChannel, FakeKeycloak, FakePage, IDP, ORIGIN, jwt } from './fakes.ts';

const TRIAL_TENANT = '0b7e4c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d';
const ACME: Workspace = { realm: 'tenant-acme', trial: false, slug: 'acme' };
const GLOBEX: Workspace = { realm: 'tenant-globex', trial: false, slug: 'globex' };
const BETA: Workspace = { realm: 'trial', trial: true, slug: 'beta-labs', tenantIdHint: TRIAL_TENANT };

let cfg: RuntimeConfig;
let kc: FakeKeycloak;
let resolver: WorkspaceResolver & { resolve: ReturnType<typeof vi.fn> };
let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;

// Timers are fake; WebCrypto (the PKCE challenge) settles on the real event loop, so a test that
// expects a redirect waits for it rather than for a fixed number of ticks.
const flush = async (until?: () => boolean) => {
  for (let i = 0; i < (until ? 500 : 5); i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
    if (until?.()) return;
  }
};
const authorizeParams = (page: FakePage) => new URL(page.assigned.at(-1)!).searchParams;
const cache = (page: FakePage, entries: { slug: string; realm: string; trial: boolean }[]) =>
  page.local.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(entries));

function provider(): IdentityProvider {
  return createOidcProvider(cfg.auth, resolver);
}

/** Interactive login in `page`, then the callback load: a fresh provider, as after Keycloak's redirect. */
async function signIn(page: FakePage, w: Workspace = ACME, o?: { claims?: Record<string, unknown>; returnUrl?: string }) {
  page.install();
  await provider().login({ workspace: w, returnUrl: o?.returnUrl ?? '/t/acme/tenders?tab=open' });
  page.url = new URL(kc.approve(page.assigned.at(-1)!, o?.claims ? { claims: o.claims } : undefined));
  const idp = provider();
  const state = await idp.init();
  return { idp, state };
}

beforeEach(() => {
  resetRuntimeForTests();
  FakeBroadcastChannel.reset();
  vi.useFakeTimers({ now: new Date('2026-10-30T10:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  kc = new FakeKeycloak();
  vi.stubGlobal('fetch', kc.fetch);
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // no refresh jitter
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  initializeCore({ serviceName: 'web-app', domain: 'iam', environment: 'dev', buildVersion: '1.0.0' });
  cfg = RuntimeConfigSchema.parse({
    api: { baseUrl: '/api' },
    telemetry: {},
    auth: { idpOrigin: IDP, idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
    remotes: { loadTimeoutMs: 10_000, retries: 0 },
    i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
    appUpdate: { pollIntervalMs: 300_000 },
  });
  setRuntimeConfig(cfg);
  resolver = { resolve: vi.fn(async () => undefined) };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('login', () => {
  it('redirects to the realm authorize endpoint with PKCE S256, and keeps a pending-login record', async () => {
    const page = new FakePage('/t/acme/tenders');
    page.install();
    const idp = provider();
    const reasons: string[] = [];
    idp.beforeRedirect((r) => reasons.push(r.reason));
    await idp.login({ workspace: ACME, returnUrl: '/t/acme/tenders?tab=open', loginHint: 'ada@example.com' });

    const url = new URL(page.assigned[0]!);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/realms/tenant-acme/protocol/openid-connect/auth`);
    const p = url.searchParams;
    expect(Object.fromEntries([...p].filter(([k]) => !['state', 'nonce', 'code_challenge'].includes(k)))).toEqual({
      response_type: 'code',
      client_id: CLIENT,
      redirect_uri: `${ORIGIN}/auth/callback`,
      scope: 'openid',
      code_challenge_method: 'S256',
      login_hint: 'ada@example.com',
    });
    expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128 bits
    expect(p.get('nonce')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(reasons).toEqual(['login']);

    const record = JSON.parse(page.session.getItem(`${PENDING_PREFIX}${p.get('state')}`)!);
    expect(record).toMatchObject({ state: p.get('state'), nonce: p.get('nonce'), workspace: ACME, returnUrl: '/t/acme/tenders?tab=open', reason: 'login' });
    expect(record.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes
    expect(createHash('sha256').update(record.codeVerifier).digest('base64url')).toBe(p.get('code_challenge'));
  });

  it('refuses a workspace whose realm could change the URL path', async () => {
    new FakePage('/').install();
    await expect(provider().login({ workspace: { realm: '../admin', trial: false } })).rejects.toThrow(TypeError);
  });

  it('cannot start without sessionStorage', async () => {
    const page = new FakePage('/');
    page.install();
    page.session.failWrites = true;
    await expect(provider().login({ workspace: ACME })).rejects.toThrow('sessionStorage');
    expect(page.assigned).toEqual([]);
  });

  it('stores an unsafe returnUrl as /', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME, returnUrl: 'https://evil.example/x' });
    const state = authorizeParams(page).get('state');
    expect(JSON.parse(page.session.getItem(`${PENDING_PREFIX}${state}`)!).returnUrl).toBe('/');
  });
});

describe('callback', () => {
  it('exchanges the code, checks the ID token, and lands on the returnUrl', async () => {
    const page = new FakePage('/t/acme/tenders');
    page.local.setItem(SIGNED_OUT_KEY, '1');
    const { idp, state } = await signIn(page, ACME, { claims: { auth_time: 1_793_000_000 } });

    expect(state).toEqual({
      status: 'authenticated',
      user: { sub: 'user-1', name: 'Ada', email: 'ada@example.com', authTime: 1_793_000_000 },
      workspace: ACME,
      expiresAt: Date.now() + 300_000,
    });
    expect(idp.getState()).toBe(state);
    expect(page.url.href).toBe(`${ORIGIN}/t/acme/tenders?tab=open`);
    const exchange = kc.requests[0]!;
    expect(exchange.grant).toBe('authorization_code');
    expect(exchange.body.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(await idp.getAccessToken()).toMatch(/^at-/);
    expect(getRuntime().storageNamespace).toBe('tenant-acme');
    // The record is gone, both marks are cleared, and no token was ever stored.
    expect([...Array(page.session.length).keys()].map((i) => page.session.key(i))).not.toContainEqual(expect.stringContaining(PENDING_PREFIX));
    expect(page.local.getItem(SIGNED_OUT_KEY)).toBeNull();
    const stored = page.storedValues();
    expect(stored).not.toMatch(/at-|eyJ|refresh/);
  });

  it('uses trial:<tenant_id> as the storage namespace in the trial realm, and anon without a valid one', async () => {
    const page = new FakePage('/t/beta-labs/');
    const { state } = await signIn(page, BETA, { claims: { tenant_id: TRIAL_TENANT } });
    expect(state.status === 'authenticated' && state.user.tenantId).toBe(TRIAL_TENANT);
    expect(getRuntime().storageNamespace).toBe(`trial:${TRIAL_TENANT}`);

    const { state: s2 } = await signIn(new FakePage('/t/beta-labs/'), BETA, { claims: { tenant_id: 'not-a-uuid' } });
    expect(s2.status).toBe('authenticated'); // the gateway decides access
    expect(getRuntime().storageNamespace).toBe('anon');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('no valid tenant_id'), expect.anything());
  });

  it('never reports tenant_id outside the trial realm', async () => {
    const { state } = await signIn(new FakePage('/'), ACME, { claims: { tenant_id: TRIAL_TENANT } });
    expect(state.status === 'authenticated' && state.user.tenantId).toBeUndefined();
  });

  it('rejects a callback whose iss is missing or another realm, without exchanging the code', async () => {
    for (const iss of [null, kc.issuer('tenant-globex')]) {
      const page = new FakePage('/');
      page.install();
      await provider().login({ workspace: ACME, returnUrl: '/t/acme/' });
      page.url = new URL(kc.approve(page.assigned.at(-1)!, { iss }));
      expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
      expect(page.url.pathname).toBe('/t/acme/');
    }
    expect(kc.requests).toEqual([]);
  });

  it.each([
    ['aud', { aud: 'other-client' }],
    ['azp', { azp: 'other-client' }],
    ['nonce', { nonce: 'replayed' }],
    ['exp', { exp: Math.floor(Date.parse('2026-10-30T09:58:00Z') / 1000) }],
    ['iat', { iat: Math.floor(Date.parse('2026-10-30T10:02:00Z') / 1000) }],
    ['iss', { iss: `${IDP}/realms/tenant-globex` }],
  ])('rejects an ID token with a bad %s and keeps no token', async (_name, claims) => {
    const page = new FakePage('/');
    const { idp, state } = await signIn(page, ACME, { claims });
    expect(state).toEqual({ status: 'anonymous', reason: 'none' });
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(getRuntime().storageNamespace).toBe('anon');
  });

  it('accepts exp and iat within 60 s of skew', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { state } = await signIn(new FakePage('/'), ACME, { claims: { exp: now - 30, iat: now + 30 } });
    expect(state.status).toBe('authenticated');
  });

  it('uses a code once: a replayed callback is ignored and its parameters stripped', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME, returnUrl: '/t/acme/' });
    const callback = kc.approve(page.assigned.at(-1)!);
    page.url = new URL(callback);
    expect((await provider().init()).status).toBe('authenticated');
    page.url = new URL(callback);
    page.session.removeItem(RESTORE_MARK_KEY);
    page.local.setItem(SIGNED_OUT_KEY, '1'); // keep the restore path quiet
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'signed-out' });
    expect(page.url.href).toBe(`${ORIGIN}/`);
    expect(kc.requests).toHaveLength(1);
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('callback ignored'), expect.anything());
  });

  it('ignores a record older than 10 minutes', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME });
    page.url = new URL(kc.approve(page.assigned.at(-1)!));
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(kc.requests).toEqual([]);
  });

  it('goes to / when the record returnUrl is not a safe redirect', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME });
    const state = authorizeParams(page).get('state')!;
    const key = `${PENDING_PREFIX}${state}`;
    page.session.setItem(key, JSON.stringify({ ...JSON.parse(page.session.getItem(key)!), returnUrl: '//evil.example/' }));
    page.url = new URL(kc.approve(page.assigned.at(-1)!));
    await provider().init();
    expect(page.url.href).toBe(`${ORIGIN}/`);
  });

  it('a prompt=none answer of login_required is anonymous login-required for that workspace', async () => {
    const page = new FakePage('/t/acme/tenders');
    cache(page, [{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    page.install();
    void provider().init(); // silent restore
    await flush(() => page.assigned.length > 0);
    expect(authorizeParams(page).get('prompt')).toBe('none');
    page.url = new URL(kc.deny(page.assigned.at(-1)!, 'login_required'));
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'login-required', workspace: { realm: 'tenant-acme', trial: false, slug: 'acme' } });
    expect(page.url.pathname).toBe('/t/acme/tenders');
  });

  it('an error on an interactive login is anonymous none', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME });
    page.url = new URL(kc.deny(page.assigned.at(-1)!, 'access_denied'));
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
  });
});

describe('restoring a session on page load', () => {
  it('redirects once with prompt=none to the cached workspace of the URL slug, and never settles', async () => {
    const page = new FakePage('/t/acme/tenders/42?x=1');
    cache(page, [
      { slug: 'globex', realm: 'tenant-globex', trial: false },
      { slug: 'acme', realm: 'tenant-acme', trial: false },
    ]);
    page.install();
    let settled = false;
    void provider().init().then(() => (settled = true));
    await flush(() => page.assigned.length > 0);
    expect(settled).toBe(false);
    expect(new URL(page.assigned[0]!).pathname).toBe('/realms/tenant-acme/protocol/openid-connect/auth');
    const state = authorizeParams(page).get('state')!;
    expect(JSON.parse(page.session.getItem(`${PENDING_PREFIX}${state}`)!)).toMatchObject({ reason: 'restore', returnUrl: '/t/acme/tenders/42?x=1' });
    expect(page.session.getItem(RESTORE_MARK_KEY)).not.toBeNull();

    // Keycloak's SSO session signs the user in silently; the mark is cleared.
    page.url = new URL(kc.approve(page.assigned[0]!));
    expect((await provider().init()).status).toBe('authenticated');
    expect(page.session.getItem(RESTORE_MARK_KEY)).toBeNull();
    expect(page.url.pathname).toBe('/t/acme/tenders/42');
  });

  it('never falls back to another cached workspace for a slug it has no entry for', async () => {
    const page = new FakePage('/t/globex/');
    cache(page, [{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(page.assigned).toEqual([]);
  });

  it('uses the most recent cached workspace when the URL has no slug', async () => {
    const page = new FakePage('/');
    cache(page, [
      { slug: 'globex', realm: 'tenant-globex', trial: false },
      { slug: 'acme', realm: 'tenant-acme', trial: false },
    ]);
    page.install();
    void provider().init();
    await flush(() => page.assigned.length > 0);
    expect(new URL(page.assigned[0]!).pathname).toContain('/realms/tenant-globex/');
  });

  it('the loop guard allows one attempt per tab', async () => {
    const page = new FakePage('/t/acme/');
    cache(page, [{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    page.session.setItem(RESTORE_MARK_KEY, '1');
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(page.assigned).toEqual([]);
  });

  it('the signed-out mark skips the restore', async () => {
    const page = new FakePage('/t/acme/');
    cache(page, [{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    page.local.setItem(SIGNED_OUT_KEY, '1');
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'signed-out' });
    expect(page.assigned).toEqual([]);
  });

  it('no cache, no hint: anonymous none', async () => {
    new FakePage('/').install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
  });
});

describe('refresh', () => {
  it('runs at exp − 60 s and rotates the refresh token', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    const first = await idp.getAccessToken();
    await vi.advanceTimersByTimeAsync(239_000);
    expect(kc.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kc.requests.map((r) => r.grant)).toEqual(['authorization_code', 'refresh_token']);
    expect(await idp.getAccessToken()).not.toBe(first);
    // The timer keeps the session going, each time with the token the last refresh returned.
    await vi.advanceTimersByTimeAsync(240_000 * 4);
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(5);
    expect(kc.reuseDetected).toBe(0);
    expect(idp.getState().status).toBe('authenticated');
  });

  it('is single-flight: concurrent callers share one request', async () => {
    const { idp } = await signIn(new FakePage('/'));
    const results = await Promise.all([idp.refresh(), idp.refresh(), idp.refresh(), idp.getAccessToken()]);
    expect(results.slice(0, 3)).toEqual([true, true, true]);
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(1);
    await Promise.all([idp.refresh(), idp.refresh()]);
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(2);
    expect(kc.reuseDetected).toBe(0);
  });

  it('gives each tab its own lineage: alternate refreshes never look like reuse', async () => {
    const shared = new FakePage('/').local;
    const a = new FakePage('/', shared);
    const b = new FakePage('/', shared);
    const { idp: tabA } = await signIn(a);
    const { idp: tabB } = await signIn(b);
    for (let round = 0; round < 5; round++) {
      a.install();
      expect(await tabA.refresh()).toBe(true);
      b.install();
      expect(await tabB.refresh()).toBe(true);
    }
    expect(kc.reuseDetected).toBe(0);
  });

  it('joins the refresh when the access token has expired', async () => {
    const { idp } = await signIn(new FakePage('/'));
    vi.setSystemTime(Date.now() + 299_000);
    const [t1, t2] = await Promise.all([idp.getAccessToken(), idp.getAccessToken()]);
    expect(t1).toBe(t2);
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(1);
  });

  it('invalid_grant before the refresh token expiry is a server-ended session', async () => {
    const { idp } = await signIn(new FakePage('/'));
    const states: SessionState[] = [];
    idp.subscribe((s) => states.push(s));
    kc.sessionRevoked = true; // e.g. trial → paid conversion terminated the sessions
    expect(await idp.refresh()).toBe(false);
    expect(states.at(-1)).toEqual({ status: 'expired', workspace: ACME, serverEnded: true, idle: false });
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(await idp.refresh()).toBe(false);
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(1);
  });

  it('a refresh token past its own expiry ends the session naturally, without sending it', async () => {
    kc.refreshTtl = 600;
    const { idp } = await signIn(new FakePage('/'));
    vi.setSystemTime(Date.now() + 601_000);
    expect(await idp.refresh()).toBe(false);
    expect(idp.getState()).toEqual({ status: 'expired', workspace: ACME, serverEnded: false, idle: false });
    expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(0);
  });

  it.each(['network-after-send', 'server-error', 'bad-id-token'] as const)(
    'after an ambiguous failure (%s) drops the lineage and restores with prompt=none, never resending the token',
    async (failure) => {
      const page = new FakePage('/');
      const { idp } = await signIn(page, ACME, { returnUrl: '/t/acme/tenders/7' });
      const reasons: string[] = [];
      idp.beforeRedirect((r) => reasons.push(r.reason));
      page.assigned.length = 0;
      kc.failures = [failure];
      expect(await idp.refresh()).toBe(false);
      await flush(() => page.assigned.length > 0);
      expect(await idp.getAccessToken()).toBeUndefined();
      expect(reasons).toEqual(['restore']);
      const p = authorizeParams(page);
      expect(p.get('prompt')).toBe('none');
      expect(new URL(page.assigned[0]!).pathname).toContain('/realms/tenant-acme/');
      expect(JSON.parse(page.session.getItem(`${PENDING_PREFIX}${p.get('state')}`)!).returnUrl).toBe('/t/acme/tenders/7');
      expect(await idp.refresh()).toBe(false);
      expect(kc.requests.filter((r) => r.grant === 'refresh_token')).toHaveLength(1);
      expect(kc.reuseDetected).toBe(0);
    },
  );

  it('an ambiguous failure while offline waits for the online event before redirecting', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    page.assigned.length = 0;
    kc.failures = ['network-after-send'];
    kc.fetch.mockImplementationOnce(async () => {
      page.online = false;
      throw new TypeError('Failed to fetch');
    });
    await idp.refresh();
    await flush();
    expect(page.assigned).toEqual([]);
    page.goOnline();
    await flush(() => page.assigned.length > 0);
    expect(authorizeParams(page).get('prompt')).toBe('none');
  });

  it('offline at the start keeps the token and refreshes once online', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    const token = await idp.getAccessToken();
    page.online = false;
    expect(await idp.refresh()).toBe(false);
    expect(kc.requests).toHaveLength(1);
    expect(await idp.getAccessToken()).toBe(token);
    page.goOnline();
    await flush();
    expect(kc.requests.map((r) => r.grant)).toEqual(['authorization_code', 'refresh_token']);
    expect(await idp.getAccessToken()).not.toBe(token);
    expect(page.assigned.filter((u) => u.includes('prompt=none'))).toEqual([]);
  });
});

describe('idle timeout', () => {
  it('expires every tab together after idleTimeoutMs without activity, and rotates the session id', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    const sid = page.local.getItem(SESSION_ID_STORAGE_KEY);
    await vi.advanceTimersByTimeAsync(1_800_000 + 15_000);
    expect(idp.getState()).toEqual({ status: 'expired', workspace: ACME, serverEnded: false, idle: true });
    expect(page.local.getItem(SESSION_ID_STORAGE_KEY)).not.toBe(sid);
    expect(await idp.getAccessToken()).toBeUndefined();
  });

  it('activity in any tab keeps the session alive', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(1_000_000);
      if (i % 2) page.events.dispatchEvent(new Event('keydown'));
      else page.local.setItem(ACTIVITY_KEY, String(Date.now())); // another tab
    }
    expect(idp.getState().status).toBe('authenticated');
  });
});

describe('logout', () => {
  it('local: drops tokens, clears app storage, rotates the session id, marks signed-out, tells other tabs', async () => {
    const shared = new FakePage('/').local;
    const a = new FakePage('/', shared);
    const b = new FakePage('/', shared);
    const { idp: tabB } = await signIn(b);
    const { idp: tabA } = await signIn(a);
    storage('tenders').set('filter', 'open');
    const sid = shared.getItem(SESSION_ID_STORAGE_KEY);
    const cached = JSON.stringify([{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    shared.setItem(WORKSPACE_CACHE_KEY, cached);

    await tabA.logout();
    expect(tabA.getState()).toEqual({ status: 'anonymous', workspace: ACME, reason: 'signed-out' });
    expect(await tabA.getAccessToken()).toBeUndefined();
    expect(shared.getItem('tenant-acme:tenders:filter')).toBeNull();
    expect(shared.getItem(WORKSPACE_CACHE_KEY)).toBe(cached); // the next login needs it
    expect(shared.getItem(SESSION_ID_STORAGE_KEY)).not.toBe(sid);
    expect(shared.getItem(SIGNED_OUT_KEY)).not.toBeNull();
    expect(FakeBroadcastChannel.sent).toEqual([{ type: 'logout' }]);
    expect(a.assigned.filter((u) => u.includes('/logout'))).toEqual([]);

    await flush();
    expect(tabB.getState()).toEqual({ status: 'anonymous', workspace: ACME, reason: 'signed-out' });
    expect(await tabB.getAccessToken()).toBeUndefined();

    // A reload does not undo it, although Keycloak's SSO session is still alive.
    a.url = new URL('/t/acme/', ORIGIN);
    a.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'signed-out' });
  });

  it('global: also ends the SSO session at the realm logout endpoint', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    await idp.logout({ global: true });
    const url = new URL(page.assigned.at(-1)!);
    expect(`${url.origin}${url.pathname}`).toBe(`${IDP}/realms/tenant-acme/protocol/openid-connect/logout`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe(`${ORIGIN}/`);
    expect(url.searchParams.get('id_token_hint')!.split('.')).toHaveLength(3);
  });

  it('the channel never carries a token', async () => {
    const { idp } = await signIn(new FakePage('/'));
    await idp.switchWorkspace(GLOBEX);
    await idp.logout();
    expect(JSON.stringify(FakeBroadcastChannel.sent)).not.toMatch(/at-|eyJ/);
  });
});

describe('switchWorkspace', () => {
  it('logs out of the current realm locally, then logs in to the new one', async () => {
    const shared = new FakePage('/').local;
    const b = new FakePage('/', shared);
    const a = new FakePage('/', shared);
    const { idp: tabB } = await signIn(b);
    const { idp: tabA } = await signIn(a);
    storage('tenders').set('filter', 'open');
    const reasons: string[] = [];
    tabA.beforeRedirect((r) => reasons.push(r.reason));
    await tabA.switchWorkspace(GLOBEX);
    expect(await tabA.getAccessToken()).toBeUndefined();
    expect(shared.getItem('tenant-acme:tenders:filter')).toBeNull();
    expect(shared.getItem(SIGNED_OUT_KEY)).toBeNull();
    expect(reasons).toEqual(['switch']);
    expect(new URL(a.assigned.at(-1)!).pathname).toContain('/realms/tenant-globex/');
    expect(FakeBroadcastChannel.sent).toEqual([{ type: 'workspace-switched' }]);
    await flush();
    expect(tabB.getState()).toEqual({ status: 'expired', workspace: ACME, serverEnded: false, idle: false });
  });
});

describe('step-up', () => {
  it('needsStepUp compares auth_time with the window; unknown is false', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { idp } = await signIn(new FakePage('/'), ACME, { claims: { auth_time: now - 600 } });
    expect(idp.needsStepUp(300)).toBe(true);
    expect(idp.needsStepUp(900)).toBe(false);
    const { idp: noAuthTime } = await signIn(new FakePage('/'));
    expect(noAuthTime.needsStepUp(0)).toBe(false);
  });

  it('reauthenticate redirects with prompt=login and max_age after beforeRedirect', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    const reasons: string[] = [];
    idp.beforeRedirect(() => {
      throw new Error('listener bug'); // logged and ignored
    });
    idp.beforeRedirect((r) => reasons.push(r.reason));
    await idp.reauthenticate({ maxAgeSeconds: 300, returnUrl: '/t/acme/approvals/9' });
    const p = authorizeParams(page);
    expect([p.get('prompt'), p.get('max_age')]).toEqual(['login', '300']);
    expect(reasons).toEqual(['step-up']);
    expect(JSON.parse(page.session.getItem(`${PENDING_PREFIX}${p.get('state')}`)!)).toMatchObject({ reason: 'step-up', returnUrl: '/t/acme/approvals/9' });
  });

  it('reauthenticate needs a session', async () => {
    new FakePage('/').install();
    await expect(provider().reauthenticate({ maxAgeSeconds: 300 })).rejects.toThrow('signed-in');
  });
});

describe('initializeAuth and getSession', () => {
  it('installs the provider and the TokenSource /http uses; onUnauthorized never redirects', async () => {
    expect(getSession()).toEqual({ status: 'loading' });
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    page.assigned.length = 0;
    const source = initializeAuth(idp);
    expect(getRuntime().tokenSource).toBe(source);
    expect(getSession()).toBe(idp.getState());
    expect(await source.getAccessToken()).toBe(await idp.getAccessToken());
    expect(await source.refresh()).toBe(true);
    source.onUnauthorized();
    expect(page.assigned).toEqual([]);
    expect(getSession().status).toBe('authenticated');
  });
});

describe('signInAgain', () => {
  const expired = (o: { serverEnded: boolean; idle: boolean }) => ({ status: 'expired', workspace: ACME, ...o }) as const;

  it('after the idle timeout logs in with prompt=login to the cached workspace', async () => {
    const page = new FakePage('/t/acme/tenders?x=1');
    cache(page, [{ slug: 'acme', realm: 'tenant-acme', trial: false }]);
    page.install();
    const idp = provider();
    await signInAgain({ idp, state: expired({ serverEnded: false, idle: true }), resolver, cfg: cfg.auth, ask: vi.fn() });
    const p = authorizeParams(page);
    expect(p.get('prompt')).toBe('login');
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(JSON.parse(page.session.getItem(`${PENDING_PREFIX}${p.get('state')}`)!).returnUrl).toBe('/t/acme/tenders?x=1');
  });

  it('after a server-ended session resolves the slug again (trial → paid moved the realm)', async () => {
    const page = new FakePage('/t/beta-labs/');
    cache(page, [{ slug: 'beta-labs', realm: 'trial', trial: true }]);
    page.install();
    resolver.resolve.mockResolvedValue({ realm: 'tenant-beta-labs', trial: false });
    await signInAgain({ idp: provider(), state: expired({ serverEnded: true, idle: false }), resolver, cfg: cfg.auth, ask: vi.fn() });
    expect(resolver.resolve).toHaveBeenCalledWith('beta-labs', undefined);
    expect(new URL(page.assigned.at(-1)!).pathname).toContain('/realms/tenant-beta-labs/');
    expect(authorizeParams(page).get('prompt')).toBeNull();
  });

  it('falls back to ask() when no workspace can be chosen', async () => {
    const page = new FakePage('/');
    page.install();
    const ask = vi.fn(async () => GLOBEX);
    await signInAgain({ idp: provider(), state: expired({ serverEnded: false, idle: false }), resolver, cfg: cfg.auth, ask });
    expect(ask).toHaveBeenCalledOnce();
    expect(new URL(page.assigned.at(-1)!).pathname).toContain('/realms/tenant-globex/');
  });
});

it('jwt helper builds three-part tokens', () => {
  expect(jwt({ a: 1 }).split('.')).toHaveLength(3);
});
