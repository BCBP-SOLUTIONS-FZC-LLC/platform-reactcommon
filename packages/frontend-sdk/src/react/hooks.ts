// The hooks of design doc §C1 /react. They read SDK state through the subpaths' public functions and
// re-render on the PlatformRuntime's change topics (src/internal/events.ts), so a remote that takes
// the SDK from the shell sees the shell's session, flags, permissions and locale.
import { useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { getSession, type IdentityProvider, type SessionContext, type SessionState, type SessionUser, type Workspace } from '../auth/index.ts';
import { hasPermission } from '../authz/index.ts';
import { getFlag, type FlagValue } from '../flags/index.ts';
import { createApiClient, type ApiClient, type RouteTemplate } from '../http/index.ts';
import { t } from '../i18n/index.ts';
import { setRouteTemplate } from '../logging/index.ts';
import { subscribeAppUpdate } from '../mfe/index.ts';
import { AbortedError, NetworkError, TimeoutError, isProblemError, type ApiError } from '../problem/index.ts';
import { subscribeRuntime } from '../internal/events.ts';
import { runtimeLocale, directionOf } from '../internal/locale.ts';
import { isOnline, subscribeOnline } from '../internal/online.ts';
import { getRuntime } from '../internal/runtime.ts';
import { MfeContext, ShellContext, type ShellContextValue } from './context.ts';

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
 * Runs `save` synchronously before any SDK-started top-level redirect (step-up, lineage restore, login,
 * switch), e.g. to keep a draft in storage(appId, { area: 'session' }). Unsubscribed on unmount.
 */
export function useBeforeAuthRedirect(save: () => void): void {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => identityProvider()?.beforeRedirect(() => latest.current()) ?? undefined, []);
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
 * ApiError is returned as `error`; anything else is thrown to the nearest error boundary.
 */
export function useApi<T>(
  fn: (api: ApiClient, signal: AbortSignal) => Promise<T>,
  deps: unknown[],
): { data?: T; error?: ApiError; loading: boolean; reload(): void } {
  const api = useApiClient();
  const [attempt, reload] = useReducer((n: number) => n + 1, 0);
  const [state, setState] = useState<{ data?: T; error?: ApiError; thrown?: { e: unknown }; loading: boolean }>({ loading: true });
  const latest = useRef(fn);
  latest.current = fn;

  useEffect(() => {
    const ctrl = new AbortController();
    setState((s) => ({ ...(s.data !== undefined ? { data: s.data } : {}), loading: true }));
    latest.current(api, ctrl.signal).then(
      (data) => {
        if (!ctrl.signal.aborted) setState({ data, loading: false });
      },
      (e: unknown) => {
        // Only this run's own abort is silent. An AbortedError from elsewhere ends the load like any error.
        if (ctrl.signal.aborted) return;
        if (e instanceof AbortedError) {
          setState((s) => ({ ...(s.data !== undefined ? { data: s.data } : {}), loading: false }));
          return;
        }
        setState(isApiError(e) ? { error: e, loading: false } : { thrown: { e }, loading: false });
      },
    );
    return () => ctrl.abort();
    // deps are the caller's, as with useEffect
  }, [api, attempt, ...deps]);

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
  const reload = useCallback(() => globalThis.location?.reload(), []);
  return { available, reload };
}

/** A translator for namespace `ns` (the remote's name, or 'platform'); re-renders on locale and catalog changes. */
export function useT(ns: string): (key: string, vars?: Record<string, string | number>) => string {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeRuntime('i18n', bump), []);
  // `version` changes the function identity on purpose, so memoised children re-render after a catalog load
  return useCallback((key: string, vars?: Record<string, string | number>) => t(ns, key, vars), [ns, version]);
}
