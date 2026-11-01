// The real example shell against the integrated stack (docker-compose.yml): Keycloak, Envoy with the
// real iam-authz-enrichment and iam-org-membership, go-probe (real gincommon), floci CloudFront/S3/Lambda
// behind the edge shim, the OTel Collector. Findings are numbered in docs/e2e/integrated-deployment-report.md;
// a test kept failing on purpose says `test.fail(…, 'Issue N: …')` (or `E-N` for an emulator limitation).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  cspViolations, decodeJwt, docker, STATE, deployed, edgeLog, envoyAccess, eventually, keycloakLogin, kcAdmin, logRecords,
  navigateOnce, signInFromScratch, SIGNED_OUT_KEY, spans, traceIdOf, Traffic, watchCsp,
} from './helpers.ts';
import { STACK } from './stack-constants.ts';

const { alice, bob, carol, dave } = STACK.users;
const AUTH_HOST = new URL(STACK.authOrigin).host;

test.describe('sign-in through PUB-1, Keycloak and the gateway', () => {
  test('anonymous → PUB-1 → Keycloak login form (PKCE S256) → callback → workspace; P-35 enriched by the gateway', async ({ page }) => {
    await watchCsp(page);
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');

    // PUB-1 through CloudFront → Envoy (no jwt_authn/ext_authz) → the real iam-org-membership.
    const resolve = t.apiCall('/api/v1/public/tenants/resolve');
    expect(resolve?.status).toBe(200);
    expect(resolve!.json()).toEqual({ found: true, realm: 'tenant-acme', strategy: 'dedicated' });
    expect(resolve!.request.headers()['authorization']).toBeUndefined();

    // Authorization Code + PKCE against the issuer the browser sees.
    const auth = t.authorize[0]!;
    expect(auth.pathname).toBe('/realms/tenant-acme/protocol/openid-connect/auth');
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('redirect_uri')).toBe(`${STACK.appOrigin}/auth/callback`);
    const exchange = t.tokenCalls.find((c) => c.grant === 'authorization_code');
    expect(exchange?.status).toBe(200);
    const id = decodeJwt(exchange!.body.id_token!);
    expect(id.iss).toBe(STACK.issuer('tenant-acme'));
    expect(id.sub).toBe(alice.id);
    const access = decodeJwt(exchange!.body.access_token);
    expect(access.iss).toBe(STACK.issuer('tenant-acme'));

    // P-35 with the JWT: jwt_authn → ext_authz (AuthZ Enrichment → I-8) → iam-org-membership.
    // The SDK retries a 503 (Issue 12: a cold I-8 lookup can exceed AuthZ Enrichment's 40 ms budget).
    const ctx = await eventually(() => t.api.find((a) => a.url.pathname === '/api/v1/me/session-context' && a.status !== 503), 20_000, 'P-35');
    expect(ctx.status).toBe(200);
    expect(ctx.request.headers()['authorization']).toMatch(/^Bearer /);
    const body = ctx.json() as { tenant_id: string; slug: string; roles: string[]; departments: { id: string; level: string }[]; plan: string };
    expect(body.tenant_id).toBe(STACK.tenants.acme.id);
    expect(body.slug).toBe('acme');
    expect(body.roles).toEqual(expect.arrayContaining(['member', 'tenant_admin']));
    expect(body.departments).toEqual([expect.objectContaining({ id: STACK.departmentId })]);
    expect(page.url()).toBe(`${STACK.appOrigin}/t/acme/`);

    // The gateway's view of the same request: the enriched identity went upstream. The SDK's retry after
    // a 503 reuses the x-request-id, so take the line of the attempt that succeeded.
    const reqId = ctx.request.headers()['x-request-id'];
    const line = await eventually(() => envoyAccess().find((l) => l.path === '/api/v1/me/session-context' && l.request_id === reqId && l.status === 200), 15_000, 'envoy access line with the browser request id');
    expect(line.upstream_x_tenant_id).toBe(STACK.tenants.acme.id);
    expect(line.upstream_x_user_id).toBe(alice.id);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('client-sent identity headers never reach an upstream (HLD §11.1 strip-list), on authenticated and bypass routes', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const token = t.latestTokens().access_token;
    const forged = {
      'x-tenant-id': STACK.tenants.globex.id, 'x-user-id': carol.id, 'x-tenant-roles': 'tenant_owner', 'x-departments': 'x:approver',
      'x-plan': 'enterprise', 'x-feature-flags': 'everything', 'x-residency-mode': 'strict',
    };
    // Authenticated route (go-probe /whoami: what gincommon's RequireAuth parsed).
    const who = await page.request.get('/api/v1/probe/whoami', { headers: { authorization: `Bearer ${token}`, ...forged } });
    expect(who.status()).toBe(200);
    const w = (await who.json()) as { tenant_id: string; user_id: string; roles: string[] };
    expect(w).toMatchObject({ tenant_id: STACK.tenants.acme.id, user_id: alice.id });
    expect(w.roles).not.toContain('tenant_owner');
    // What arrived on an authenticated route: the seven enriched headers, and no Authorization (forward: false).
    const echo = (await (await page.request.get('/api/v1/probe/echo', { headers: { authorization: `Bearer ${token}`, ...forged } })).json()) as { identity_headers: string[]; authorization: boolean };
    expect(echo.identity_headers.sort()).toEqual(Object.keys(forged).sort());
    expect(echo.authorization).toBe(false);
    // A route without jwt_authn/ext_authz: nothing of the forged set survives.
    const pub = (await (await page.request.get('/api/v1/public/echo', { headers: forged })).json()) as { identity_headers: string[] };
    expect(pub.identity_headers).toEqual([]);
  });
});

/**
 * The suggested fix for Issue 1, for this test only (the deployed policy is untouched): the edge shim adds
 * Trusted Types 'allow-duplicates' to the CSP when this cookie is present (a test hook; see edge/server.mjs).
 * A cookie, not page.route: the documents after a Keycloak redirect are not routable.
 */
async function withTrustedTypesAllowDuplicates(page: Page): Promise<void> {
  await page.context().addCookies([{ name: 'e2e-csp-fix', value: 'tt-allow-duplicates', domain: STACK.appHost, path: '/', secure: true, sameSite: 'Lax' }]);
}

interface Loaded { url: string; status: number; type: string; cache: string }
function watchStatic(page: Page): Loaded[] {
  const out: Loaded[] = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.host === new URL(STACK.appOrigin).host && /^\/(assets|remotes)\//.test(u.pathname)) {
      out.push({ url: u.pathname, status: r.status(), type: r.headers()['content-type'] ?? '', cache: r.headers()['cache-control'] ?? '' });
    }
  });
  return out;
}

test.describe('the tenders remote, deep links and the API through Envoy → go-probe', () => {
  test('deep link reload: index.html via spa-rewrite, scripts from /assets, remote via the manifest with SRI', async ({ page }) => {
    await watchCsp(page);
    const t = new Traffic(page);
    const loaded = watchStatic(page);
    await signInFromScratch(page, alice, 'acme');
    // A full page load of a deep link: no tokens in memory → silent prompt=none restore → back to the same URL.
    const deep = '/t/acme/tenders/1/edit';
    // WebKit may report the goto as interrupted by the SDK's own prompt=none round trip: read the document
    // response from the network instead of goto's return value.
    const docResponse = page.waitForResponse((r) => new URL(r.url()).pathname === deep && r.request().resourceType() === 'document');
    await page.goto(deep, { waitUntil: 'commit' }).catch((e: Error) => {
      if (!/interrupted by another navigation|NS_BINDING_ABORTED/.test(e.message)) throw e;
    });
    const doc = await docResponse;
    expect(doc.status()).toBe(200);
    expect(doc.headers()['content-type']).toContain('text/html');
    expect(doc.headers()['cache-control']).toBe('no-cache');
    await expect(page.getByRole('alert')).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(deep);
    expect(t.authorize.some((a) => a.searchParams.get('prompt') === 'none')).toBe(true);
    // Every script the documents loaded came from /assets (absolute publicPath), as JavaScript, immutable.
    const scripts = loaded.filter((a) => a.url.startsWith('/assets/'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s, s.url).toMatchObject({ status: 200, cache: 'public, max-age=31536000, immutable' });
    for (const s of scripts) expect(s.type, s.url).toMatch(/javascript/);
    // The manifest (no-cache) and the entry with its SRI hash (immutable).
    expect(loaded.find((a) => a.url === '/remotes/manifest.json')).toMatchObject({ status: 200, cache: 'no-cache' });
    expect(loaded.find((a) => a.url.endsWith('/remoteEntry.js'))).toMatchObject({ status: 200, cache: 'public, max-age=31536000, immutable' });
    expect(await page.evaluate(() => document.querySelector<HTMLScriptElement>('script[src*="remoteEntry.js"]')?.integrity)).toMatch(/^sha384-/);

    // Under the production CSP, the remote's webpack runtime cannot create its Trusted Types policy.
    const blocked = (await cspViolations(page)).filter((v) => v.directive === 'trusted-types');
    test.fail(blocked.length > 0, 'Issue 1: the remote\'s webpack runtime re-creates the platform-webpack Trusted Types policy; the production CSP has no \'allow-duplicates\'');
    expect(await cspViolations(page)).toEqual([]);
    await expect(page.getByRole('alert')).not.toHaveText(/Something went wrong/);
  });

  test('with the Issue 1 fix: the remote renders the gateway\'s problem+json; ids and logs correlate end to end', async ({ page }) => {
    await withTrustedTypesAllowDuplicates(page);
    await watchCsp(page);
    const t = new Traffic(page);
    const loaded = watchStatic(page);
    await signInFromScratch(page, alice, 'acme');
    await page.goto('/t/acme/tenders/1/edit', { waitUntil: 'commit' });
    await expect(page.getByRole('alert')).toBeVisible();
    // Issue 2: the shell never imports @platform/frontend-sdk/problem, so its share scope does not provide it,
    // and the remote (SDK import: false) cannot evaluate. Browser logs (essential errors) still arrive.
    if (/Something went wrong/.test(await page.getByRole('alert').innerText())) {
      const evalError = await eventually(() => logRecords().find((r) => r.service === 'web-app' && /failed to evaluate/.test(r.attributes['exception.message'] ?? '')), 30_000, 'the remote evaluate error in the Collector');
      expect(evalError.severity).toBe('ERROR');
      test.fail(true, 'Issue 2: the shell\'s share scope does not provide @platform/frontend-sdk/problem (it never imports it); the remote cannot evaluate');
    }
    // GET /api/tenders/1 → Envoy (jwt_authn, ext_authz) → go-probe: a gincommon 404 problem the remote shows.
    const tender = await eventually(() => t.apiCall('/api/tenders/1'), 10_000, '/api/tenders/1');
    expect(tender.status).toBe(404);
    expect(tender.response.headers()['content-type']).toContain('application/problem+json');
    const problem = tender.json() as { errorCode: string; traceId: string };
    expect(problem.errorCode).toBe('TENDER_NOT_FOUND');
    const sentTrace = traceIdOf(tender.request.headers()['traceparent'])!;
    expect(problem.traceId).toBe(sentTrace);
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(sentTrace);
    // The SDK's x-request-id is the one Envoy and gincommon used (echoed back unchanged).
    const reqId = tender.request.headers()['x-request-id']!;
    expect(tender.response.headers()['x-request-id']).toBe(reqId);
    // The remote's chunks loaded relative to its entry (publicPath 'auto'), immutable.
    const chunks = loaded.filter((a) => a.url.startsWith(`/remotes/tenders/${STACK.remoteVersion}/`) && !a.url.endsWith('remoteEntry.js'));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c, c.url).toMatchObject({ status: 200, cache: 'public, max-age=31536000, immutable' });
    expect(await cspViolations(page)).toEqual([]);

    // Telemetry: leave the page so the SDK flushes its queues (beacons), then read the Collector output.
    await page.goto('/version.json');
    const log = await eventually(() => logRecords().find((r) => r.service === 'web-app' && r.attributes['request_id'] === reqId), 60_000, 'the boundary\'s error log with the request id');
    expect(log.severity).toBe('ERROR');
    // The backend spans of that request carry the browser's trace id: Envoy, AuthZ Enrichment (ext_authz), go-probe.
    const services = await eventually(() => {
      const s = new Set(spans().filter((x) => x.traceId === sentTrace).map((x) => x.service));
      return s.has('envoy-gateway') && s.has('iam-authz-enrichment') && s.has('go-probe') ? s : undefined;
    }, 60_000, `spans of trace ${sentTrace}`);
    expect([...services].sort()).toEqual(expect.arrayContaining(['envoy-gateway', 'go-probe', 'iam-authz-enrichment']));
    // No browser spans: the example CMP grants only 'essential' and has no consent UI (spans need 'telemetry').
    expect(spans().filter((x) => x.traceId === sentTrace && x.service === 'web-app')).toEqual([]);
  });

  test('/auth/callback is served by the SPA rewrite and loads its scripts from /assets', async ({ page }) => {
    const res = await page.goto('/auth/callback?code=x&state=nope');
    expect(res?.status()).toBe(200);
    const html = await res!.text();
    expect(html).toMatch(/<script defer src=\/assets\/main\.[0-9a-f]+\.js>/);
    // An unknown state is ignored; the shell lands on the identifier screen.
    await expect(page.getByLabel('Company workspace or invitation email')).toBeVisible();
    expect(edgeLog().some((l) => l.url?.startsWith('/auth/callback') && l.rewrittenUri === '/index.html')).toBe(true);
  });

  test('P-35 trace: the browser-sent trace id continues through Envoy, AuthZ Enrichment and iam-org-membership', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const ctx = await eventually(() => t.api.find((a) => a.url.pathname === '/api/v1/me/session-context' && a.status !== 503), 20_000, 'P-35');
    const traceId = traceIdOf(ctx.request.headers()['traceparent'])!;
    const services = await eventually(() => {
      const s = new Set(spans().filter((x) => x.traceId === traceId).map((x) => x.service));
      return s.has('envoy-gateway') && s.has('iam-authz-enrichment') && s.has('iam-org-membership') ? s : undefined;
    }, 60_000, `spans of trace ${traceId}`);
    expect(services.size).toBeGreaterThanOrEqual(3);
  });
});

test.describe('gateway responses as the SDK parses them', () => {
  test('jwt_authn, ext_authz and gincommon problem shapes through CloudFront → Envoy', async ({ page }) => {
    const { parseProblemResponse } = (await import('../../packages/frontend-sdk/dist/problem/index.js')) as unknown as {
      parseProblemResponse: (r: Response) => Promise<{ status: number }>;
    };
    const asFetch = async (r: import('@playwright/test').APIResponse) => new Response(new Uint8Array(await r.body()), { status: r.status(), headers: r.headers() });

    // 1. No token: Envoy jwt_authn's own 401.
    const missing = await page.request.get('/api/v1/me/session-context');
    expect(missing.status()).toBe(401);
    const p401 = await parseProblemResponse(await asFetch(missing));
    expect(p401.status).toBe(401);
    // Issue 3: text/plain "Jwt is missing" and a WWW-Authenticate realm naming the internal origin.
    const plain = !String(missing.headers()['content-type']).includes('problem+json');
    const leaks = /envoy:10000/.test(missing.headers()['www-authenticate'] ?? '');
    test.fail(plain || leaks, `Issue 3: jwt_authn answers ${missing.headers()['content-type']} "${(await missing.text()).trim()}" with WWW-Authenticate ${missing.headers()['www-authenticate']}`);
    expect(missing.headers()['content-type']).toContain('application/problem+json');
    expect(missing.headers()['www-authenticate'] ?? '').not.toMatch(/envoy:10000/);
  });

  test('ext_authz deny (realm account without a membership) is a problem+json the SDK maps to its deny code', async ({ page }) => {
    const { parseProblemResponse, gatewayDenyCode } = (await import('../../packages/frontend-sdk/dist/problem/index.js')) as unknown as {
      parseProblemResponse: (r: Response) => Promise<{ status: number; code?: string }>;
      gatewayDenyCode: (p: unknown) => string | undefined;
    };
    const t = new Traffic(page);
    // dave has a tenant-acme Keycloak account but no Org & Membership membership.
    await page.goto('/');
    await page.getByLabel('Company workspace or invitation email').fill('acme');
    await page.getByRole('button', { name: 'Continue' }).click();
    await keycloakLogin(page, dave);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme');
    // The SDK retries a 503 (Issue 12: a cold I-8 lookup exceeds AuthZ Enrichment's 40 ms budget); the last answer counts.
    await eventually(() => t.api.some((a) => a.url.pathname === '/api/v1/me/session-context' && a.status !== 503), 20_000, 'P-35 answer');
    const calls = t.api.filter((a) => a.url.pathname === '/api/v1/me/session-context');
    test.info().annotations.push({ type: 'observation', description: `P-35 statuses: ${calls.map((c) => c.status).join(', ')}; x-request-id reused: ${new Set(calls.map((c) => c.request.headers()['x-request-id'])).size === 1}` });
    const ctx = calls.at(-1)!;
    expect(ctx.status).toBe(403);
    expect(ctx.response.headers()['content-type']).toContain('application/problem+json');
    const p = await parseProblemResponse(new Response(ctx.text, { status: ctx.status, headers: ctx.response.headers() }));
    expect(gatewayDenyCode(p)).toBe('DENY_UNRESOLVABLE_SUBJECT');
  });

  test('go-probe (gincommon) problem through Envoy keeps traceId and x-request-id', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const token = t.latestTokens().access_token;
    const reqId = '6f1e3c2a-1b2c-4d5e-8f90-123456789abc';
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const r = await page.request.get('/api/tenders/1', { headers: { authorization: `Bearer ${token}`, 'x-request-id': reqId, traceparent } });
    expect(r.status()).toBe(404);
    expect(r.headers()['content-type']).toContain('application/problem+json');
    expect(r.headers()['x-request-id']).toBe(reqId);
    const body = (await r.json()) as { errorCode: string; traceId: string; instance: string };
    expect(body.errorCode).toBe('TENDER_NOT_FOUND');
    expect(body.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    // The problem's instance is the upstream path (Envoy's prefix_rewrite), not the path the browser called.
    test.info().annotations.push({ type: 'observation', description: `instance=${body.instance}` });
  });
});

test.describe('ext_authz budget', () => {
  test('first request of a user on a cold AuthZ cache (I-8 miss) is answered within the 250 ms ext_authz budget', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const token = t.latestTokens().access_token;
    // Cold caches: AuthZ Enrichment's ae:* and Org & Membership's I-8 projection.
    docker('exec', `${STACK.project}-valkey-1`, 'valkey-cli', 'FLUSHALL');
    const r = await page.request.get('/api/v1/probe/whoami', { headers: { authorization: `Bearer ${token}` } });
    const second = await page.request.get('/api/v1/probe/whoami', { headers: { authorization: `Bearer ${token}` } });
    test.info().annotations.push({ type: 'observation', description: `cold: ${r.status()} ${(await r.text()).slice(0, 160)}; warm: ${second.status()}` });
    expect(second.status()).toBe(200);
    test.fail(r.status() === 503, 'Issue 12: the cold I-8 call exceeds ORG_MEMBERSHIP_TIMEOUT (40 ms): DENY_SERVICE_UNAVAILABLE (503) for the first request after a cache miss');
    expect(r.status()).toBe(200);
  });
});

test.describe('token refresh against Keycloak (rotation, revokeRefreshToken=true)', () => {
  test('one tab: the lineage refreshes without reuse errors', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const first = t.latestTokens();
    expect(first.expires_in).toBe(STACK.acmeAccessTokenLifespan);
    await eventually(() => t.tokenCalls.filter((c) => c.grant === 'refresh_token').length >= 2, 90_000, 'two refreshes');
    const refreshes = t.tokenCalls.filter((c) => c.grant === 'refresh_token');
    for (const r of refreshes) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(new Set(refreshes.map((r) => r.body.refresh_token)).size).toBe(refreshes.length); // rotated every time
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme');
  });

  test('refresh cadence with a 60 s access token', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const start = Date.now();
    await page.waitForTimeout(45_000);
    const n = t.tokenCalls.filter((c) => c.grant === 'refresh_token').length;
    test.info().annotations.push({ type: 'observation', description: `${n} refreshes in ${Math.round((Date.now() - start) / 1000)} s` });
    // REFRESH_LEAD_MS (60 s) ≥ the token lifetime: every refresh is scheduled immediately (0–10 s jitter).
    test.fail(n > 2, `Issue 4: ${n} refreshes in 45 s with a ${STACK.acmeAccessTokenLifespan} s token`);
    expect(n).toBeLessThanOrEqual(2);
  });

  test('two tabs of one browser: each keeps its own refresh lineage', async ({ page, context }) => {
    const a = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    // Second tab: silent prompt=none restore → its own code exchange in the same Keycloak user session.
    const page2 = await context.newPage();
    const b = new Traffic(page2);
    await page2.goto('/t/acme/', { waitUntil: 'commit' });
    await expect(page2.getByRole('heading', { level: 1 })).toHaveText('acme');
    expect(b.tokenCalls.find((c) => c.grant === 'authorization_code')?.status).toBe(200);
    await eventually(() => a.tokenCalls.filter((c) => c.grant === 'refresh_token').length >= 2 && b.tokenCalls.filter((c) => c.grant === 'refresh_token').length >= 2, 120_000, 'two refreshes in each tab');
    const failed = [...a.tokenCalls, ...b.tokenCalls].filter((c) => c.grant === 'refresh_token' && c.status !== 200);
    test.fail(failed.length > 0, `Issue 5: refresh rejected across tabs: ${JSON.stringify(failed.map((f) => f.body))}`);
    expect(failed).toEqual([]);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page2.getByRole('alertdialog')).toHaveCount(0);
  });
});

test.describe('sign-out and the shared device', () => {
  test('the example shell offers no way to call logout()', async ({ page }) => {
    await signInFromScratch(page, alice, 'acme');
    const signOut = page.getByRole('button', { name: /sign out|log out/i }).or(page.getByRole('link', { name: /sign out|log out/i }));
    test.fail((await signOut.count()) === 0, 'Issue 6: the example shell renders no sign-out control; IdentityProvider.logout() is unreachable from its UI');
    await expect(signOut).toHaveCount(1);
  });

  test('global logout: Keycloak end-session with the SDK\'s parameters ends SSO and returns to the app', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    const idToken = t.latestTokens().id_token!;
    // Exactly what IdentityProvider.logout({ global: true }) navigates to (oidc.ts).
    const params = new URLSearchParams({ id_token_hint: idToken, client_id: 'tender-web', post_logout_redirect_uri: `${STACK.appOrigin}/` });
    await page.evaluate((k) => localStorage.setItem(k, String(Date.now())), SIGNED_OUT_KEY); // logout() sets this before navigating
    await navigateOnce(page, () => page.goto(`${STACK.issuer('tenant-acme')}/protocol/openid-connect/logout?${params}`, { waitUntil: 'commit' }));
    await page.waitForURL(`${STACK.appOrigin}/`);
    await expect(page.getByRole('heading', { name: 'You are signed out' })).toBeVisible();
    // SSO is gone: a sign-in now shows the credential form (prompt=login, and no session to reuse anyway).
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => u.host === AUTH_HOST);
    await expect(page.locator('#username')).toBeVisible();
  });

  test('shared device: after a sign-out the next sign-in asks for credentials (prompt=login), even with live SSO', async ({ page }) => {
    const t = new Traffic(page);
    await signInFromScratch(page, alice, 'acme');
    // logout() (local) is unreachable from the example (Issue 6): reproduce its persistent effect, the
    // signed-out mark, and reload. Keycloak's SSO session for alice is still alive.
    await page.evaluate((k) => localStorage.setItem(k, String(Date.now())), SIGNED_OUT_KEY);
    await navigateOnce(page, () => page.reload({ waitUntil: 'commit' }));
    await expect(page.getByRole('heading', { name: 'You are signed out' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL((u) => u.host === AUTH_HOST);
    expect(t.authorize[t.authorize.length - 1]!.searchParams.get('prompt')).toBe('login');
    // Keycloak asks for credentials — but with alice's SSO session alive it is a re-authentication of
    // alice ("Please re-authenticate to continue", her username shown, no username field).
    await expect(page.locator('#password')).toBeVisible();
    const previousUserShown = await page.locator('#kc-attempted-username').isVisible();
    const shownName = previousUserShown ? ((await page.locator('#kc-attempted-username').textContent()) ?? '').trim() : '';
    if (previousUserShown) await page.locator('#reset-login').click(); // "Restart login": the next person's only way in
    await keycloakLogin(page, bob);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('acme');
    await eventually(() => t.api.filter((a) => a.url.pathname === '/api/v1/me/session-context').length >= 2, 20_000, 'bob\'s P-35');
    const bobCtx = t.api.filter((a) => a.url.pathname === '/api/v1/me/session-context').at(-1)!;
    expect((bobCtx.json() as { roles: string[] }).roles).toEqual(['member']);
    expect(decodeJwt(t.latestTokens().access_token).sub).toBe(bob.id);
    test.fail(previousUserShown, `Issue 10: after a (local) sign-out, prompt=login shows the previous user (${shownName}) a re-authentication form; the next person must find "Restart login"`);
    expect(previousUserShown).toBe(false);
  });

  test('another tab\'s sign-out reaches this tab, but the example keeps rendering the app', async ({ page, context }) => {
    await signInFromScratch(page, alice, 'acme');
    const other = await context.newPage();
    await other.goto('/version.json');
    // What logout() in another tab does to this one: the signed-out mark and the BroadcastChannel message.
    await other.evaluate((k) => {
      localStorage.setItem(k, String(Date.now()));
      new BroadcastChannel('platform-auth').postMessage({ type: 'logout' });
    }, SIGNED_OUT_KEY);
    await other.close();
    await page.waitForTimeout(1000);
    const stillRendered = await page.getByRole('heading', { name: 'acme' }).isVisible();
    test.fail(stillRendered, 'Issue 7: the example subscribes only to `expired`; on a cross-tab sign-out (`anonymous`, signed-out) it keeps the app on screen');
    if (stillRendered) {
      // Close the stranded app page first: leaving it open made context teardown hang in Firefox and Chromium.
      await page.close();
      throw new Error('Issue 7: the app is still rendered after the cross-tab sign-out');
    }
    await expect(page.getByRole('heading', { name: 'You are signed out' })).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('/csp-report: browser → CloudFront → Lambda (x-origin-verify) → Collector', () => {
  test('a CSP violation in the shell reaches the /csp-report Lambda and becomes a csp.violation log', async ({ page, browserName }) => {
    await signInFromScratch(page, alice, 'acme');
    const marker = `e2e-${browserName}-${Date.now()}`;
    const before = edgeLog().filter((l) => l.behavior === '/csp-report').length;
    await page.evaluate((m) => {
      const img = document.createElement('img');
      img.src = `https://blocked.example.org/${m}.png?secret=1`;
      document.body.append(img);
    }, marker);
    const hop = await eventually(() => edgeLog().filter((l) => l.behavior === '/csp-report').slice(before)[0], 60_000, 'a report at /csp-report').catch(() => undefined);
    test.fail(!hop && browserName === 'chromium', 'E-6: Chromium delivers report-to (Reporting API) reports only to endpoints with a valid certificate; the stack\'s is self-signed');
    expect(hop, 'the browser posted a report to /csp-report').toBeDefined();
    test.fail(hop!.status === 502, 'Issue 11: the Lambda runtime calls handler(event, context): the context lands in the `deps` parameter and every invocation throws (deps.env is undefined)');
    expect(hop!.status).toBe(204);
    const log = await eventually(() => logRecords().find((r) => r.service === 'csp-report' && (r.attributes['csp.blocked_uri'] ?? '').includes(marker)), 60_000, `csp.violation for ${marker}`);
    expect(log.attributes['csp.blocked_uri']).toBe(`https://blocked.example.org/${marker}.png`);
  });

  test('with the Issue 11 fix: x-origin-verify is enforced, both report formats become OTLP logs', async ({ request }) => {
    const host = (JSON.parse(readFileSync(join(STATE, 'cloudfront/lambda-fixed.json'), 'utf8')) as { cspReportFixedHost: string }).cspReportFixedHost;
    const secret = readFileSync(join(STATE, 'origin-verify.secret'), 'utf8').trim();
    const url = `http://127.0.0.1:${STACK.ports.floci}/`;
    const marker = `fixed-${Date.now()}`;
    const reportUri = { 'csp-report': { 'document-uri': `${STACK.appOrigin}/t/acme/?q=1`, 'blocked-uri': `https://blocked.example.org/${marker}-a.png?x=1`, 'effective-directive': 'img-src', disposition: 'enforce' } };
    const reportTo = [{ type: 'csp-violation', body: { documentURL: `${STACK.appOrigin}/t/acme/`, blockedURL: `https://blocked.example.org/${marker}-b.png`, effectiveDirective: 'img-src', disposition: 'enforce' } }];
    // Without the CloudFront origin header: 403, empty body.
    const anon = await request.post(url, { headers: { host, 'content-type': 'application/csp-report' }, data: JSON.stringify(reportUri) });
    expect(anon.status()).toBe(403);
    // As CloudFront sends it.
    const a = await request.post(url, { headers: { host, 'content-type': 'application/csp-report', 'x-origin-verify': secret }, data: JSON.stringify(reportUri) });
    expect(a.status()).toBe(204);
    const b = await request.post(url, { headers: { host, 'content-type': 'application/reports+json', 'x-origin-verify': secret }, data: JSON.stringify(reportTo) });
    expect(b.status()).toBe(204);
    for (const suffix of ['a', 'b']) {
      const log = await eventually(() => logRecords().find((r) => r.service === 'csp-report' && (r.attributes['csp.blocked_uri'] ?? '').includes(`${marker}-${suffix}`)), 30_000, `csp.violation ${suffix}`);
      expect(log.attributes['event.name']).toBe('csp.violation');
      expect(log.attributes['csp.blocked_uri']).toBe(`https://blocked.example.org/${marker}-${suffix}.png`);
      expect(log.attributes['csp.document_uri']).toBe(`${STACK.appOrigin}/t/acme/`);
    }
  });
});

test.describe('clock skew', () => {
  test('a browser clock 3 minutes fast with a 60 s token', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Playwright\'s fake clock (page.clock) hangs WebKit page teardown here; Chromium and Firefox cover it');
    await page.clock.install({ time: new Date(Date.now() + 180_000) });
    const t = new Traffic(page);
    await page.goto('/');
    await page.getByLabel('Company workspace or invitation email').fill('acme');
    await page.getByRole('button', { name: 'Continue' }).click();
    await keycloakLogin(page, alice);
    await page.waitForTimeout(8_000);
    const exchanges = t.tokenCalls.filter((c) => c.grant === 'authorization_code').length;
    const signedIn = await page.getByRole('heading', { name: 'acme' }).isVisible();
    const screen = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160);
    test.info().annotations.push({ type: 'observation', description: `url=${page.url()} screen="${screen}"` });
    test.info().annotations.push({ type: 'observation', description: `${t.authorize.length} authorize redirects, ${exchanges} code exchanges in 8 s; signed in: ${signedIn}` });
    test.fail(!signedIn, `Issue 8: ID token rejected ("exp": 60 s token + 60 s skew < 3 min); ${t.authorize.length} authorize redirects in 8 s`);
    expect(signedIn).toBe(true);
  });
});

test.describe('gateway: rate limits, WAF, JWKS rotation @gateway', () => {
  test('PUB-1 per-IP rate limit at Envoy, keyed on the CloudFront-appended client IP @gateway', async ({ request }) => {
    const statuses: number[] = [];
    let limited: import('@playwright/test').APIResponse | undefined;
    for (let i = 0; i < 25; i++) {
      // A viewer-supplied X-Forwarded-For must not buy a new bucket.
      const r = await request.get('/api/v1/public/tenants/resolve?identifier=acme', { headers: { 'x-forwarded-for': `203.0.113.${i}` } });
      statuses.push(r.status());
      if (r.status() === 429) limited ??= r;
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    const ct = limited!.headers()['content-type'] ?? '';
    test.info().annotations.push({ type: 'observation', description: `429 content-type=${ct} body=${(await limited!.text()).slice(0, 80)}` });
    // Let the bucket refill so a rerun starts clean.
    await new Promise((r) => setTimeout(r, 61_000));
    expect((await request.get('/api/v1/public/tenants/resolve?identifier=acme')).status()).toBe(200);
  });

  test('WAF web ACL with rate rules is created and associated; its data plane blocks a flood @gateway', async ({ request }) => {
    const { distribution, waf } = deployed();
    expect(waf.WebACL?.Rules.map((r) => r.Name)).toEqual(['otel-rate', 'csp-report-rate']);
    const associated = distribution.DistributionConfig.WebACLId === waf.WebACL?.ARN;
    let blocked = 0;
    for (let i = 0; i < 120; i++) {
      const r = await request.post('/otel/v1/logs', { headers: { 'content-type': 'application/json' }, data: '{"resourceLogs":[]}' });
      if (r.status() === 403) blocked++;
    }
    test.fail(!associated || blocked === 0, `E-3/E-4: floci drops the distribution's WebACLId (${distribution.DistributionConfig.WebACLId}) and has no WAF data plane (${blocked}/120 blocked)`);
    expect(associated).toBe(true);
    expect(blocked).toBeGreaterThan(0);
  });

  test('Keycloak signing-key rotation vs Envoy\'s cached JWKS @gateway', async ({ page }) => {
    // A new active RS256 key with a higher priority: Keycloak signs new tokens with it at once.
    const realm = (await kcAdmin<{ id: string }>('GET', '/realms/tenant-acme')).body;
    const created = await kcAdmin('POST', '/realms/tenant-acme/components', {
      name: 'rsa-rotated-e2e', providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider', parentId: realm.id,
      config: { priority: ['500'], keySize: ['2048'], active: ['true'], enabled: ['true'], algorithm: ['RS256'] },
    });
    expect(created.status).toBe(201);
    const componentId = created.headers.get('location')!.split('/').pop()!;
    try {
      const t = new Traffic(page);
      await signInFromScratch(page, alice, 'acme');
      const ctx = await eventually(() => t.apiCall('/api/v1/me/session-context'), 20_000, 'P-35');
      const kid = JSON.parse(Buffer.from(t.latestTokens().access_token.split('.')[0]!, 'base64url').toString()) as { kid: string };
      test.info().annotations.push({ type: 'observation', description: `P-35 with the new kid ${kid.kid}: ${ctx.status} ${ctx.text.slice(0, 60)}` });
      test.fail(ctx.status === 401, 'Issue 9: Envoy keeps the cached JWKS (cache_duration 300 s) and does not refetch on an unknown kid: every token signed with the new key is 401 until the cache expires');
      expect(ctx.status).toBe(200);
    } finally {
      await kcAdmin('DELETE', `/realms/tenant-acme/components/${componentId}`);
    }
  });
});
