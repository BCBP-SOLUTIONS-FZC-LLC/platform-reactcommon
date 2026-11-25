// The hooks of design doc §C1 /react. They read SDK state through the subpaths' public functions and
// re-render on the PlatformRuntime's change topics (src/internal/events.ts), so a remote that takes
// the SDK from the shell sees the shell's session, flags, permissions and locale.
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { getSession, type IdentityProvider, type SessionContext, type SessionState, type SessionUser, type Workspace } from '../auth/index.ts';
import { hasPermission } from '../authz/index.ts';
import { getFlag, type FlagValue } from '../flags/index.ts';
import { createApiClient, type ApiClient, type RouteTemplate } from '../http/index.ts';
import { t } from '../i18n/index.ts';
import { getLogger, setRouteTemplate } from '../logging/index.ts';
import { subscribeAppUpdate } from '../mfe/index.ts';
import { AbortedError, NetworkError, TimeoutError, isProblemError, type ApiError } from '../problem/index.ts';
import { subscribeRuntime } from '../internal/events.ts';
import { runtimeLocale, directionOf } from '../internal/locale.ts';
import { isOnline, subscribeOnline } from '../internal/online.ts';
import { getRuntime } from '../internal/runtime.ts';
import { MfeContext, ShellContext, type ShellContextValue } from './context.ts';
import { onBeforeReload, reloadPage } from '../internal/reload.ts';

function identityProvider(): IdentityProvider | undefined {
  return getRuntime().identityProvider as IdentityProvider | undefined;
}

// Subscribe functions live at module scope: useSyncExternalStore resubscribes whenever their identity
// changes, so an inline arrow would unsubscribe and subscribe again on every render.

/** The current provider's changes, and a switch to the new provider when initializeAuth runs (later). */
function subscribeSession(l: () => void): () => void {
  let stopIdp = identityProvider()?.subscribe(l);
  const stopRuntime = subscribeRuntime('session', () => {
    stopIdp?.();
    stopIdp = identityProvider()?.subscribe(l);
    l();
  });
  return () => {
    stopRuntime();
    stopIdp?.();
  };
}
const subscribeReadOnly = (l: () => void) => subscribeRuntime('read-only', l);
const subscribeI18n = (l: () => void) => subscribeRuntime('i18n', l);
const subscribeFlags = (l: () => void) => subscribeRuntime('flags', l);
const subscribeAuthz = (l: () => void) => subscribeRuntime('authz', l);
const readOnlyDenied = () => getRuntime().readOnlyDenied;
const currentLocale = () => runtimeLocale().locale;

function useShell(): ShellContextValue | undefined {
  return useContext(ShellContext);
}

/** The session as /auth reports it; `loading` until the shell has run initializeAuth. */
export function useSession(): SessionState {
  return useSyncExternalStore(subscribeSession, getSession, getSession);
}

export function useCurrentUser(): SessionUser | undefined {
  const s = useSession();
  const shell = useShell();
  return s.status === 'authenticated' ? s.user : shell?.user;
}

export function useWorkspace(): Workspace | undefined {
  const s = useSession();
  const shell = useShell();
  return s.status === 'authenticated' ? s.workspace : shell?.workspace;
}

/** Roles, departments, plan and flags from IAM P-35; undefined until loaded. UI hints only. */
export function useSessionContext(): SessionContext | undefined {
  return useShell()?.context;
}

/**
 * Runs `save` synchronously before any SDK-started top-level navigation: an auth redirect (step-up, lineage
 * restore, login, switch) or a reload (a chunk-load error after a deploy, useAppUpdate().reload), e.g. to
 * keep a draft in storage(appId, { area: 'session' }). Unsubscribed on unmount.
 */
export function useBeforeAuthRedirect(save: () => void): void {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    const stopRedirect = identityProvider()?.beforeRedirect(() => latest.current());
    const stopReload = onBeforeReload(() => latest.current());
    return () => {
      stopRedirect?.();
      stopReload();
    };
  }, []);
}

/** SessionContext.readOnly, or a DENY_TENANT_READ_ONLY answer seen on this page. */
export function useReadOnly(): boolean {
  const ctx = useSessionContext();
  const denied = useSyncExternalStore(subscribeReadOnly, readOnlyDenied, readOnlyDenied);
  return ctx?.readOnly === true || denied;
}

/**
 * Step-up MFA before an approver action: `needed` when the login is older than the tenant's window
 * (SessionContext.mfaFreshnessSeconds); reauthenticate() redirects back to this page.
 */
export function useStepUp(): { needed: boolean; reauthenticate(): Promise<void> } {
  const ctx = useSessionContext();
  useSession(); // re-evaluate after a new login
  const window = ctx?.mfaFreshnessSeconds;
  const needed = window !== undefined && identityProvider()?.needsStepUp(window) === true;
  // The MFA window lapses while the page stays open: look again every 15 s until it has.
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (window === undefined || needed) return undefined;
    const timer = setInterval(() => {
      if (identityProvider()?.needsStepUp(window) === true) recheck();
    }, 15_000);
    return () => clearInterval(timer);
  }, [window, needed]);
  const reauthenticate = useCallback(async () => {
    const idp = identityProvider();
    if (!idp) throw new Error('useStepUp: no identity provider (initializeAuth has not run)');
    const loc = globalThis.location;
    await idp.reauthenticate({ maxAgeSeconds: window ?? 0, returnUrl: loc ? `${loc.pathname}${loc.search}${loc.hash}` : '/' });
  }, [window]);
  return { needed, reauthenticate };
}

/** The page locale and its direction; re-renders on setLocale. */
export function useLocale(): { locale: string; dir: 'ltr' | 'rtl' } {
  const locale = useSyncExternalStore(subscribeI18n, currentLocale, currentLocale);
  return useMemo(() => ({ locale, dir: directionOf(locale) }), [locale]);
}

/**
 * Signs the user out, from any component (shell or remote). Global by default: it also ends the identity
 * provider's session, so the next person on this device signs in from scratch. `{ global: false }` is a
 * local-only sign-out (the provider's session stays alive; the next sign-in asks for the previous user's
 * credentials and shows their name).
 */
export function useSignOut(): (o?: { global?: boolean }) => Promise<void> {
  const shell = useShell();
  return useCallback(
    (o?: { global?: boolean }) => {
      if (!shell?.signOut) return Promise.reject(new Error('useSignOut needs a shell that provides signOut (PlatformProvider)'));
      return shell.signOut(o);
    },
    [shell],
  );
}

/** A refresh of the session context: started (or about to start, within the tick it was asked for) or queued. */
interface RefreshRun {
  readonly promise: Promise<boolean>;
  readonly settle: (applied: boolean) => void;
  /** The shell's callback, from the latest call that joined the run. */
  call: () => Promise<boolean>;
  started: boolean;
}

/** Page-wide, in the runtime: every remote shares the shell's refresh. */
interface ContextRefreshState {
  run?: RefreshRun | undefined;
  next?: RefreshRun | undefined;
}

function refreshState(): ContextRefreshState {
  const rt = getRuntime();
  rt.contextRefresh ??= {};
  return rt.contextRefresh as ContextRefreshState;
}

function newRun(call: () => Promise<boolean>): RefreshRun {
  let settle!: (applied: boolean) => void;
  const promise = new Promise<boolean>((resolve) => (settle = resolve));
  return { promise, settle, call, started: false };
}

function startRun(s: ContextRefreshState, run: RefreshRun): void {
  run.started = true;
  let pending: Promise<boolean>;
  try {
    pending = Promise.resolve(run.call());
  } catch (e) {
    pending = Promise.reject(e);
  }
  void pending.then(
    (applied) => applied === true,
    (e: unknown) => {
      getLogger().warn('session context refresh failed', { error: e });
      return false;
    },
  ).then((applied) => {
    // The queued run starts before this one's callers continue, so a call they make next queues after it.
    s.run = s.next;
    s.next = undefined;
    if (s.run) startRun(s, s.run);
    run.settle(applied);
  });
}

/**
 * Calls in the same tick share one refresh. A call made while one is in flight waits for one refresh that
 * starts after it, shared by every call made meanwhile: the running one may have read P-35 before the change
 * the caller wants to see (its own role change, P-28).
 */
function requestRefresh(call: () => Promise<boolean>): Promise<boolean> {
  const s = refreshState();
  if (s.run && !s.run.started) {
    s.run.call = call;
    return s.run.promise;
  }
  if (s.run) {
    if (s.next) s.next.call = call;
    else s.next = newRun(call);
    return s.next.promise;
  }
  const run = newRun(call);
  s.run = run;
  queueMicrotask(() => startRun(s, run));
  return run.promise;
}

/**
 * Asks the shell to reload the session context (roles, departments, plan, flags: IAM P-35), e.g. after the
 * user changed their own roles or after a 403 DENY_ROLE_INSUFFICIENT. The function keeps its identity across
 * renders. Calls share refreshes page-wide (calls in the same tick share one; a call made while one is in
 * flight gets the next). It never rejects:
 *
 * - true: the shell applied a new context; hooks reading it re-render.
 * - false: nothing was applied. The shell has no refreshContext (an older shell, a standalone remote), the
 *   load failed and the old context stays, or the shell took over the page (a refusal, another workspace, a
 *   sign-out), which it handles itself.
 *
 * Refresh once and re-render; never retry the request that was refused in a loop. A UI hint correction
 * only: the gateway still decides every request.
 */
export function useRefreshSessionContext(): () => Promise<boolean> {
  const shell = useShell();
  const latest = useRef(shell);
  latest.current = shell;
  return useCallback(() => {
    const s = latest.current;
    const refresh = s?.refreshContext;
    if (!refresh) return Promise.resolve(false);
    return requestRefresh(() => refresh.call(s));
  }, []);
}

export function useSwitchWorkspace(): (identifierOrSlug: string) => Promise<void> {
  const shell = useShell();
  return useCallback(
    (identifierOrSlug: string) => {
      if (!shell) return Promise.reject(new Error('useSwitchWorkspace needs the shell (PlatformProvider)'));
      return shell.switchWorkspace(identifierOrSlug);
    },
    [shell],
  );
}

export function useFeatureFlag<T extends FlagValue>(key: string, fallback: T): T {
  return useSyncExternalStore(
    subscribeFlags,
    () => getFlag(key, fallback),
    () => getFlag(key, fallback),
  );
}

/** A UI hint (hide or disable); the backend authorises the request itself. */
export function useHasPermission(action: string, resource: string): boolean {
  return useSyncExternalStore(
    subscribeAuthz,
    () => hasPermission(action, resource),
    () => hasPermission(action, resource),
  );
}

/** An ApiClient for the nearest MFE scope (its calls carry the remote's mfe label). */
export function useApiClient(): ApiClient {
  const mfe = useContext(MfeContext);
  return useMemo(() => createApiClient(mfe ? { mfe } : undefined), [mfe]);
}

function isApiError(e: unknown): e is ApiError {
  return isProblemError(e) || e instanceof TimeoutError || e instanceof NetworkError;
}

/**
 * Runs `fn` on mount and whenever `deps` change, aborting the previous run (and on unmount). An
 * ApiError is returned as `error`; anything else is thrown to the nearest error boundary. `reload()`
 * keeps the current data while it loads; new `deps` never show the previous deps' data or error.
 */
export function useApi<T>(
  fn: (api: ApiClient, signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): { data?: T; error?: ApiError; loading: boolean; reload(): void } {
  const api = useApiClient();
  const [attempt, reload] = useReducer((n: number) => n + 1, 0);
  // A new object whenever the caller's deps (or the client) change: the state below belongs to one of them.
  const generation = useMemo(() => ({}), [api, ...deps]);
  const [state, setState] = useState<{ for?: object; data?: T; error?: ApiError; thrown?: { e: unknown }; loading: boolean }>({ loading: true });
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    const ctrl = new AbortController();
    // Same deps (a reload): keep the data while loading. Other deps: start empty.
    const kept = (s: typeof state) => (s.for === generation && s.data !== undefined ? { data: s.data } : {});
    setState((s) => ({ for: generation, ...kept(s), loading: true }));
    latest.current(api, ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setState({ for: generation, data, loading: false });
      },
      (e: unknown) => {
        // Only this run's own abort is silent. An AbortedError from elsewhere ends the load like any error.
        if (ctrl.signal.aborted) return;
        if (e instanceof AbortedError) {
          setState((s) => ({ for: generation, ...kept(s), loading: false }));
          return;
        }
        setState(isApiError(e) ? { for: generation, error: e, loading: false } : { for: generation, thrown: { e }, loading: false });
      },
    );
    return () => ctrl.abort();
  }, [generation, attempt]); // the caller's deps and the client are in generation

  // Rendered with new deps before their effect ran: what is shown is still the old deps' result.
  if (state.for !== generation) return { loading: true, reload };
  if (state.thrown) throw state.thrown.e;
  return {
    ...(state.data !== undefined ? { data: state.data } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
    loading: state.loading,
    reload,
  };
}

/** Registers the current page's route template (logs carry it as page_route; metrics bound it). */
export function useRouteTemplate(template: RouteTemplate): void {
  useEffect(() => {
    setRouteTemplate(template);
  }, [template]);
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribeOnline, isOnline, () => true);
}

/** A newer deployment is available (shell: startVersionPolling); reload() loads it. */
export function useAppUpdate(): { available: boolean; reload(): void } {
  const [available, setAvailable] = useState(false);
  useEffect(() => subscribeAppUpdate(() => setAvailable(true)), []);
  const reload = useCallback(() => reloadPage(), []); // useBeforeAuthRedirect's listeners run first
  return { available, reload };
}

/** A translator for namespace `ns` (the remote's name, or 'platform'); re-renders on locale and catalog changes. */
export function useT(ns: string): (key: string, vars?: Record<string, string | number>) => string {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeRuntime('i18n', bump), []);
  // `version` changes the function identity on purpose, so memoised children re-render after a catalog load
  return useCallback((key: string, vars?: Record<string, string | number>) => t(ns, key, vars), [ns, version]);
}
