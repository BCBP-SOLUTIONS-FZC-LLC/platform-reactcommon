// @vitest-environment happy-dom
// The reference shell (examples/shell) booted end to end in-process, as platform-gincommon's e2e
// builds its demo server: the real bootstrap, screens and App, the real tenders remote component,
// and the SDK from source. Around them: a FakePage (location, history, storage), a FakeNetwork that
// serves the deploy's files and the APIs, a FakeKeycloak at the IdP origin and an in-memory collector.
//
// Stubbed seams, and why:
// - the remote's entry <script> (mfe setMfeInternalsForTests.injectScript): happy-dom does not run
//   webpack's remoteEntry.js; the stub defines the container global the way it does, exposing the
//   real examples/remote-tenders/src/EditTender module;
// - __ENVIRONMENT__ / __BUILD_VERSION__: webpack DefinePlugin constants, set as globals here;
// - react-dom/client's createRoot is wrapped only to unmount the app root between page loads.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ComponentType } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession } from '../../packages/frontend-sdk/src/auth/index.ts';
import { SIGNED_OUT_KEY } from '../../packages/frontend-sdk/src/auth/oidc.ts';
import { resetRuntimeForTests } from '../../packages/frontend-sdk/src/internal/runtime.ts';
import { PlatformProblemTypes } from '../../packages/frontend-sdk/src/problem/index.ts';
import { resetContainersForTests, setMfeInternalsForTests } from '../../packages/frontend-sdk/src/mfe/remote.ts';
import { storage } from '../../packages/frontend-sdk/src/storage/index.ts';
import { mockProblem } from '../../packages/frontend-sdk/src/testing/index.ts';
import { endWorld, useFakeClock } from '../fixtures/boot.ts';
import { FakeBroadcastChannel, FakeKeycloak, FakePage, IDP, ORIGIN } from '../fixtures/keycloak.ts';
import { FakeNetwork } from '../fixtures/network.ts';
import { Collector, unloadTelemetry } from '../fixtures/telemetry.ts';
import { testenv } from '../testenv/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const appRoots = vi.hoisted(() => [] as { root: Root; container: Element }[]);
vi.mock('react-dom/client', async (importOriginal) => {
  const m = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...m,
    createRoot: (container: Element, o?: Parameters<typeof m.createRoot>[1]) => {
      const root = m.createRoot(container, o);
      appRoots.push({ root, container });
      return root;
    },
  };
});

// The examples are imported at run time: they are type-checked by their own tsconfig (which maps
// @bcbp-solutions-fzc-llc/frontend-sdk/* to the SDK source, as vitest.config.ts aliases it).
const example = (path: string) => import(/* @vite-ignore */ join(testenv.root, 'examples', path));
const shell = async () => (await example('shell/src/bootstrap.tsx')) as { bootstrap(): Promise<void> };
const screen = async () => (await example('shell/src/screen.tsx')) as { hideScreen(): void };
const editTender = async () => (await example('remote-tenders/src/EditTender.tsx')) as { default: ComponentType<{ id: string }> };

/** The deploy's /config/runtime.json, pointed at the fake Keycloak, every trace sampled, no load retries. */
const RUNTIME_CONFIG = (() => {
  const c = JSON.parse(readFileSync(join(testenv.root, 'examples/shell/public/config/runtime.json'), 'utf8'));
  return { ...c, auth: { ...c.auth, idpOrigin: IDP }, telemetry: { ...c.telemetry, sampleRatio: 1 }, remotes: { ...c.remotes, retries: 0 } };
})();
const ENTRY = '/remotes/tenders/1.0.0/remoteEntry.js';
const TENANT = '7d3c1f9e-2b4a-4c6d-8e0f-1a2b3c4d5e6f';
const TENDER = { id: '1', title: 'Road works', deadline: '2026-12-01', version: 3 };

let kc: FakeKeycloak;
let net: FakeNetwork;
let page: FakePage;
let collector: Collector;
let injected: string[];
/** How the next container.get answers; the real module by default. */
let exposeModule: (module: string) => Promise<() => unknown>;

let bootError: unknown;

/** Runs `fn` as the browser would deliver it, inside React's act so renders and Suspense retries flush. */
const user = (fn: () => void) => act(async () => fn());

/**
 * Lets the page run until `done()`: the real event loop (WebCrypto, fetch bodies) and the fake
 * clock, inside act so React commits what they caused.
 */
async function until(done: () => boolean): Promise<void> {
  // 200 turns of the fake clock (5 s of page time), then up to 2 s more of real time with the clock held:
  // WebCrypto (PKCE) runs on real time, which a busy 2-core CI runner stretched past the 200 turns (the
  // Sign in redirect "never" came), and more page time would fire timers the test did not ask for.
  const start = process.hrtime.bigint();
  const realMs = () => Number(process.hrtime.bigint() - start) / 1e6;
  for (let i = 0; i < 200 || realMs() < 2_000; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
      if (i < 200) await vi.advanceTimersByTimeAsync(25);
    });
    if (bootError) throw bootError;
    if (done()) return;
  }
  throw new Error(`the page never reached the expected state; it shows: ${document.body.innerHTML}`);
}

/** A few turns of the event loop, for what needs no condition. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  if (bootError) throw bootError;
}

const $ = <E extends Element = HTMLElement>(selector: string) => document.querySelector<E>(selector);
const text = () => document.body.textContent ?? '';

/** The document goes: telemetry flushed as on pagehide, the app root unmounted, the shell's screens hidden. */
async function unload(): Promise<void> {
  await unloadTelemetry();
  const roots = appRoots.splice(0).filter((r) => r.container.id === 'root');
  const { hideScreen } = await screen();
  await act(async () => {
    for (const { root } of roots) root.unmount();
    hideScreen();
  });
  $('#root')?.remove();
}

/** A page load in the tab: the SDK starts from nothing, and the shell's index.html and bootstrap run. */
async function load(path?: string): Promise<void> {
  await unload();
  resetRuntimeForTests();
  resetContainersForTests();
  if (path) page.url = new URL(path, ORIGIN);
  page.install();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  const { bootstrap } = await shell();
  // An anonymous page never settles bootstrap (it waits on the user, then on the redirect).
  await act(async () => void bootstrap().catch((e: unknown) => (bootError = e)));
  await flush();
}

/** The user signs in at Keycloak; the browser follows the redirect back to the callback. */
async function approveLogin(): Promise<void> {
  const authorize = page.assigned.at(-1)!;
  page.assigned.length = 0;
  page.url = new URL(kc.approve(authorize));
  await load();
}

const bearerOf = (r: Request) => r.headers.get('authorization');

beforeEach(async () => {
  useFakeClock();
  kc = new FakeKeycloak();
  net = new FakeNetwork(kc);
  collector = new Collector().install();
  page = new FakePage('/');
  injected = [];
  const { default: EditTender } = await editTender();
  exposeModule = async (module) => {
    if (module !== './EditTender') throw new Error(`Module "${module}" does not exist in container.`);
    return () => ({ default: EditTender });
  };
  setMfeInternalsForTests({
    injectScript: async (url) => {
      injected.push(url);
      (globalThis as Record<string, unknown>).__platform_mfe_tenders = { init: () => {}, get: (m: string) => exposeModule(m) };
    },
  });
  net
    .on('GET /config/runtime.json', RUNTIME_CONFIG)
    .on('GET /version.json', { version: '1.0.0' })
    .on('GET /remotes/manifest.json', { tenders: { entry: ENTRY, version: '1.0.0', ownerDomain: 'tender_management' } })
    .on('GET /api/v1/public/tenants/resolve', (req) =>
      Response.json(new URL(req.url).searchParams.get('identifier') === 'acme' ? { found: true, realm: 'tenant-acme', strategy: 'dedicated' } : { found: false }),
    )
    .on('GET /api/v1/me/session-context', { tenant_id: TENANT, slug: 'acme', roles: ['preparator'], feature_flags: [], read_only: false })
    .on('GET /api/tenders/:id', (req) => Response.json(TENDER, { headers: { 'x-request-id': req.headers.get('x-request-id')! } }));
  vi.stubGlobal('fetch', net.fetch);
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.stubGlobal('__ENVIRONMENT__', testenv.environment);
  vi.stubGlobal('__BUILD_VERSION__', '1.0.0');
});

afterEach(async () => {
  await unload();
  bootError = undefined;
  delete (globalThis as Record<string, unknown>).__platform_mfe_tenders;
  await endWorld();
});

describe('the reference shell', () => {
  it('anonymous → identifier screen → Keycloak (PKCE) → callback → the signed-in shell', async () => {
    await load('/');
    expect($('#signin-title')?.textContent).toBe('Sign in');
    expect(getSession()).toEqual({ status: 'anonymous', reason: 'none' });

    // The user names the workspace; PUB-1 resolves it, without a token, and login redirects.
    $<HTMLInputElement>('input[name=identifier]')!.value = 'acme';
    await user(() => $<HTMLButtonElement>('button[type=submit]')!.click());
    await until(() => page.assigned.length > 0);
    const [resolve] = net.sent('/api/v1/public/tenants/resolve');
    expect(bearerOf(resolve!)).toBeNull();
    const authorize = new URL(page.assigned[0]!);
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${IDP}/realms/tenant-acme/protocol/openid-connect/auth`);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);

    await approveLogin();
    await until(() => $('h1')?.textContent === 'acme');

    expect(getSession()).toMatchObject({ status: 'authenticated', user: { name: 'Ada', email: 'ada@example.com' }, workspace: { realm: 'tenant-acme' } });
    expect(kc.requests.map((r) => r.grant)).toEqual(['authorization_code']);
    expect(kc.requests[0]!.body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The session context came with the token; the URL moved to the workspace's /t/<slug>/.
    expect(bearerOf(net.sent('/api/v1/me/session-context')[0]!)).toMatch(/^Bearer at-/);
    expect(page.url.pathname).toBe('/t/acme/');
    expect($<HTMLAnchorElement>('main a')!.getAttribute('href')).toBe('/t/acme/tenders/1/edit');
    expect($('#signin-title')).toBeNull();
    expect(document.documentElement.lang).toBe('en');
    expect(page.storedValues()).not.toMatch(/at-|eyJ|refresh/);
  });

  it('a deep link signs in to its workspace and mounts the tenders remote, which loads and saves through the API', async () => {
    await load('/t/acme/tenders/1/edit');
    await until(() => page.assigned.length > 0); // the slug picked the workspace: no identifier screen
    await approveLogin();
    await until(() => $<HTMLInputElement>('input[name=title]') !== null);

    expect(page.url.pathname).toBe('/t/acme/tenders/1/edit');
    expect(injected).toEqual([ENTRY]);
    expect($<HTMLInputElement>('input[name=title]')!.defaultValue).toBe('Road works');
    expect($<HTMLInputElement>('input[name=title]')!.disabled).toBe(false); // preparator may update:tender
    expect($('button[type=submit]')).not.toBeNull();
    const [get] = net.sent('/api/tenders/1');
    expect(bearerOf(get!)).toMatch(/^Bearer at-/);
    expect(get!.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(get!.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

    // A save the API rejects shows the field errors next to the inputs.
    net.on('PUT /api/tenders/:id', () =>
      mockProblem(PlatformProblemTypes.ValidationFailed, { validationErrors: [{ field: 'title', message: 'Title is required', code: 'required' }] }),
    );
    $<HTMLInputElement>('input[name=title]')!.value = '';
    await user(() => $<HTMLButtonElement>('button[type=submit]')!.click());
    await until(() => text().includes('Title is required'));
    const [put] = net.sent('/api/tenders/1').filter((r) => r.method === 'PUT');
    expect(await put!.json()).toEqual({ title: '', deadline: '2026-12-01' });
    expect($('input[name=title]')!.getAttribute('aria-invalid')).toBe('true');
  });

  it('a session context that fails at boot is retried: the page starts deny-all, then the subject gets its roles (review 2)', async () => {
    let down = true;
    net.on('GET /api/v1/me/session-context', () =>
      down ? mockProblem(PlatformProblemTypes.ServiceUnavailable) : Response.json({ tenant_id: TENANT, slug: 'acme', roles: ['preparator'], feature_flags: [], read_only: false }));
    await load('/t/acme/tenders/1/edit');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $<HTMLInputElement>('input[name=title]') !== null);
    expect($<HTMLInputElement>('input[name=title]')!.disabled).toBe(true); // deny-all without the context

    down = false;
    await until(() => $<HTMLInputElement>('input[name=title]')?.disabled === false);
    expect(page.url.pathname).toBe('/t/acme/tenders/1/edit');
  });

  it('the session context retries are bounded: 3 more tries, then the page stays deny-all', async () => {
    net.on('GET /api/v1/me/session-context', () => mockProblem(PlatformProblemTypes.ServiceUnavailable));
    await load('/t/acme/tenders/1/edit');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $<HTMLInputElement>('input[name=title]') !== null);
    const first = net.sent('/api/v1/me/session-context').length; // one ApiClient call, with its own quick retries
    // 3 shell retries (after 1 s, 2 s, 4 s), each one ApiClient call; then no more.
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    await flush();
    expect(net.sent('/api/v1/me/session-context')).toHaveLength(first * 4);
    expect($<HTMLInputElement>('input[name=title]')!.disabled).toBe(true);
  });

  it('a remote that fails to load shows its RemoteBoundary fallback; the shell keeps running and Try again recovers', async () => {
    exposeModule = async () => {
      throw new Error('the remote deploy is broken: ./EditTender answered 500');
    };
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the caught error
    await load('/t/acme/tenders/1/edit');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $('[role=alert]') !== null);

    expect($('[role=alert]')!.textContent).toContain('Something went wrong.');
    expect(net.sent('/api/tenders/1')).toEqual([]);
    expect(getSession().status).toBe('authenticated'); // the shell, its session and its screens are untouched
    expect(page.assigned).toEqual([]);
    await unloadTelemetry();
    // Errors leave without telemetry consent (the shell's CMP grants essential only).
    expect(collector.logs.filter((l) => l.attributes.mfe === 'tenders').map((l) => l.body)).toEqual(['remote failed to load', 'remote failed to render']);

    // The remote's team fixes the deploy; the user retries in place, without a reload.
    const { default: EditTender } = await editTender();
    exposeModule = async () => () => ({ default: EditTender });
    await user(() => $<HTMLButtonElement>('[role=alert] button')!.click());
    await until(() => $<HTMLInputElement>('input[name=title]') !== null);
    expect($<HTMLInputElement>('input[name=title]')!.defaultValue).toBe('Road works');
    expect(injected).toEqual([ENTRY]); // the container was loaded once; only the module was asked again
  });

  it('an API failure inside the remote shows its own boundary with the request reference', async () => {
    net.on('GET /api/tenders/:id', (req) => mockProblem(PlatformProblemTypes.InternalError, { instance: new URL(req.url).pathname }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await load('/t/acme/tenders/1/edit');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $('[role=alert]') !== null);

    const requestId = net.sent('/api/tenders/1').at(-1)!.headers.get('x-request-id')!;
    expect($('[role=alert] code')?.textContent).toBe(requestId);
    expect(getSession().status).toBe('authenticated');
  });

  it('Sign out clears the app storage, tells the other tabs and ends the SSO session (global by default); back on the app it stays signed out until the user signs in', async () => {
    await load('/t/acme/');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $('h1')?.textContent === 'acme');
    storage('tenders').set('filter', 'open');
    expect(page.local.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:filter')).not.toBeNull();
    const otherTab: unknown[] = [];
    new FakeBroadcastChannel('platform-auth').addEventListener('message', (e) => otherTab.push((e as MessageEvent).data));

    // The shell's Sign out control (useSignOut → IdentityProvider.logout, global by default: report Issues 6, 10).
    await user(() => [...document.querySelectorAll<HTMLButtonElement>('header button')].find((b) => b.textContent === 'Sign out')!.click());
    await flush();
    await until(() => text().includes('You are signed out'));

    expect(getSession()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
    expect(document.getElementById('root')!.childElementCount).toBe(0); // the app is unmounted, not hidden
    expect(page.local.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:filter')).toBeNull();
    expect(otherTab).toEqual([{ type: 'logout' }]);
    expect(JSON.stringify(FakeBroadcastChannel.sent)).not.toMatch(/at-|eyJ|refresh/);
    expect(page.storedValues()).not.toMatch(/at-|eyJ|refresh/);

    // The page goes to Keycloak's end-session endpoint, which ends the SSO session (Issue 10: the next
    // person on this device is not shown the previous user) and returns to the app's root.
    expect(page.assigned).toHaveLength(1);
    const endSession = page.posted[0]!; // a form POST: the ID token stays out of URLs
    expect(new URL(endSession.url).pathname).toBe('/realms/tenant-acme/protocol/openid-connect/logout');
    expect(endSession.fields.post_logout_redirect_uri).toBe(`${ORIGIN}/`);
    expect(endSession.fields.client_id).toBe('tender-web');
    page.assigned.length = 0;
    await load(endSession.fields.post_logout_redirect_uri!);
    await until(() => text().includes('You are signed out'));
    expect(getSession()).toEqual({ status: 'anonymous', reason: 'signed-out' });
    expect(page.assigned).toEqual([]); // no silent sign-in
    expect($('h1#signed-out-title')).not.toBeNull();

    // Sign in again from there: credentials are asked for (a shared device), the cached workspace is used.
    await user(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Sign in')!.click());
    await until(() => page.assigned.length > 0);
    const again = new URL(page.assigned[0]!);
    expect(again.pathname).toBe('/realms/tenant-acme/protocol/openid-connect/auth');
    expect(again.searchParams.get('prompt')).toBe('login');
  });

  it("another tab's sign-out takes this tab to the signed-out screen; the app is no longer shown (Issue 7)", async () => {
    await load('/t/acme/');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $('h1')?.textContent === 'acme');
    // The other tab signs out: it sets the signed-out mark in the shared localStorage and broadcasts.
    page.local.setItem(SIGNED_OUT_KEY, String(Date.now()));
    await user(() => new FakeBroadcastChannel('platform-auth').postMessage({ type: 'logout' }));
    await until(() => text().includes('You are signed out'));
    expect(getSession()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
    expect($('h1#signed-out-title')).not.toBeNull();
    // The previous user's app is gone, not left under the dialog (a shared device).
    expect(document.getElementById('root')!.childElementCount).toBe(0);
    expect([...document.querySelectorAll('h1')].map((h) => h.textContent)).toEqual(['You are signed out']);
    // Signing in from here asks for credentials (shared device).
    await user(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Sign in')!.click());
    await until(() => page.assigned.length > 0);
    expect(new URL(page.assigned.at(-1)!).searchParams.get('prompt')).toBe('login');
  });

  it('a device clock 20 minutes off: the shell says to check the clock instead of returning to sign-in (Issue 8)', async () => {
    (kc as unknown as { now: () => number }).now = () => Date.now() - 20 * 60_000; // the provider's clock
    await load('/t/acme/');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => text().includes("Check your device's clock"));
    expect(getSession()).toEqual({ status: 'anonymous', reason: 'device-clock' });
    expect(page.assigned).toEqual([]); // no automatic retry
  });
});
