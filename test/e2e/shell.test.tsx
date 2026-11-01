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
import { getSession, type IdentityProvider } from '../../packages/frontend-sdk/src/auth/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../packages/frontend-sdk/src/internal/runtime.ts';
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
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(25);
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
      (globalThis as Record<string, unknown>).tenders = { init: () => {}, get: (m: string) => exposeModule(m) };
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
  delete (globalThis as Record<string, unknown>).tenders;
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

  it('logout clears the app storage and tells the other tabs; the reload stays signed out until the user signs in', async () => {
    await load('/t/acme/');
    await until(() => page.assigned.length > 0);
    await approveLogin();
    await until(() => $('h1')?.textContent === 'acme');
    storage('tenders').set('filter', 'open');
    expect(page.local.getItem('tenant-acme:tenders:filter')).not.toBeNull();
    const otherTab: unknown[] = [];
    new FakeBroadcastChannel('platform-auth').addEventListener('message', (e) => otherTab.push((e as MessageEvent).data));

    // The example shell has no sign-out control: the test calls the provider bootstrap installed.
    await user(() => void (getRuntime().identityProvider as IdentityProvider).logout());
    await flush();

    expect(getSession()).toMatchObject({ status: 'anonymous', reason: 'signed-out' });
    expect(page.local.getItem('tenant-acme:tenders:filter')).toBeNull();
    expect(otherTab).toEqual([{ type: 'logout' }]);
    expect(JSON.stringify(FakeBroadcastChannel.sent)).not.toMatch(/at-|eyJ|refresh/);
    expect(page.storedValues()).not.toMatch(/at-|eyJ|refresh/);

    // A reload with Keycloak's SSO session still alive: no silent sign-in, the signed-out screen.
    await load();
    await until(() => text().includes('You are signed out'));
    expect(getSession()).toEqual({ status: 'anonymous', reason: 'signed-out' });
    expect(page.assigned).toEqual([]);
    expect($('h1#signed-out-title')).not.toBeNull();

    // Sign in again from there: credentials are asked for (a shared device), the cached workspace is used.
    await user(() => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Sign in')!.click());
    await until(() => page.assigned.length > 0);
    const again = new URL(page.assigned[0]!);
    expect(again.pathname).toBe('/realms/tenant-acme/protocol/openid-connect/auth');
    expect(again.searchParams.get('prompt')).toBe('login');
  });
});
