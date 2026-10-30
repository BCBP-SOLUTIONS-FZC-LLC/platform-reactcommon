// The /auth types (design doc §C1 /auth).

/** From the ID token only: `sub`, profile claims, `auth_time`, and `tenant_id` (trial realm only). No roles: the JWT has none. */
export interface SessionUser {
  readonly sub: string;
  readonly name?: string;
  readonly email?: string;
  readonly tenantId?: string;
  /** Epoch seconds. */
  readonly authTime?: number;
}

/**
 * One login = one tenant (IAM RP-INV-2). A paid workspace has realm `tenant-<slug>`; trial shares `trial`.
 * `slug` is missing only on a pre-login trial result from an invitation email (PUB-1 returns none); such a
 * Workspace is used for that one login and never cached. After sign-in the slug is known and it is cached.
 */
export interface Workspace {
  readonly realm: string;
  readonly trial: boolean;
  readonly slug?: string;
  /** Trial only, from PUB-1; optional (IAM may remove it, OQ-10). Used only by isWrongWorkspace after login. */
  readonly tenantIdHint?: string;
}

/** What the gateway knows and the browser cannot see (roles, departments, plan, flags). UI hints only. */
export interface SessionContext {
  readonly tenantId: string;
  /** The tenant's workspace slug; trial tokens do not carry it. */
  readonly slug: string;
  readonly roles: readonly string[];
  readonly departments: readonly { readonly id: string; readonly level: string }[];
  readonly plan?: string;
  readonly featureFlags: readonly string[];
  readonly readOnly: boolean;
  readonly mfaFreshnessSeconds?: number;
  readonly locale?: string;
}

/**
 * PUB-1, `GET /api/v1/public/tenants/resolve?identifier=` (a slug or a pending-invite email), implemented
 * by the shell with an /http ApiClient on the same origin, so /auth never imports /http. `{found:false}`
 * resolves to undefined.
 */
export interface WorkspaceResolver {
  resolve(identifier: string, signal?: AbortSignal): Promise<Workspace | undefined>;
}

/**
 * IAM P-35, `GET /api/v1/me/session-context`, snake_case mapped to camelCase, implemented by the shell.
 * 404 MEMBER_NOT_FOUND: no membership; 403: a suspended member or a trial_expired/suspended tenant.
 */
export interface SessionContextSource {
  load(signal?: AbortSignal): Promise<SessionContext>;
}

export type SessionState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'anonymous';
      readonly workspace?: Workspace;
      /**
       * 'signed-out': the signed-out mark is set, so never log in automatically.
       * 'login-required': a prompt=none attempt for `workspace` answered login_required, interaction_required or consent_required.
       * 'none': no session and no hint (first visit, rejected callback, loop guard).
       */
      readonly reason: 'none' | 'signed-out' | 'login-required';
    }
  | { readonly status: 'authenticated'; readonly user: SessionUser; readonly workspace: Workspace; readonly expiresAt: number }
  | {
      readonly status: 'expired';
      readonly workspace?: Workspace;
      /** True: invalid_grant before the refresh token's own expiry (refresh_expires_in), e.g. trial → paid conversion. */
      readonly serverEnded: boolean;
      /** True: the SDK idle timeout ended it, so signing in again must ask for credentials. */
      readonly idle: boolean;
    };

export interface IdentityProvider {
  /**
   * Handles a callback (?code= or ?error=) or, with no tokens and a cached workspace, does one prompt=none
   * redirect per tab (the promise never settles; the page unloads). Resolves only to `authenticated` or
   * `anonymous`.
   */
  init(): Promise<Extract<SessionState, { status: 'authenticated' | 'anonymous' }>>;
  /** `prompt: 'login'` forces credentials even when Keycloak's SSO session is alive (used after the idle timeout). */
  login(o: { workspace: Workspace; returnUrl?: string; loginHint?: string; prompt?: 'login' }): Promise<void>;
  /** Local: drop tokens, clear storage, set the signed-out mark. Global: also ends the Keycloak SSO session. */
  logout(o?: { global?: boolean }): Promise<void>;
  getAccessToken(): Promise<string | undefined>;
  /** Single-flight per tab: concurrent callers share one in-flight refresh. */
  refresh(): Promise<boolean>;
  /** Local logout of the current realm, then login(w). */
  switchWorkspace(w: Workspace): Promise<void>;
  /** Step-up: top-level redirect with prompt=login&max_age=<s> (IAM HLD §11.3). */
  reauthenticate(o: { maxAgeSeconds: number; returnUrl?: string }): Promise<void>;
  /** now − auth_time > maxAgeSeconds; false when unknown. */
  needsStepUp(maxAgeSeconds: number): boolean;
  subscribe(l: (s: SessionState) => void): () => void;
  /**
   * Runs synchronously before any SDK-started top-level redirect (step-up, lineage restore, login, switch),
   * so remotes can save drafts to session storage. Listeners must not throw or await; errors are logged and ignored.
   */
  beforeRedirect(l: (r: { reason: 'step-up' | 'restore' | 'login' | 'switch' }) => void): () => void;
  getState(): SessionState;
}
