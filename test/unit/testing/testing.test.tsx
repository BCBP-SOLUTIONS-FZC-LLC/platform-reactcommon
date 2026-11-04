// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSession, type IdentityProvider } from '../../../packages/frontend-sdk/src/auth/index.ts';
import { hasPermission } from '../../../packages/frontend-sdk/src/authz/index.ts';
import { hasConsent } from '../../../packages/frontend-sdk/src/core/index.ts';
import { getFlag } from '../../../packages/frontend-sdk/src/flags/index.ts';
import { createApiClient } from '../../../packages/frontend-sdk/src/http/index.ts';
import { getRuntime } from '../../../packages/frontend-sdk/src/internal/runtime.ts';
import { getLogger } from '../../../packages/frontend-sdk/src/logging/index.ts';
import { shutdownLogging } from '../../../packages/frontend-sdk/src/logging/logging.ts';
import { getServiceMeter } from '../../../packages/frontend-sdk/src/metrics/index.ts';
import { PlatformProblemTypes, isProblemError, parseProblemResponse } from '../../../packages/frontend-sdk/src/problem/index.ts';
import { useBeforeAuthRedirect, useCurrentUser, useSessionContext, useSignOut, useStepUp, useSwitchWorkspace, useWorkspace } from '../../../packages/frontend-sdk/src/react/index.ts';
import { storage } from '../../../packages/frontend-sdk/src/storage/index.ts';
import { withSpan } from '../../../packages/frontend-sdk/src/tracing/index.ts';
import { shutdownTracing } from '../../../packages/frontend-sdk/src/tracing/tracing.ts';
import { createTestPlatform, mockApi, mockProblem, renderMetricInventory } from '../../../packages/frontend-sdk/src/testing/index.ts';
import { fixture } from '../../fixtures/core.ts';
import { cleanup, render, settle } from '../../fixtures/render.tsx';

afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
});

describe('createTestPlatform', () => {
  it('captures logs and spans in memory, redacted and correlated', async () => {
    const p = createTestPlatform();
    await withSpan('load tender', async () => getLogger({ mfe: 'tenders' }).info('loaded', { tender: '42', password: 'hunter2' }));
    await settle();
    expect(p.spans.map((s) => s.name)).toEqual(['load tender']);
    const log = p.logs.find((l) => l.body === 'loaded')!;
    expect(log.level).toBe('info');
    expect(log.attributes).toMatchObject({ mfe: 'tenders', tender: '42', trace_id: p.spans[0]!.traceId });
    expect(JSON.stringify(log)).not.toContain('hunter2');
    p.reset();
    expect([p.logs, p.spans]).toEqual([[], []]);
  });

  it('signs in a user, grants only the given permissions, and serves flags', async () => {
    const p = createTestPlatform({
      user: { sub: 'u1', name: 'Ada' },
      context: { roles: ['member', 'tenant_admin'], plan: 'business' },
      permissions: ['update:tender'],
      flags: { 'ai.drafting': true },
    });
    expect(getSession()).toMatchObject({ status: 'authenticated', user: { name: 'Ada' } });
    expect(hasPermission('update', 'tender')).toBe(true);
    expect(hasPermission('delete', 'tender')).toBe(false);
    expect(getFlag('ai.drafting', false)).toBe(true);
    function View() {
      const ctx = useSessionContext();
      return <p>{`${useCurrentUser()?.name}|${ctx?.plan}|${ctx?.roles.join(',')}`}</p>;
    }
    const { container } = await render(
      <p.Wrapper>
        <View />
      </p.Wrapper>,
    );
    expect(container.textContent).toBe('Ada|business|member,tenant_admin');
  });

  it('denies everything without permissions and can be created again', () => {
    createTestPlatform({ permissions: ['read:tender'] });
    createTestPlatform();
    expect(hasPermission('read', 'tender')).toBe(false);
  });
});

describe('createTestPlatform spans and exporters', () => {
  it('records the parent span id of nested spans and the error status', async () => {
    const p = createTestPlatform();
    await withSpan('outer', () => withSpan('inner', async () => {}));
    await withSpan('fails', async () => {
      throw new Error('boom');
    }).catch(() => {});
    await settle();
    const byName = Object.fromEntries(p.spans.map((s) => [s.name, s]));
    expect(byName.inner!.parentSpanId).toBe(byName.outer!.spanId);
    expect(byName.inner!.traceId).toBe(byName.outer!.traceId);
    expect(byName.outer!.parentSpanId).toBeUndefined();
    expect([byName.outer!.status, byName.fails!.status]).toEqual(['unset', 'error']);
    expect(byName.fails!.events.map((e) => e.name)).toEqual(['exception']);
  });

  it('flushes pending logs and spans into memory on shutdown', async () => {
    const p = createTestPlatform();
    getLogger().warn('last words');
    const done = withSpan('closing', async () => {});
    await done;
    await shutdownLogging();
    await shutdownTracing();
    expect(p.logs.map((l) => [l.level, l.body])).toContainEqual(['warn', 'last words']);
    expect(p.spans.map((s) => s.name)).toEqual(['closing']);
  });

  it('grants every consent category, with a no-op subscription', () => {
    createTestPlatform();
    expect([hasConsent('essential'), hasConsent('telemetry'), hasConsent('analytics')]).toEqual([true, true, true]);
    const listener = vi.fn();
    const off = getRuntime().consent.subscribe(listener);
    expect(off).toBeTypeOf('function');
    off();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createTestPlatform identity provider', () => {
  const idp = () => getRuntime().identityProvider as IdentityProvider;

  it('is signed in, never redirects, and tells beforeRedirect listeners why', async () => {
    const p = createTestPlatform({ workspace: { realm: 'tenant-acme', trial: true } });
    expect(await idp().init()).toMatchObject({ status: 'authenticated', user: { sub: 'test-user' }, workspace: { realm: 'tenant-acme' } });
    expect([await idp().getAccessToken(), await idp().refresh()]).toEqual(['test-access-token', true]);
    const reasons: string[] = [];
    function Form() {
      useBeforeAuthRedirect(() => reasons.push(`saved:${reasons.length}`));
      return null;
    }
    const seen: string[] = [];
    const off = idp().beforeRedirect((r) => seen.push(r.reason));
    const r = await render(
      <p.Wrapper>
        <Form />
      </p.Wrapper>,
    );
    await idp().login({ workspace: { realm: 'tenant-acme', trial: true } });
    await idp().switchWorkspace({ realm: 'tenant-globex', trial: false });
    await idp().reauthenticate({ maxAgeSeconds: 60 });
    expect(seen).toEqual(['login', 'switch', 'step-up']);
    expect(reasons).toEqual(['saved:0', 'saved:1', 'saved:2']);
    off();
    await r.unmount();
    await idp().login({ workspace: { realm: 'tenant-acme', trial: true } });
    expect([seen, reasons].map((a) => a.length)).toEqual([3, 3]);
    await idp().logout();
    expect(getSession().status).toBe('authenticated'); // logout records nothing: the fake stays signed in
  });

  it('needsStepUp compares the user auth_time with the window, and is false without one', async () => {
    const now = Math.floor(Date.now() / 1000);
    createTestPlatform({ user: { sub: 'u', authTime: now - 600 } });
    expect([idp().needsStepUp(300), idp().needsStepUp(3600)]).toEqual([true, false]);
    createTestPlatform();
    expect(idp().needsStepUp(0)).toBe(false);

    const p = createTestPlatform({ user: { sub: 'u', authTime: now - 600 }, context: { mfaFreshnessSeconds: 300 } });
    let stepUp: ReturnType<typeof useStepUp> | undefined;
    function View() {
      stepUp = useStepUp();
      return null;
    }
    await render(
      <p.Wrapper>
        <View />
      </p.Wrapper>,
    );
    expect(stepUp!.needed).toBe(true);
    await expect(stepUp!.reauthenticate()).resolves.toBeUndefined();
  });

  it('a workspace without a slug gets the slug "test", and the shell can switch workspace', async () => {
    const p = createTestPlatform({ workspace: { realm: 'tenant-x', trial: false } });
    let switchTo: ((id: string) => Promise<void>) | undefined;
    function View() {
      switchTo = useSwitchWorkspace();
      return <p>{`${useWorkspace()?.realm}|${useSessionContext()?.slug}`}</p>;
    }
    const { container } = await render(
      <p.Wrapper>
        <View />
      </p.Wrapper>,
    );
    expect(container.textContent).toBe('tenant-x|test');
    await expect(switchTo!('globex')).resolves.toBeUndefined();
  });
});

describe('createTestPlatform storage', () => {
  afterEach(() => localStorage.clear());

  // mfe-dashboard's report (2026-11-04): storage() dropped every write under createTestPlatform, as if signed out.
  it('persists storage for the signed-in test user', () => {
    createTestPlatform(); // signed in: DEFAULT_USER in workspace { realm: 'tenant-test', slug: 'test' }
    storage('app2').set('theme', 'dark');
    expect(storage('app2').get('theme')).toBe('dark');
    expect(getRuntime().storageNamespace).toBe('tenant-test');
    expect(localStorage.getItem('@bcbp-solutions-fzc-llc/frontend-sdk:storage:tenant-test:app2:theme')).not.toBeNull();
  });

  it('scopes a trial workspace to the tenant: user.tenantId, else the session context\'s', () => {
    createTestPlatform({ workspace: { realm: 'trial', trial: true, slug: 't' }, user: { sub: 'u', name: 'U', email: 'u@example.com', tenantId: '11111111-1111-4111-8111-111111111111' } });
    expect(getRuntime().storageNamespace).toBe('trial:11111111-1111-4111-8111-111111111111');
    createTestPlatform({ workspace: { realm: 'trial', trial: true, slug: 't' }, context: { tenantId: '22222222-2222-4222-8222-222222222222' } });
    expect(getRuntime().storageNamespace).toBe('trial:22222222-2222-4222-8222-222222222222');
  });

  it("storageNamespace: 'anon' tests the signed-out case: nothing is written", () => {
    createTestPlatform({ storageNamespace: 'anon' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storage('app2').set('theme', 'dark');
    expect(storage('app2').get('theme')).toBeUndefined();
    expect(localStorage.length).toBe(0);
  });

  it('a later workspace does not read an earlier one\'s storage', () => {
    createTestPlatform();
    storage('app2').set('theme', 'dark');
    createTestPlatform({ workspace: { realm: 'tenant-other', trial: false, slug: 'other' } });
    expect(storage('app2').get('theme')).toBeUndefined();
  });
});

describe('mockApi and mockProblem', () => {
  it('answers ApiClient calls by method and template, relative to api.baseUrl', async () => {
    const p = createTestPlatform();
    mockApi({
      'GET /tenders/:id': (req) => Response.json({ url: new URL(req.url).pathname }),
      'POST /tenders': new Response(null, { status: 201 }),
    });
    const api = createApiClient();
    expect((await api.get('/tenders/:id', { params: { id: '7' } })).data).toEqual({ url: '/api/tenders/7' });
    expect((await api.post('/tenders', { body: {} })).status).toBe(201);
    expect((await api.post('/tenders', { body: {} })).status).toBe(201); // cloned per call
    const missing = await api.get('/bids', { retry: false }).catch((e: unknown) => e);
    expect(isProblemError(missing) && [missing.status, missing.errorCode]).toEqual([404, 'ROUTE_NOT_FOUND']);
    const before = globalThis.fetch;
    p.reset();
    expect(globalThis.fetch).not.toBe(before);
  });

  it('rejects malformed routes', () => {
    createTestPlatform();
    expect(() => mockApi({ 'FETCH /x': new Response() } as never)).toThrow(TypeError);
  });

  it('mockProblem parses like a real gincommon body', async () => {
    createTestPlatform();
    const real = fixture<{ cases: { name: string; source: string; expected: Record<string, unknown> }[] }>('problem_bodies.json').cases.find(
      (c) => c.name === 'validation_failed' && c.source === 'go',
    )!.expected;
    const res = mockProblem(PlatformProblemTypes.ValidationFailed, {
      instance: '/validation',
      traceId: real.traceId as string,
      validationErrors: real.validationErrors as never,
      timestamp: real.timestamp as string,
    });
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    const parsed = await parseProblemResponse(res);
    const { synthetic: _s, typeId: _t, ...details } = { ...parsed, extensions: { ...parsed.extensions } } as Record<string, unknown>;
    expect(Object.fromEntries(Object.entries(details).filter(([k]) => k in real || k === 'extensions'))).toEqual({ ...real, extensions: {} });
    const ext = await parseProblemResponse(mockProblem(PlatformProblemTypes.Conflict, { extensions: { currentVersion: 3 } }));
    expect(ext.extensions).toEqual({ currentVersion: 3 });
  });
});

describe('renderMetricInventory', () => {
  it('lists the instruments registered through the test platform', () => {
    createTestPlatform();
    getServiceMeter().counter('tender_management_test_app_saves_total', 'Saves.', ['kind']).add(1, { kind: 'draft' });
    expect(renderMetricInventory()).toContain('tender_management_test_app_saves_total{domain="tender_management"');
  });
});

describe('createTestPlatform, review 3', () => {
  it('its shell provides signOut, so useSignOut works in a remote\'s tests, and records each call', async () => {
    const platform = createTestPlatform();
    let signOut: ((o?: { global?: boolean }) => Promise<void>) | undefined;
    function Button() {
      signOut = useSignOut();
      return null;
    }
    await render(
      <platform.Wrapper>
        <Button />
      </platform.Wrapper>,
    );
    await signOut!({ global: false });
    await signOut!();
    expect(platform.signOuts).toEqual([{ global: false }, {}]);
    platform.reset();
    expect(platform.signOuts).toEqual([]);
  });

  it('a new platform stops the previous one: its pagehide listener is removed', () => {
    const added = vi.spyOn(globalThis, 'addEventListener');
    const removed = vi.spyOn(globalThis, 'removeEventListener');
    createTestPlatform();
    const pagehide = added.mock.calls.filter(([type]) => type === 'pagehide').map(([, l]) => l);
    createTestPlatform();
    for (const l of pagehide) expect(removed).toHaveBeenCalledWith('pagehide', l);
  });
});
