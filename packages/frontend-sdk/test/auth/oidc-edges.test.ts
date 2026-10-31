// Edge cases of the OIDC provider: malformed ID tokens and token responses, storage that is denied,
// refresh races with logout, timeouts, the cross-tab channel being unavailable, and listener handling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOidcProvider, initializeAuth, type IdentityProvider, type SessionState, type Workspace } from '../../src/auth/index.ts';
import { ACTIVITY_KEY, PENDING_PREFIX, RESTORE_MARK_KEY, setAuthInternalsForTests } from '../../src/auth/oidc.ts';
import { WORKSPACE_CACHE_KEY } from '../../src/auth/workspace.ts';
import { RuntimeConfigSchema, setRuntimeConfig, type RuntimeConfig } from '../../src/config/index.ts';
import { initializeCore } from '../../src/core/index.ts';
import { resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { FakeBroadcastChannel, FakeKeycloak, FakePage, IDP, jwt } from './fakes.ts';

const ACME: Workspace = { realm: 'tenant-acme', trial: false, slug: 'acme' };

let cfg: RuntimeConfig;
let kc: FakeKeycloak;
let real: (input: string | URL, init?: RequestInit) => Promise<Response>;
let errors: ReturnType<typeof vi.spyOn>;
let warns: ReturnType<typeof vi.spyOn>;

// WebCrypto (the PKCE challenge) settles on the real event loop: wait for it, not for a tick count.
const flush = async (until?: () => boolean) => {
  for (let i = 0; i < (until ? 500 : 5); i++) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise((r) => setImmediate(r));
    if (until?.()) return;
  }
};
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
const refreshes = () => kc.requests.filter((r) => r.grant === 'refresh_token');
const provider = (): IdentityProvider => createOidcProvider(cfg.auth, { resolve: vi.fn(async () => undefined) });

/** The next token response, passed through `edit` (the real Keycloak answer, as JSON). */
function rewriteNext(edit: (body: Record<string, unknown>) => Record<string, unknown>): void {
  kc.fetch.mockImplementationOnce(async (input, init) => {
    const res = await real(input, init);
    return json(res.status, edit((await res.json()) as Record<string, unknown>));
  });
}

async function signIn(page: FakePage, o?: { claims?: Record<string, unknown> }) {
  page.install();
  await provider().login({ workspace: ACME, returnUrl: '/t/acme/' });
  page.url = new URL(kc.approve(page.assigned.at(-1)!, o?.claims ? { claims: o.claims } : undefined));
  const idp = provider();
  const state = await idp.init();
  page.assigned.length = 0;
  return { idp, state };
}

/** Makes `globalThis.sessionStorage` throw on access (a sandboxed iframe, blocked site data). */
function denySessionStorage(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new DOMException('denied', 'SecurityError');
    },
  });
}

beforeEach(() => {
  resetRuntimeForTests();
  FakeBroadcastChannel.reset();
  vi.useFakeTimers({ now: new Date('2026-10-30T10:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  kc = new FakeKeycloak();
  real = kc.fetch.getMockImplementation()!;
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
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('callback: malformed answers', () => {
  it.each([
    ['no dots at all', 'not-a-jwt'],
    ['a payload that is not base64', 'a.!!!.c'],
    ['a payload that is not JSON', `a.${Buffer.from('hello').toString('base64url')}.c`],
    ['a payload that is a JSON array', `a.${Buffer.from('[1]').toString('base64url')}.c`],
  ])('rejects an ID token with %s and keeps no token', async (_n, idToken) => {
    rewriteNext((b) => ({ ...b, id_token: idToken }));
    const { idp, state } = await signIn(new FakePage('/'));
    expect(state).toEqual({ status: 'anonymous', reason: 'none' });
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('callback rejected'), expect.anything());
  });

  it('rejects an ID token without a sub', async () => {
    const { state } = await signIn(new FakePage('/'), { claims: { sub: '' } });
    expect(state).toEqual({ status: 'anonymous', reason: 'none' });
  });

  it('rejects a code exchange answer with no ID token (no identity to bind the session to)', async () => {
    rewriteNext(({ id_token: _drop, ...b }) => b);
    const { idp, state } = await signIn(new FakePage('/'));
    expect(state).toEqual({ status: 'anonymous', reason: 'none' });
    expect(await idp.getAccessToken()).toBeUndefined();
  });

  it('a code exchange with a tampered PKCE verifier fails at Keycloak and stays anonymous', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME });
    const state = new URL(page.assigned.at(-1)!).searchParams.get('state')!;
    const key = `${PENDING_PREFIX}${state}`;
    page.session.setItem(key, JSON.stringify({ ...JSON.parse(page.session.getItem(key)!), codeVerifier: 'x'.repeat(43) }));
    page.url = new URL(kc.approve(page.assigned.at(-1)!));
    const idp = provider();
    expect(await idp.init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(kc.requests).toHaveLength(1);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('callback rejected'), expect.objectContaining({ 'exception.message': 'token endpoint answered 400 invalid_grant' }));
  });

  it('a non-JSON error page from the token endpoint is a rejected callback', async () => {
    kc.fetch.mockImplementationOnce(async () => new Response('<html>Bad Gateway</html>', { status: 502 }));
    const { idp, state } = await signIn(new FakePage('/'));
    expect(state).toEqual({ status: 'anonymous', reason: 'none' });
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('callback rejected'), expect.objectContaining({ 'exception.message': 'token endpoint answered 502' }));
  });

  it('an empty code is anonymous and never reaches the token endpoint', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME, returnUrl: '/t/acme/' });
    const cb = new URL(kc.approve(page.assigned.at(-1)!));
    cb.searchParams.set('code', '');
    page.url = cb;
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(kc.requests).toEqual([]);
  });

  it('ignores a malformed state without looking it up, and strips the callback parameters', async () => {
    const page = new FakePage('/auth/callback?code=abc&state=short&iss=x');
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(page.url.href).toBe(new URL('/', page.url).href);
    expect(kc.requests).toEqual([]);
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('callback ignored'), expect.anything());
  });
});

describe('pending-login records', () => {
  it('a page load purges expired, future-dated and malformed records, and keeps fresh and unrelated keys', async () => {
    const page = new FakePage('/');
    page.install();
    await provider().login({ workspace: ACME });
    const fresh = `${PENDING_PREFIX}${new URL(page.assigned[0]!).searchParams.get('state')}`;
    const record = JSON.parse(page.session.getItem(fresh)!) as Record<string, unknown>;
    const now = Date.now();
    page.session.setItem(`${PENDING_PREFIX}badjson`, '{not json');
    page.session.setItem(`${PENDING_PREFIX}noworkspace`, JSON.stringify({ ...record, workspace: { trial: false } }));
    page.session.setItem(`${PENDING_PREFIX}notrial`, JSON.stringify({ ...record, workspace: { realm: 'tenant-acme' } }));
    page.session.setItem(`${PENDING_PREFIX}old`, JSON.stringify({ ...record, createdAt: now - 11 * 60_000 }));
    page.session.setItem(`${PENDING_PREFIX}future`, JSON.stringify({ ...record, createdAt: now + 11 * 60_000 }));
    page.session.setItem('unrelated', 'kept');

    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    const keys = [...Array(page.session.length).keys()].map((i) => page.session.key(i));
    expect(keys.sort()).toEqual([fresh, 'unrelated'].sort());
  });
});

describe('storage that is denied', () => {
  it('login refuses to start without sessionStorage, and never redirects', async () => {
    const page = new FakePage('/');
    page.install();
    denySessionStorage();
    await expect(provider().login({ workspace: ACME })).rejects.toThrow('sign-in needs sessionStorage');
    expect(page.assigned).toEqual([]);
  });

  it('no restore attempt when the loop guard cannot be read back (never risk a redirect loop)', async () => {
    const page = new FakePage('/t/acme/');
    page.local.setItem(WORKSPACE_CACHE_KEY, JSON.stringify([{ slug: 'acme', realm: 'tenant-acme', trial: false }]));
    page.session.failReads = true;
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    await flush();
    expect(page.assigned).toEqual([]);
  });

  it('a cached realm the provider refuses is logged and the page stays anonymous', async () => {
    const page = new FakePage('/t/acme/');
    page.local.setItem(WORKSPACE_CACHE_KEY, JSON.stringify([{ slug: 'acme', realm: 'Tenant_Acme/../x', trial: false }]));
    page.install();
    expect(await provider().init()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(page.assigned).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('silent sign-in could not start'), expect.anything());
  });

  it('a refresh failure that cannot set the loop guard expires the session instead of redirecting', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    kc.failures = ['server-error'];
    page.session.failWrites = true;
    expect(await idp.refresh()).toBe(false);
    await flush();
    expect(idp.getState()).toEqual({ status: 'expired', workspace: ACME, serverEnded: false, idle: false });
    expect(page.assigned).toEqual([]);
    expect(page.session.getItem(RESTORE_MARK_KEY)).toBeNull();
  });
});

describe('refresh edge cases', () => {
  it('accepts a refreshed ID token without a nonce, and keeps the last ID token when a refresh returns none', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    const before = await idp.getAccessToken();

    let last = '';
    rewriteNext((b) => {
      const { nonce: _n, ...claims } = claimsOf(b.id_token as string);
      last = jwt(claims);
      return { ...b, id_token: last };
    });
    expect(await idp.refresh()).toBe(true);

    rewriteNext(({ id_token: _drop, ...b }) => b);
    expect(await idp.refresh()).toBe(true);
    expect(await idp.getAccessToken()).not.toBe(before);
    expect(idp.getState().status).toBe('authenticated');

    await idp.logout({ global: true });
    // The logout hint is the last ID token Keycloak issued, not lost when a refresh omits it.
    expect(new URL(page.assigned.at(-1)!).searchParams.get('id_token_hint')).toBe(last);
  });

  it.each([
    ['the sub changed', (c: Record<string, unknown>) => ({ ...c, sub: 'user-2' })],
    ['another nonce', (c: Record<string, unknown>) => ({ ...c, nonce: 'other' })],
  ])('rejects a refreshed ID token with %s and restores the session silently', async (_n, edit) => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    rewriteNext((b) => ({ ...b, id_token: jwt(edit(claimsOf(b.id_token as string))) }));
    expect(await idp.refresh()).toBe(false);
    await flush(() => page.assigned.length > 0);
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(new URL(page.assigned[0]!).searchParams.get('prompt')).toBe('none');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('refresh answer rejected'), expect.anything());
  });

  it('a 200 answer without an access token restores the session and never resends the refresh token', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    rewriteNext(({ access_token: _drop, ...b }) => b);
    expect(await idp.refresh()).toBe(false);
    await flush(() => page.assigned.length > 0);
    expect(new URL(page.assigned[0]!).searchParams.get('prompt')).toBe('none');
    expect(await idp.refresh()).toBe(false);
    expect(refreshes()).toHaveLength(1);
  });

  it('a non-JSON error page is ambiguous: restores with prompt=none', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    kc.fetch.mockImplementationOnce(async () => new Response('<html>oops</html>', { status: 503 }));
    expect(await idp.refresh()).toBe(false);
    await flush(() => page.assigned.length > 0);
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('token refresh failed'), expect.objectContaining({ status: 503 }));
    expect(new URL(page.assigned[0]!).searchParams.get('prompt')).toBe('none');
  });

  it('a token request that hangs is aborted after 15 s and treated as ambiguous', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    let signal: AbortSignal | undefined;
    kc.fetch.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_res, rej) => {
          signal = init!.signal!;
          signal.addEventListener('abort', () => rej(signal!.reason));
        }),
    );
    const result = idp.refresh();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await result).toBe(false);
    await flush(() => page.assigned.length > 0);
    expect(new URL(page.assigned[0]!).searchParams.get('prompt')).toBe('none');
  });

  it.each([
    ['resolves', () => json(200, { access_token: 'at-late', refresh_token: 'rt-late', expires_in: 300 })],
    ['fails', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('a logout while the refresh is in flight wins: the late answer that %s is discarded', async (_n, answer) => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    let release!: () => void;
    kc.fetch.mockImplementationOnce(() => new Promise<void>((r) => (release = r)).then(answer));
    const result = idp.refresh();
    await flush();
    await idp.logout();
    release();
    expect(await result).toBe(false);
    await flush();
    expect(idp.getState()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
    expect(await idp.getAccessToken()).toBeUndefined();
    expect(page.assigned).toEqual([]); // no restore redirect
    expect(page.storedValues()).not.toMatch(/at-late|rt-late/);
  });

  it('never rejects: an unexpected error is logged, resolves false, and the next refresh runs', async () => {
    const { idp } = await signIn(new FakePage('/'));
    kc.fetch.mockImplementationOnce(
      async () =>
        ({
          status: 200,
          json: async () => ({}),
          get ok(): boolean {
            throw new Error('boom');
          },
        }) as unknown as Response,
    );
    expect(await idp.refresh()).toBe(false);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('token refresh failed'), expect.anything());
    expect(await idp.refresh()).toBe(true); // the single-flight slot was released
  });

  it('offline: an offline event is ignored, the online event refreshes', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    page.online = false;
    expect(await idp.refresh()).toBe(false);
    page.events.dispatchEvent(new Event('offline'));
    await flush();
    expect(refreshes()).toHaveLength(0);
    page.goOnline();
    await flush();
    expect(refreshes()).toHaveLength(1);
  });

  it('offline after an ambiguous failure: an offline event is ignored, a logout cancels the pending restore', async () => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    kc.fetch.mockImplementationOnce(async () => {
      page.online = false;
      throw new TypeError('Failed to fetch');
    });
    expect(await idp.refresh()).toBe(false);
    page.events.dispatchEvent(new Event('offline'));
    await flush();
    expect(page.assigned).toEqual([]);
    await idp.logout();
    page.goOnline();
    await flush();
    expect(page.assigned).toEqual([]);
    expect(idp.getState()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
  });

  it('jitters the refresh by up to ±10 s around exp − 60 s', async () => {
    try {
      setAuthInternalsForTests({ random: () => 1 }); // +10 s
      const late = await signIn(new FakePage('/'));
      await vi.advanceTimersByTimeAsync(249_999);
      expect(refreshes()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshes()).toHaveLength(1);
      await late.idp.logout();

      setAuthInternalsForTests({ random: () => 0 }); // −10 s
      kc.requests.length = 0;
      await signIn(new FakePage('/'));
      await vi.advanceTimersByTimeAsync(229_999);
      expect(refreshes()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshes()).toHaveLength(1);
    } finally {
      setAuthInternalsForTests({ random: () => Math.random() });
    }
  });
});

describe('idle activity', () => {
  it('debounces activity writes to one per 5 s', async () => {
    const page = new FakePage('/');
    await signIn(page);
    const first = page.local.getItem(ACTIVITY_KEY);
    await vi.advanceTimersByTimeAsync(4_000);
    page.events.dispatchEvent(new Event('pointerdown'));
    expect(page.local.getItem(ACTIVITY_KEY)).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    page.events.dispatchEvent(new Event('pointerdown'));
    expect(page.local.getItem(ACTIVITY_KEY)).toBe(String(Date.now()));
  });
});

describe('the cross-tab channel and listeners', () => {
  it('works without BroadcastChannel when its constructor throws', async () => {
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        constructor() {
          throw new Error('blocked');
        }
      },
    );
    const page = new FakePage('/');
    const { idp, state } = await signIn(page);
    expect(state.status).toBe('authenticated');
    await idp.logout();
    expect(idp.getState()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
  });

  it('a throwing session listener is logged and the others still hear; unsubscribe stops delivery', async () => {
    const page = new FakePage('/');
    page.install();
    const idp = provider();
    const heard: SessionState[] = [];
    const gone: SessionState[] = [];
    idp.subscribe(() => {
      throw new Error('listener bug');
    });
    idp.subscribe((s) => heard.push(s));
    const off = idp.subscribe((s) => gone.push(s));
    off();
    await idp.init();
    expect(heard).toEqual([{ status: 'anonymous', reason: 'none' }]);
    expect(gone).toEqual([]);
    expect(idp.getState()).toEqual({ status: 'anonymous', reason: 'none' });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('session listener failed'), expect.anything());
  });

  it('an unsubscribed beforeRedirect listener is not called', async () => {
    const page = new FakePage('/');
    page.install();
    const idp = provider();
    const reasons: string[] = [];
    const off = idp.beforeRedirect((r) => reasons.push(r.reason));
    off();
    await idp.login({ workspace: ACME });
    expect(page.assigned).toHaveLength(1);
    expect(reasons).toEqual([]);
  });
});

describe('reauthenticate and initializeAuth arguments', () => {
  it.each([-1, 1.5, Number.NaN, undefined])('reauthenticate refuses maxAgeSeconds %s without redirecting', async (maxAgeSeconds) => {
    const page = new FakePage('/');
    const { idp } = await signIn(page);
    await expect(idp.reauthenticate({ maxAgeSeconds } as { maxAgeSeconds: number })).rejects.toThrow(TypeError);
    expect(page.assigned).toEqual([]);
  });

  it.each([undefined, {}, { getAccessToken: () => undefined }])('initializeAuth refuses %j', (p) => {
    expect(() => initializeAuth(p as unknown as IdentityProvider)).toThrow(TypeError);
  });
});
