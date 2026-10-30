// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeAuth, type IdentityProvider, type SessionState } from '../../src/auth/index.ts';
import { roleMapAuthorizer, setAuthorizer } from '../../src/authz/index.ts';
import { setFlagProvider } from '../../src/flags/index.ts';
import { initializeI18n, registerNamespace, setLocale } from '../../src/i18n/index.ts';
import { getRuntime } from '../../src/internal/runtime.ts';
import { resetContainersForTests } from '../../src/mfe/remote.ts';
import { NetworkError, PlatformProblemTypes, type ApiError } from '../../src/problem/index.ts';
import {
  Can,
  MFEErrorBoundary,
  PlatformProvider,
  RemoteBoundary,
  installGlobalErrorHandlers,
  useApi,
  useAppUpdate,
  useBeforeAuthRedirect,
  useCurrentUser,
  useFeatureFlag,
  useHasPermission,
  useLocale,
  useOnlineStatus,
  useReadOnly,
  useRouteTemplate,
  useSession,
  useSessionContext,
  useStepUp,
  useSwitchWorkspace,
  useT,
  useWorkspace,
  type ShellContextValue,
} from '../../src/react/index.ts';
import { createTestPlatform, mockApi, mockProblem } from '../../src/testing/index.ts';
import { cleanup, render, settle } from './render.tsx';

let platform: ReturnType<typeof createTestPlatform>;
const webErrors: { source: string; mfe: string }[] = [];

beforeEach(() => {
  platform = createTestPlatform({ permissions: ['read:tender'], flags: { 'ai.drafting': true } });
  webErrors.length = 0;
  getRuntime().instruments = { ...getRuntime().instruments, webError: (l) => void webErrors.push(l) };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await cleanup();
  platform.reset();
  resetContainersForTests();
  vi.restoreAllMocks();
});

/** An IdentityProvider whose state the test drives. */
function controllableIdp(initial: SessionState) {
  let state = initial;
  const listeners = new Set<(s: SessionState) => void>();
  const redirectListeners = new Set<(r: { reason: 'step-up' | 'restore' | 'login' | 'switch' }) => void>();
  const idp = {
    init: vi.fn(),
    login: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    getAccessToken: vi.fn(async () => 't'),
    refresh: vi.fn(async () => true),
    switchWorkspace: vi.fn(async () => {}),
    reauthenticate: vi.fn(async () => {}),
    needsStepUp: vi.fn((max: number) => state.status === 'authenticated' && (state.user.authTime ?? Infinity) < Date.now() / 1000 - max),
    subscribe: (l: (s: SessionState) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    beforeRedirect: (l: (r: { reason: 'step-up' | 'restore' | 'login' | 'switch' }) => void) => {
      redirectListeners.add(l);
      return () => redirectListeners.delete(l);
    },
    getState: () => state,
  };
  return {
    idp: idp as unknown as IdentityProvider & typeof idp,
    set(s: SessionState) {
      state = s;
      for (const l of [...listeners]) l(s);
    },
    redirect(reason: 'step-up' | 'restore' | 'login' | 'switch') {
      for (const l of [...redirectListeners]) l({ reason });
    },
    redirectListeners,
  };
}

const ACME = { realm: 'tenant-acme', trial: false, slug: 'acme' } as const;

describe('session hooks', () => {
  it('useSession, useCurrentUser and useWorkspace follow the identity provider', async () => {
    const c = controllableIdp({ status: 'loading' });
    initializeAuth(c.idp);
    function View() {
      const s = useSession();
      const user = useCurrentUser();
      const w = useWorkspace();
      return <p>{`${s.status}|${user?.name ?? '-'}|${w?.slug ?? '-'}`}</p>;
    }
    const { container } = await render(<View />);
    expect(container.textContent).toBe('loading|-|-');
    await settle(() => c.set({ status: 'authenticated', user: { sub: 'u', name: 'Ada' }, workspace: ACME, expiresAt: 0 }));
    expect(container.textContent).toBe('authenticated|Ada|acme');
    await settle(() => c.set({ status: 'expired', workspace: ACME, serverEnded: false, idle: true }));
    expect(container.textContent).toBe('expired|-|-');
  });

  it('PlatformProvider supplies the shell user, workspace and session context', async () => {
    const c = controllableIdp({ status: 'loading' });
    initializeAuth(c.idp);
    const shell: ShellContextValue = {
      user: { sub: 'u', name: 'Shell User' },
      workspace: ACME,
      context: { tenantId: 't', slug: 'acme', roles: ['member'], departments: [], featureFlags: [], readOnly: false, plan: 'starter' },
      locale: 'en',
      switchWorkspace: vi.fn(async () => {}),
    };
    let switchTo: ((id: string) => Promise<void>) | undefined;
    function View() {
      switchTo = useSwitchWorkspace();
      return <p>{`${useCurrentUser()?.name}|${useWorkspace()?.slug}|${useSessionContext()?.plan}`}</p>;
    }
    const { container } = await render(
      <PlatformProvider shell={shell}>
        <View />
      </PlatformProvider>,
    );
    expect(container.textContent).toBe('Shell User|acme|starter');
    await switchTo!('globex');
    expect(shell.switchWorkspace).toHaveBeenCalledWith('globex');
  });

  it('useSwitchWorkspace without a shell rejects', async () => {
    let switchTo: ((id: string) => Promise<void>) | undefined;
    function View() {
      switchTo = useSwitchWorkspace();
      return null;
    }
    await render(<View />);
    await expect(switchTo!('x')).rejects.toThrow('PlatformProvider');
  });

  it('useBeforeAuthRedirect calls the latest save and unsubscribes on unmount', async () => {
    const c = controllableIdp({ status: 'loading' });
    initializeAuth(c.idp);
    const saved: string[] = [];
    function Form({ draft }: { draft: string }) {
      useBeforeAuthRedirect(() => saved.push(draft));
      return null;
    }
    const r = await render(<Form draft="v1" />);
    await r.rerender(<Form draft="v2" />);
    c.redirect('step-up');
    expect(saved).toEqual(['v2']);
    await r.unmount();
    expect(c.redirectListeners.size).toBe(0);
  });

  it('useStepUp compares auth_time with the tenant window and redirects back here', async () => {
    const c = controllableIdp({ status: 'authenticated', user: { sub: 'u', authTime: Math.floor(Date.now() / 1000) - 900 }, workspace: ACME, expiresAt: 0 });
    initializeAuth(c.idp);
    const shell: ShellContextValue = {
      context: { tenantId: 't', slug: 'acme', roles: ['member'], departments: [], featureFlags: [], readOnly: false, mfaFreshnessSeconds: 300 },
      locale: 'en',
      switchWorkspace: async () => {},
    };
    let stepUp: ReturnType<typeof useStepUp> | undefined;
    function View() {
      stepUp = useStepUp();
      return null;
    }
    await render(
      <PlatformProvider shell={shell}>
        <View />
      </PlatformProvider>,
    );
    expect(stepUp!.needed).toBe(true);
    await stepUp!.reauthenticate();
    expect(c.idp.reauthenticate).toHaveBeenCalledWith({ maxAgeSeconds: 300, returnUrl: `${location.pathname}${location.search}${location.hash}` });
  });

  it('useStepUp is not needed without a window', async () => {
    let needed: boolean | undefined;
    function View() {
      needed = useStepUp().needed;
      return null;
    }
    await render(<View />);
    expect(needed).toBe(false);
  });
});

describe('read-only, flags, permissions, locale', () => {
  it('useReadOnly: the session context, or a DENY_TENANT_READ_ONLY answer seen later', async () => {
    function View() {
      return <p>{String(useReadOnly())}</p>;
    }
    const { container } = await render(
      <platform.Wrapper>
        <View />
      </platform.Wrapper>,
    );
    expect(container.textContent).toBe('false');
    mockApi({ 'PUT /tenders/:id': mockProblem(PlatformProblemTypes.Forbidden, { errorCode: 'DENY_TENANT_READ_ONLY' }) });
    const { createApiClient } = await import('../../src/http/index.ts');
    await settle(() => createApiClient().put('/tenders/:id', { params: { id: '1' } }).catch(() => {}));
    expect(container.textContent).toBe('true');

    const ro = createTestPlatform({ context: { readOnly: true } });
    const r2 = await render(
      <ro.Wrapper>
        <View />
      </ro.Wrapper>,
    );
    expect(r2.container.textContent).toBe('true');
  });

  it('useFeatureFlag re-renders when the provider or its values change', async () => {
    function View() {
      return <p>{`${useFeatureFlag('ai.drafting', false)}|${useFeatureFlag('limit', 5)}`}</p>;
    }
    const { container } = await render(<View />);
    expect(container.textContent).toBe('true|5');
    let notify: () => void = () => {};
    const values: Record<string, number | boolean> = { limit: 10 };
    await settle(() =>
      setFlagProvider({
        get: (k) => values[k],
        subscribe: (l) => {
          notify = l;
          return () => {};
        },
      }),
    );
    expect(container.textContent).toBe('false|10');
    values.limit = 20;
    await settle(() => notify());
    expect(container.textContent).toBe('false|20');
  });

  it('useHasPermission and Can follow the authorizer', async () => {
    function View() {
      return (
        <p>
          {String(useHasPermission('update', 'tender'))}
          <Can action="read" resource="tender">
            |read
          </Can>
          <Can action="update" resource="tender" fallback="|no-update">
            |update
          </Can>
        </p>
      );
    }
    const { container } = await render(<View />);
    expect(container.textContent).toBe('false|read|no-update');
    await settle(() => setAuthorizer(roleMapAuthorizer({ 'test-role': ['update:tender'] })));
    expect(container.textContent).toBe('true|update');
  });

  it('useLocale and useT follow setLocale and catalog loads', async () => {
    registerNamespace('tenders', async (locale) => (locale === 'ar' ? { save: 'حفظ' } : { save: 'Save' }));
    await initializeI18n({ defaultLocale: 'en', supported: ['en', 'ar'], detect: () => 'en' });
    function View() {
      const { locale, dir } = useLocale();
      const t = useT('tenders');
      return <p>{`${locale}|${dir}|${t('save')}`}</p>;
    }
    const { container } = await render(<View />);
    await settle();
    expect(container.textContent).toBe('en|ltr|Save');
    await settle(() => setLocale('ar'));
    expect(container.textContent).toBe('ar|rtl|حفظ');
  });

  it('useRouteTemplate registers the page template', async () => {
    function Page() {
      useRouteTemplate('/tenders/:id/edit');
      return null;
    }
    await render(<Page />);
    expect(getRuntime().pageRoute).toBe('/tenders/:id/edit');
  });

  it('useOnlineStatus follows the online and offline events', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    function View() {
      return <p>{String(useOnlineStatus())}</p>;
    }
    const { container } = await render(<View />);
    expect(container.textContent).toBe('true');
    online.mockReturnValue(false);
    await settle(() => window.dispatchEvent(new Event('offline')));
    expect(container.textContent).toBe('false');
  });

  it('useAppUpdate reports a newer deployment', async () => {
    let update: ReturnType<typeof useAppUpdate> | undefined;
    function View() {
      update = useAppUpdate();
      return null;
    }
    await render(<View />);
    expect(update!.available).toBe(false);
    await settle(() => {
      const s = getRuntime().appUpdate as { available?: string; listeners: Set<(u: { current: string; available: string }) => void> };
      s.available = '1.1.0';
      for (const l of s.listeners) l({ current: '1.0.0', available: '1.1.0' });
    });
    expect(update!.available).toBe(true);
  });
});

describe('useApi and useApiClient', () => {
  it('loads, reloads, aborts on deps change, and records the MFE scope', async () => {
    let calls = 0;
    mockApi({ 'GET /tenders/:id': (req) => Response.json({ id: req.url.split('/').pop(), n: ++calls }) });
    const labels: string[] = [];
    getRuntime().instruments = { ...getRuntime().instruments, httpClient: (_s, l) => void labels.push(l.mfe) };
    let reload: () => void = () => {};
    function View({ id }: { id: string }) {
      const r = useApi((c, signal) => c.get<{ id: string; n: number }>('/tenders/:id', { params: { id }, signal }).then((x) => x.data), [id]);
      reload = r.reload;
      return <p>{r.loading ? 'loading' : `${r.data?.id}:${r.data?.n}`}</p>;
    }
    const r = await render(
      <MFEErrorBoundary mfe="tenders">
        <View id="1" />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.textContent).toBe('1:1');
    await settle(() => reload());
    expect(r.container.textContent).toBe('1:2');
    await r.rerender(
      <MFEErrorBoundary mfe="tenders">
        <View id="2" />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.textContent).toBe('2:3');
    expect(new Set(labels)).toEqual(new Set(['tenders']));
  });

  it('returns an ApiError as error, and throws anything else to the boundary', async () => {
    mockApi({ 'GET /tenders/:id': mockProblem(PlatformProblemTypes.NotFound, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }) });
    let seen: ApiError | undefined;
    function View() {
      const r = useApi((c, signal) => c.get('/tenders/:id', { params: { id: '9' }, signal, retry: false }), []);
      seen = r.error;
      return <p>{r.loading ? 'loading' : 'done'}</p>;
    }
    await render(<View />);
    await settle();
    expect(seen?.name).toBe('ProblemError');

    function Broken() {
      useApi(async () => {
        throw new TypeError('bug in fn');
      }, []);
      return <p>ok</p>;
    }
    const r = await render(
      <MFEErrorBoundary mfe="tenders">
        <Broken />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.textContent).toContain('Something went wrong.');
  });

  it('aborts the request on unmount', async () => {
    let signal: AbortSignal | undefined;
    function View() {
      useApi((_c, s) => {
        signal = s;
        return new Promise(() => {});
      }, []);
      return null;
    }
    const r = await render(<View />);
    await r.unmount();
    expect(signal?.aborted).toBe(true);
  });
});

describe('MFEErrorBoundary', () => {
  it('logs with the mfe scope, counts the error, shows trace and request ids, and retries', async () => {
    const { ProblemError } = await import('../../src/problem/index.ts');
    const { parseProblemResponse } = await import('../../src/problem/index.ts');
    const problem = await parseProblemResponse(mockProblem(PlatformProblemTypes.Conflict, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736' }), {
      requestId: 'req-1',
    });
    expect(problem).toBeInstanceOf(ProblemError);
    let fail = true;
    function Child() {
      if (fail) throw problem;
      return <p>recovered</p>;
    }
    const r = await render(
      <MFEErrorBoundary mfe="tenders">
        <Child />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.querySelector('[role=alert]')).not.toBeNull();
    expect(r.container.textContent).toContain('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(webErrors).toEqual([{ source: 'boundary', mfe: 'tenders' }]);
    expect(platform.logs.find((l) => l.body === 'remote showed an error')?.attributes.mfe).toBe('tenders');
    fail = false;
    await settle(() => r.container.querySelector('button')!.click());
    expect(r.container.textContent).toBe('recovered');
  });

  it('renders a custom fallback with the view; a render bug is an error log', async () => {
    function Child(): never {
      throw new Error('boom');
    }
    const r = await render(
      <MFEErrorBoundary mfe="iam_admin" fallback={(v) => <p>{`custom:${v.message}`}</p>}>
        <Child />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.textContent).toBe('custom:Something went wrong.');
    const log = platform.logs.find((l) => l.body === 'remote failed to render');
    expect(log?.level).toBe('error');
    expect(log?.attributes['exception.message']).toBe('boom');
  });

  it('an offline network error says so', async () => {
    function Child(): never {
      throw new NetworkError(true, 'req-2');
    }
    const r = await render(
      <MFEErrorBoundary mfe="tenders">
        <Child />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(r.container.textContent).toContain('You are offline.');
    expect(r.container.textContent).toContain('req-2');
  });

  it('a chunk-load error reloads the page once', async () => {
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload } as Location);
    function Child(): never {
      throw Object.assign(new Error('Loading chunk 42 failed'), { name: 'ChunkLoadError' });
    }
    await render(
      <MFEErrorBoundary mfe="tenders">
        <Child />
      </MFEErrorBoundary>,
    );
    await settle();
    expect(reload).toHaveBeenCalledOnce();
    expect(webErrors).toEqual([{ source: 'chunk_load', mfe: 'tenders' }]);
  });
});

describe('RemoteBoundary', () => {
  function installRemote(get: (m: string) => Promise<() => unknown>) {
    getRuntime().manifest = { tenders: { entry: '/remotes/tenders/1.0.0/remoteEntry.js', version: '1.0.0', ownerDomain: 'tender_management' } };
    (globalThis as Record<string, unknown>).tenders = { init: async () => {}, get };
  }
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).tenders;
  });

  it('loads the remote module lazily and renders its default export with props', async () => {
    installRemote(async () => () => ({ default: ({ id }: { id: string }) => <p>{`tender ${id}`}</p> }));
    const r = await render(<RemoteBoundary remote="tenders" module="./EditTender" fallback={<p>loading</p>} props={{ id: '42' }} />);
    await settle();
    expect(r.container.textContent).toBe('tender 42');
  });

  it('a failed load shows the fallback, and retry loads again', async () => {
    let ok = false;
    installRemote(async () => {
      if (!ok) throw new Error('module missing');
      return () => ({ default: () => <p>loaded</p> });
    });
    const r = await render(<RemoteBoundary remote="tenders" module="./EditTender" />);
    await settle();
    expect(r.container.querySelector('[role=alert]')).not.toBeNull();
    ok = true;
    await settle(() => r.container.querySelector('button')!.click());
    await settle();
    expect(r.container.textContent).toBe('loaded');
  });

  it('a killed remote says it is unavailable', async () => {
    createTestPlatform({ config: { remotes: { killSwitch: ['tenders'], loadTimeoutMs: 10_000, retries: 0, allowedOrigins: [] } } });
    installRemote(async () => () => ({ default: () => <p>never</p> }));
    const r = await render(<RemoteBoundary remote="tenders" module="./EditTender" />);
    await settle();
    expect(r.container.textContent).toContain('unavailable');
  });
});

describe('installGlobalErrorHandlers', () => {
  it('logs uncaught errors and rejections, and CSP violations with the blocked origin only', async () => {
    const off = installGlobalErrorHandlers();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('uncaught'), message: 'uncaught' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('rejected');
    window.dispatchEvent(rejection);
    const csp = new Event('securitypolicyviolation') as Event & Record<string, unknown>;
    Object.assign(csp, { violatedDirective: 'script-src-elem', blockedURI: 'https://evil.example/x.js?token=secret', disposition: 'enforce' });
    window.dispatchEvent(csp);
    off();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('after off') }));
    await settle();

    expect(platform.logs.map((l) => [l.level, l.body])).toEqual([
      ['error', 'uncaught error'],
      ['error', 'unhandled promise rejection'],
      ['warn', 'content security policy violation'],
    ]);
    const v = platform.logs[2]!.attributes;
    expect([v.violated_directive, v.blocked_uri, v.disposition]).toEqual(['script-src-elem', 'https://evil.example', 'enforce']);
    expect(JSON.stringify(platform.logs)).not.toContain('secret');
    expect(webErrors).toEqual([
      { source: 'unhandled_error', mfe: 'shell' },
      { source: 'unhandled_rejection', mfe: 'shell' },
    ]);
  });
});
