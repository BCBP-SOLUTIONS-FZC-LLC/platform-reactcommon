// /auth, /http and /storage wired together over a fake Keycloak: a 401 refreshes the token once for
// every call waiting on it, and a logout clears the tab's app storage and tells the other tabs,
// whose provider shares the same localStorage.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOidcProvider, getSession, type IdentityProvider } from '../../packages/frontend-sdk/src/auth/index.ts';
import { CHANNEL_NAME } from '../../packages/frontend-sdk/src/auth/oidc.ts';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { PlatformProblemTypes, isProblemError } from '../../packages/frontend-sdk/src/problem/index.ts';
import { storage } from '../../packages/frontend-sdk/src/storage/index.ts';
import { mockProblem } from '../../packages/frontend-sdk/src/testing/index.ts';
import { ACME, World, endWorld, useFakeClock } from '../fixtures/boot.ts';
import { FakeBroadcastChannel, FakePage, ORIGIN } from '../fixtures/keycloak.ts';

const bearer = (r: Request) => r.headers.get('authorization')?.replace(/^Bearer /, '');
const refreshes = (w: World) => w.kc.requests.filter((r) => r.grant === 'refresh_token');

let w: World;

beforeEach(() => {
  useFakeClock();
  w = new World('/t/acme/');
});

afterEach(endWorld);

describe('401 → refresh → retry', () => {
  it('refreshes once for two concurrent calls and retries each with the new token', async () => {
    await w.signIn();
    const stale = await w.idp.getAccessToken();
    // The gateway stopped accepting this access token before its exp (e.g. a signing key rotation).
    const gateway = (req: Request) =>
      bearer(req) === stale ? mockProblem(PlatformProblemTypes.Unauthorized) : Response.json({ path: new URL(req.url).pathname });
    w.net.on('GET /api/tenders', gateway).on('GET /api/bids', gateway);

    const api = createApiClient();
    const [tenders, bids] = await Promise.all([api.get('/tenders'), api.get('/bids')]);

    expect([tenders.data, bids.data]).toEqual([{ path: '/api/tenders' }, { path: '/api/bids' }]);
    expect(refreshes(w)).toHaveLength(1);
    const fresh = await w.idp.getAccessToken();
    expect(fresh).not.toBe(stale);
    for (const path of ['/api/tenders', '/api/bids']) expect(w.net.sent(path).map(bearer), path).toEqual([stale, fresh]);
    expect(w.kc.reuseDetected).toBe(0);
    expect(getSession().status).toBe('authenticated');
  });

  it('a 401 the refresh cannot fix (the session ended at Keycloak) is a ProblemError, and the session is expired', async () => {
    await w.signIn();
    w.net.on('GET /api/tenders', mockProblem(PlatformProblemTypes.Unauthorized));
    w.kc.sessionRevoked = true;
    const err = await createApiClient().get('/tenders').catch((e: unknown) => e);
    expect(isProblemError(err) && err.status).toBe(401);
    expect(w.net.sent('/api/tenders')).toHaveLength(1); // no retry without a new token
    expect(refreshes(w)).toHaveLength(1);
    expect(getSession()).toMatchObject({ status: 'expired', serverEnded: true });
  });
});

describe('logout', () => {
  it('clears app storage, drops the token, tells the other tab, and survives a reload', async () => {
    await w.signIn();
    // Tab B: the same browser (shared localStorage), signed in through its own lineage.
    const b = new FakePage('/t/acme/', w.page.local);
    b.install();
    await createOidcProvider(w.cfg.auth, w.resolver).login({ workspace: ACME, returnUrl: '/t/acme/' });
    b.url = new URL(w.kc.approve(b.assigned.at(-1)!));
    const tabB: IdentityProvider = createOidcProvider(w.cfg.auth, w.resolver);
    expect((await tabB.init()).status).toBe('authenticated');
    const heard: unknown[] = [];
    new FakeBroadcastChannel(CHANNEL_NAME).addEventListener('message', (e) => heard.push((e as MessageEvent).data));
    w.page.install();

    storage('tenders').set('filter', 'open');
    storage('tenders', { area: 'session' }).set('draft', '{"title":"Bridge"}');
    expect(w.page.local.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:filter')).not.toBeNull();
    expect(w.page.session.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:draft')).not.toBeNull();
    w.net.on('GET /api/me', (req) => Response.json({ authorized: req.headers.has('authorization') }));
    expect((await createApiClient().get('/me')).data).toEqual({ authorized: true });

    await w.idp.logout();

    expect(getSession()).toEqual({ status: 'anonymous', workspace: ACME, reason: 'signed-out' });
    expect(w.page.local.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:filter')).toBeNull();
    expect(w.page.session.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-acme:tenders:draft')).toBeNull();
    expect(storage('tenders').get('filter')).toBeUndefined();
    expect(FakeBroadcastChannel.sent).toEqual([{ type: 'logout' }]);
    await Promise.resolve(); // the channel delivers asynchronously
    expect(heard).toEqual([{ type: 'logout' }]);
    expect(tabB.getState()).toEqual({ status: 'anonymous', workspace: ACME, reason: 'signed-out' });
    expect(await tabB.getAccessToken()).toBeUndefined();
    expect(JSON.stringify(FakeBroadcastChannel.sent)).not.toMatch(/at-|eyJ|refresh/);
    expect(w.page.storedValues()).not.toMatch(/at-|eyJ|refresh/);

    // Calls after the logout go out without a token; a reload does not sign in again silently.
    expect((await createApiClient().get('/me', { dedupe: false })).data).toEqual({ authorized: false });
    w.page.url = new URL('/t/acme/', ORIGIN);
    expect(await w.load()).toEqual({ status: 'anonymous', reason: 'signed-out' });
    expect(w.page.assigned.filter((u) => u.includes('prompt=none'))).toEqual([]);
  });
});
