/**
 * Sign-in with Keycloak (Authorization Code + PKCE), token refresh, session restore, the idle timeout,
 * logout, and choosing the workspace (realm) before login. Tokens live in memory only.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/auth`.
 *
 * @packageDocumentation
 */
import type { RuntimeConfig } from '../config/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import type { IdentityProvider, SessionState, Workspace, WorkspaceResolver } from './types.ts';
import { chooseWorkspace } from './workspace.ts';

export type {
  IdentityProvider,
  SessionContext,
  SessionContextSource,
  SessionState,
  SessionUser,
  Workspace,
  WorkspaceResolver,
} from './types.ts';
export { createOidcProvider } from './oidc.ts';
export { cachedWorkspace, chooseWorkspace, isWrongWorkspace, rememberWorkspace, slugFromPath } from './workspace.ts';

/** What /http needs from /auth; structurally the same as /http's TokenSource (/auth may not import /http). */
interface TokenSource {
  getAccessToken(): Promise<string | undefined>;
  refresh(): Promise<boolean>;
  onUnauthorized(): void;
}

/**
 * Shell only: makes `p` the page's identity provider (getSession, the /react hooks) and returns the
 * TokenSource for /http's setTokenSource (also installed directly).
 */
export function initializeAuth(p: IdentityProvider): TokenSource {
  if (!p || typeof p.getAccessToken !== 'function' || typeof p.refresh !== 'function') throw new TypeError('initializeAuth needs an IdentityProvider');
  const source: TokenSource = {
    getAccessToken: () => p.getAccessToken(),
    refresh: () => p.refresh(),
    // /http calls this after a 401 that refresh() could not fix. refresh() has already moved the state
    // (expired, a lineage restore, or a token kept while offline), and a background call must never
    // redirect on its own, so there is nothing left to do here.
    onUnauthorized: () => {},
  };
  const rt = getRuntime();
  rt.identityProvider = p;
  rt.tokenSource = source;
  return source;
}

// One object, so React's useSyncExternalStore sees a stable snapshot before initializeAuth.
const LOADING: SessionState = Object.freeze({ status: 'loading' });

/** The current session; `loading` until initializeAuth has run and init() settled. */
export function getSession(): SessionState {
  return (getRuntime().identityProvider as IdentityProvider | undefined)?.getState() ?? LOADING;
}

/**
 * Sign in again after `expired`: chooseWorkspace with `forceResolve: state.serverEnded`, falling back to
 * `ask()`, then idp.login() back to the current URL, with `prompt: 'login'` when `state.idle` (Keycloak's
 * SSO session outlives the idle timeout, so a plain login would skip the credentials).
 */
export async function signInAgain(o: {
  idp: IdentityProvider;
  state: Extract<SessionState, { status: 'expired' }>;
  resolver: WorkspaceResolver;
  cfg: RuntimeConfig['auth'];
  ask: () => Promise<Workspace>;
}): Promise<void> {
  const loc = globalThis.location;
  const workspace =
    (await chooseWorkspace({ pathname: loc?.pathname ?? '/', resolver: o.resolver, cfg: o.cfg, forceResolve: o.state.serverEnded })) ?? (await o.ask());
  await o.idp.login({
    workspace,
    returnUrl: loc ? `${loc.pathname}${loc.search}${loc.hash}` : '/',
    ...(o.state.idle ? { prompt: 'login' as const } : {}),
  });
}
