// What operations can see without telemetry consent (docs/observability/tier1-ratification.md §5): with
// only 'essential' granted, as the example shell's CMP starts, these failures must still leave the page
// as essential warnings, through the real exporter path into the in-memory collector:
// - a chunk-load reload (gap 1);
// - an API call that got no HTTP answer: timeout or network failure while online, rate-limited (gap 2);
// - the session and sign-in warnings the runbooks rely on (gap 4).
// Routine events (offline, caller aborts, a refresh token past its lifetime) stay consent-gated.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseWorkspace } from '../../packages/frontend-sdk/src/auth/workspace.ts';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { resetNoResponseLogForTests } from '../../packages/frontend-sdk/src/http/client.ts';
import { reloadOnceForChunkError } from '../../packages/frontend-sdk/src/mfe/updates.ts';
import { World, consentManager, endWorld, useFakeClock } from '../fixtures/boot.ts';
import { unloadTelemetry } from '../fixtures/telemetry.ts';

/** A page whose visitor granted only 'essential', loaded (and signed in when asked). */
async function essentialOnly(o: { signIn?: boolean; path?: string } = {}): Promise<World> {
  const w = new World(o.path ?? '/');
  w.consent = consentManager();
  if (o.signIn) await w.signIn();
  else await w.load();
  return w;
}

/** What reached the collector once the page unloads (logs are batched until then). */
async function leftThePage(w: World) {
  await unloadTelemetry();
  return w.collector.logs.map((l) => ({ level: l.level, body: l.body, attributes: l.attributes }));
}

/** A route that answers only when the request is aborted (the client deadline). */
const hang = (req: Request) =>
  new Promise<Response>((_res, rej) => req.signal.addEventListener('abort', () => rej(req.signal.reason as Error)));

beforeEach(() => {
  useFakeClock();
  resetNoResponseLogForTests();
});
afterEach(endWorld);

describe('API calls that got no HTTP answer', () => {
  it('a timeout and a network failure leave as essential warnings with route, reason and request id; nothing else is sent', async () => {
    const w = await essentialOnly();
    w.net.on('GET /api/tenders/:id', hang).on('GET /api/bids', () => Promise.reject(new TypeError('Failed to fetch')));
    const api = createApiClient({ mfe: 'tenders' });
    const timedOut = await api.get('/tenders/:id', { params: { id: '1' }, timeoutMs: 20, retry: false }).catch((e: { requestId: string }) => e);
    const failed = await api.get('/bids', { retry: false }).catch((e: { requestId: string }) => e);

    const logs = await leftThePage(w);
    expect(logs).toEqual([
      { level: 'warn', body: 'api call got no response', attributes: expect.objectContaining({ method: 'GET', route: '/tenders/:id', reason: 'timeout', mfe: 'tenders' }) },
      { level: 'warn', body: 'api call got no response', attributes: expect.objectContaining({ method: 'GET', route: '/bids', reason: 'network', mfe: 'tenders' }) },
    ]);
    expect(logs[0]!.attributes.request_id).toBe(timedOut.requestId);
    expect(logs[1]!.attributes.request_id).toBe(failed.requestId);
    expect(JSON.stringify(logs)).not.toMatch(/\/api\/tenders\/1|essential/); // a template, never the URL; the flag is never sent
  });

  it('offline, a caller abort and an HTTP error answer are not logged', async () => {
    const w = await essentialOnly();
    w.net.on('GET /api/slow', hang);
    w.net.on('GET /api/down', () => new Response(JSON.stringify({ type: 'about:blank', title: 'Unavailable', status: 503 }), { status: 503, headers: { 'content-type': 'application/problem+json' } }));
    const api = createApiClient();
    const ctrl = new AbortController();
    const aborted = api.get('/slow', { signal: ctrl.signal, retry: false }).catch(() => undefined);
    ctrl.abort();
    await aborted;
    await api.get('/down', { retry: false }).catch(() => undefined); // the server's own answer: it logs it
    w.page.online = false;
    await api.get('/ok', { retry: false }).catch(() => undefined); // the user's own connection
    expect(await leftThePage(w)).toEqual([]);
  });

  it('at most 10 a minute per page; the next one after the window carries the count it suppressed', async () => {
    const w = await essentialOnly();
    w.net.on('GET /api/flaky', () => Promise.reject(new TypeError('Failed to fetch')));
    const api = createApiClient();
    for (let i = 0; i < 13; i++) await api.get('/flaky', { retry: false }).catch(() => undefined);
    vi.setSystemTime(Date.now() + 60_000);
    await api.get('/flaky', { retry: false }).catch(() => undefined);

    const logs = await leftThePage(w);
    expect(logs).toHaveLength(11);
    expect(logs.slice(0, 10).every((l) => l.attributes.suppressed === undefined)).toBe(true);
    expect(logs[10]!.attributes.suppressed).toBe(3);
  });
});

describe('chunk-load reloads', () => {
  it('the reload is logged as an essential warning first; a second failure of the same build reloads and logs nothing', async () => {
    const w = await essentialOnly();
    expect(reloadOnceForChunkError(new Error('Loading chunk 42 failed.'))).toBe(true);
    expect(reloadOnceForChunkError(new Error('Loading chunk 42 failed.'))).toBe(false); // the guard: the caller logs it as an error
    const logs = await leftThePage(w);
    expect(logs).toEqual([
      { level: 'warn', body: 'chunk load failed: reloading', attributes: expect.objectContaining({ 'exception.message': 'Loading chunk 42 failed.' }) },
    ]);
  });
});

describe('session and sign-in warnings', () => {
  it('sign-in failed and an unknown callback state are essential', async () => {
    const w = new World('/');
    w.consent = consentManager();
    await w.load();
    await w.idp.login({ workspace: { realm: 'tenant-acme', trial: false, slug: 'acme' }, returnUrl: '/t/acme/' });
    const callback = new URL(w.kc.approve(w.page.assigned.at(-1)!));
    const denied = new URL(callback);
    denied.searchParams.delete('code');
    denied.searchParams.set('error', 'access_denied');
    w.page.url = denied;
    await w.load();
    w.page.url = new URL(`${callback.origin}${callback.pathname}?code=x&state=nope`);
    await w.load();
    const bodies = (await leftThePage(w)).map((l) => `${l.level} ${l.body}`);
    expect(bodies).toContain('warn sign-in failed');
    expect(bodies).toContain('warn sign-in callback ignored: unknown or expired state');
  });

  it('a refresh with an unknown outcome and a failed refresh are essential', async () => {
    const w = await essentialOnly({ signIn: true });
    w.kc.failures.push('network-after-send');
    await w.idp.refresh();
    const bodies = (await leftThePage(w)).map((l) => `${l.level} ${l.body}`);
    expect(bodies).toContain('warn token refresh outcome unknown: restoring the session');
    await endWorld();
    useFakeClock();

    const failed = await essentialOnly({ signIn: true });
    failed.kc.failures.push('server-error');
    await failed.idp.refresh();
    expect((await leftThePage(failed)).map((l) => `${l.level} ${l.body}`)).toContain('warn token refresh failed: restoring the session');
  });

  it('Keycloak ending a live session is essential; a routine end is not sent without consent', async () => {
    const live = await essentialOnly({ signIn: true });
    live.kc.failures.push('invalid_grant');
    await live.idp.refresh();
    expect(await leftThePage(live)).toEqual([{ level: 'warn', body: 'session ended', attributes: expect.objectContaining({ server_ended: true }) }]);
    await endWorld();
    useFakeClock();

    const routine = new World('/');
    routine.consent = consentManager();
    routine.kc.refreshTtl = 0; // no refresh_expires_in: the SDK cannot tell a live session from an expired one
    await routine.signIn();
    routine.kc.failures.push('invalid_grant');
    await routine.idp.refresh();
    expect(routine.idp.getState()).toMatchObject({ status: 'expired', serverEnded: false });
    expect(await leftThePage(routine)).toEqual([]); // info: telemetry consent only
  });

  it('a workspace resolve failure (PUB-1 unreachable) is essential', async () => {
    const w = await essentialOnly();
    const resolver = { resolve: () => Promise.reject(new TypeError('Failed to fetch')) };
    expect(await chooseWorkspace({ pathname: '/t/acme/', resolver, cfg: w.cfg.auth })).toBeUndefined();
    expect(await leftThePage(w)).toEqual([
      { level: 'warn', body: 'workspace resolve failed', attributes: expect.objectContaining({ slug: 'acme', cached: false }) },
    ]);
  });
});
