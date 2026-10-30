// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSession, type IdentityProvider } from '../../src/auth/index.ts';
import { hasPermission } from '../../src/authz/index.ts';
import { hasConsent } from '../../src/core/index.ts';
import { getFlag } from '../../src/flags/index.ts';
import { createApiClient } from '../../src/http/index.ts';
import { getRuntime } from '../../src/internal/runtime.ts';
import { getLogger } from '../../src/logging/index.ts';
import { shutdownLogging } from '../../src/logging/logging.ts';
import { getServiceMeter } from '../../src/metrics/index.ts';
import { PlatformProblemTypes, isProblemError, parseProblemResponse } from '../../src/problem/index.ts';
import { useBeforeAuthRedirect, useCurrentUser, useSessionContext, useStepUp, useSwitchWorkspace, useWorkspace } from '../../src/react/index.ts';
import { withSpan } from '../../src/tracing/index.ts';
import { shutdownTracing } from '../../src/tracing/tracing.ts';
import { createTestPlatform, mockApi, mockProblem, renderMetricInventory } from '../../src/testing/index.ts';
import { fixture } from '../core/helpers.ts';
import { cleanup, render, settle } from '../react/render.tsx';

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
