// The Keycloak OIDC provider (design doc §C1 /auth): Authorization Code + PKCE (S256), tokens in this
// closure only, one refresh lineage per tab, silent restore on every page load, a shared idle timeout,
// and a BroadcastChannel for logout and workspace switches (never a token).
import type { RuntimeConfig } from '../config/index.ts';
import { getLogger } from '../logging/index.ts';
import { clearAllAppStorage, workspaceNamespace } from '../storage/index.ts';
import { isOnline, subscribeOnline } from '../internal/online.ts';
import { isSafeRedirect } from '../internal/redirect.ts';
import { retryAfterMs } from '../internal/retry-after.ts';
import { getRuntime } from '../internal/runtime.ts';
import { rotateSessionId } from '../internal/session.ts';
import type { IdentityProvider, SessionState, SessionUser, Workspace, WorkspaceResolver } from './types.ts';
import { cachedWorkspace, slugFromPath } from './workspace.ts';

type Reason = 'step-up' | 'restore' | 'login' | 'switch';
type Settled = Extract<SessionState, { status: 'authenticated' | 'anonymous' }>;

// SDK-reserved keys, outside /storage namespaces.
export const PENDING_PREFIX = '@bcbp-solutions-fzc-llc/frontend-sdk:auth:pending:';
export const RESTORE_MARK_KEY = '@bcbp-solutions-fzc-llc/frontend-sdk:auth:restore-attempt'; // sessionStorage: the loop guard
export const SIGNED_OUT_KEY = '@bcbp-solutions-fzc-llc/frontend-sdk:auth:signed-out'; // localStorage, shared by tabs
export const ACTIVITY_KEY = '@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-activity'; // localStorage, shared by tabs
export const LAST_USER_KEY = '@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-user'; // localStorage: SHA-256 of realm + sub, never the sub
export const CHANNEL_NAME = 'platform-auth';

const PENDING_TTL_MS = 10 * 60_000;
const SKEW_S = 60;
/**
 * How far the device's clock may be from the identity provider's. An ID token comes straight from the
 * token endpoint, so its iat is the provider's clock at receipt: the difference is the device's offset,
 * and token times are judged on the provider's clock. Laptops drift by minutes; beyond this the clock
 * is wrong, and the user is told so (reason 'device-clock') instead of landing back on sign-in.
 */
const MAX_CLOCK_OFFSET_S = 600;

/** The device clock is too far off the provider's to judge the tokens. */
class DeviceClockError extends Error {
  override readonly name = 'DeviceClockError';
  constructor(readonly offsetSeconds: number) {
    super(`the device clock is ${Math.abs(Math.round(offsetSeconds))} s ${offsetSeconds > 0 ? 'ahead of' : 'behind'} the identity provider's`);
  }
}
const REFRESH_LEAD_MS = 60_000;
const REFRESH_JITTER_MS = 10_000;
/** How long a page whose refresh a navigation away cancelled waits before restoring, in case it stays. */
const LEAVING_GRACE_MS = 10_000;
const TOKEN_TIMEOUT_MS = 15_000;
/**
 * Whether the token endpoint deliberately refused the refresh without processing it, so the refresh token
 * was not used: 429, or 503 with Retry-After (Keycloak or its gateway shedding load). It is kept and the
 * refresh retried, from REFRESH_RETRY_MS doubling up to REFRESH_RETRY_MAX_MS (or Retry-After), while the
 * access token stays valid. A 500, 502, 504 or bare 503 stays ambiguous: a gateway may answer it after
 * Keycloak rotated the token, and resending the old one is refresh-token reuse, which ends the session.
 */
function refusedUnprocessed(res: Response): boolean {
  return res.status === 429 || (res.status === 503 && res.headers.has('retry-after'));
}
const REFRESH_RETRY_MS = 2_000;
/** getAccessToken refreshes a token this close to expiry rather than hand it out. */
const ACCESS_TOKEN_LEAD_MS = 5_000;
const REFRESH_RETRY_MAX_MS = 30_000;
const ACTIVITY_WRITE_MS = 5_000;
const IDLE_CHECK_MS = 15_000;
/** Allowed between a step-up's max_age and the answer's auth_time (clock skew, the user's own time at the IdP). */
const STEP_UP_SKEW_S = 120;
const SILENT_ERRORS = new Set(['login_required', 'interaction_required', 'consent_required']);
const REALM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

interface PendingLogin {
  state: string;
  codeVerifier: string;
  nonce: string;
  workspace: Workspace;
  returnUrl: string;
  reason: Reason;
  createdAt: number;
  /** Step-up: the max_age asked for, checked against the answer's auth_time (OIDC Core §3.1.2.1). */
  maxAge?: number;
}

interface Tokens {
  access: string;
  idToken: string | undefined;
  refresh: string | undefined;
  /** Epoch ms. */
  expiresAt: number;
  /** The access token's lifetime (expires_in), ms. */
  lifetimeMs: number;
  /** Epoch ms of the refresh token's own expiry (refresh_expires_in), when the server said. */
  refreshExpiresAt: number | undefined;
  /** The first ID token's sub and nonce: refreshed ID tokens must keep them. */
  sub: string;
  nonce: string;
}

interface TokenResponse {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_expires_in?: unknown;
  error?: unknown;
}

/**
 * A top-level form POST to `url`: the fields travel in the body, never in the URL, so nothing lands in the
 * browser's history or an access log. CSP form-action must allow the IdP origin (examples/cloudfront/csp.mjs).
 */
export function postNavigate(url: string, fields: Record<string, string>): void {
  const doc = globalThis.document;
  const form = doc.createElement('form');
  form.method = 'post';
  form.action = url;
  form.style.display = 'none';
  for (const [name, value] of Object.entries(fields)) {
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
  // The ID token must not stay in the DOM: not if the POST is blocked, not on a page restored from the
  // back/forward cache. Removed once the page is leaving, or after 10 s if it never does.
  const remove = () => {
    clearTimeout(timer);
    globalThis.removeEventListener?.('pagehide', remove);
    form.remove();
  };
  const timer = setTimeout(remove, 10_000);
  globalThis.addEventListener?.('pagehide', remove);
}

/** Test seams: the clock, randomness and the page navigation. */
const internals = {
  now: () => Date.now(),
  random: () => Math.random(),
  assign: (url: string) => globalThis.location.assign(url),
  post: postNavigate,
};

export function setAuthInternalsForTests(o: Partial<typeof internals>): void {
  Object.assign(internals, o);
}

const log = () => getLogger();

function store(area: 'local' | 'session'): Storage | undefined {
  try {
    return (area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? undefined;
  } catch {
    return undefined;
  }
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return base64url(b);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

async function s256(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

/**
 * Storage namespaces are per tenant, not per user: when this sign-in is a different user from the last
 * one on this browser (a shared device after idle expiry, step-up or signInAgain), the previous user's
 * app storage goes before the new one sees it. Only a hash of realm + sub is kept. With no
 * fingerprint recorded yet (first sign-in on this browser, or after an upgrade) nothing is cleared,
 * so a draft saved just before the login redirect survives; an unreadable fingerprint clears.
 */
async function forgetPreviousUser(realm: string, sub: string): Promise<void> {
  const fp = Array.from(await sha256(`${realm}\n${sub}`), (b) => b.toString(16).padStart(2, '0')).join('');
  const s = store('local');
  let last: string | null | undefined;
  try {
    last = s ? s.getItem(LAST_USER_KEY) : undefined;
  } catch {
    last = undefined; // unreadable: treat as a different user
  }
  if (last === fp) return;
  if (last !== null) clearAllAppStorage();
  try {
    s?.setItem(LAST_USER_KEY, fp);
  } catch {
    // the next sign-in clears again, which is the safe side
  }
}

/** The JWT payload, or undefined when it is not a JWT with a JSON object payload. Never verifies. */
function jwtPayload(jwt: string): Record<string, unknown> | undefined {
  const part = jwt.split('.')[1];
  if (!part) return undefined;
  try {
    const bin = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as unknown;
    return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function currentUrl(): string {
  const loc = globalThis.location;
  return loc ? `${loc.pathname}${loc.search}${loc.hash}` : '/';
}

function safeReturnUrl(url: string | undefined): string {
  return url !== undefined && isSafeRedirect(url) ? url : '/';
}

function replaceUrl(url: string): void {
  try {
    globalThis.history?.replaceState(globalThis.history.state, '', url);
  } catch {
    // a URL the browser refuses: the page stays where it is
  }
}

function readPending(key: string): PendingLogin | undefined {
  try {
    const r = JSON.parse(store('session')?.getItem(key) ?? 'null') as PendingLogin | null;
    if (!r || typeof r.state !== 'string' || typeof r.codeVerifier !== 'string' || typeof r.nonce !== 'string') return undefined;
    if (typeof r.workspace?.realm !== 'string' || typeof r.workspace.trial !== 'boolean' || typeof r.createdAt !== 'number') return undefined;
    return r;
  } catch {
    return undefined;
  }
}

/** Deletes expired or malformed pending-login records. */
function purgePending(now: number): void {
  const s = store('session');
  if (!s) return;
  try {
    for (let i = s.length - 1; i >= 0; i--) {
      const k = s.key(i);
      if (!k?.startsWith(PENDING_PREFIX)) continue;
      const r = readPending(k);
      if (!r || now - r.createdAt > PENDING_TTL_MS || now < r.createdAt - PENDING_TTL_MS) s.removeItem(k);
    }
  } catch {
    // nothing to purge
  }
}

/** Takes (reads and deletes) the unexpired record for `state`, so a code is exchanged at most once. */
function takePending(state: string | null, now: number): PendingLogin | undefined {
  if (!state || !/^[A-Za-z0-9_-]{16,128}$/.test(state)) return undefined;
  const key = `${PENDING_PREFIX}${state}`;
  const r = readPending(key);
  try {
    store('session')?.removeItem(key);
  } catch {
    // already gone
  }
  if (!r || r.state !== state || now - r.createdAt > PENDING_TTL_MS || now < r.createdAt - PENDING_TTL_MS) return undefined;
  return r;
}

function flag(area: 'local' | 'session', key: string, on?: boolean): boolean {
  const s = store(area);
  try {
    if (on === true) s?.setItem(key, String(internals.now()));
    else if (on === false) s?.removeItem(key);
    return s?.getItem(key) !== null && s?.getItem(key) !== undefined;
  } catch {
    return false;
  }
}

function userFrom(claims: Record<string, unknown>, trial: boolean): SessionUser {
  const str = (k: string) => (typeof claims[k] === 'string' && claims[k] !== '' ? (claims[k] as string) : undefined);
  const name = str('name');
  const email = str('email');
  const tenantId = trial ? str('tenant_id') : undefined;
  const authTime = typeof claims.auth_time === 'number' && Number.isFinite(claims.auth_time) ? claims.auth_time : undefined;
  return {
    sub: claims.sub as string,
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
    ...(tenantId ? { tenantId } : {}),
    ...(authTime !== undefined ? { authTime } : {}),
  };
}

/** Auth Code + PKCE (S256) against Keycloak, realm per Workspace. */
export function createOidcProvider(cfg: RuntimeConfig['auth'], resolver: WorkspaceResolver): IdentityProvider {
  void resolver; // the provider never resolves: the realm comes from a Workspace chooseWorkspace checked
  const issuer = (realm: string) => `${cfg.idpOrigin}/realms/${encodeURIComponent(realm)}`;
  const endpoint = (realm: string, path: 'auth' | 'token' | 'logout') => `${issuer(realm)}/protocol/openid-connect/${path}`;
  const redirectUri = () => `${globalThis.location?.origin ?? ''}${cfg.redirectPath}`;

  let state: SessionState = { status: 'loading' };
  let tokens: Tokens | undefined;
  let workspace: Workspace | undefined;
  let user: SessionUser | undefined;
  /** Device clock minus the provider's, in seconds, from the last accepted ID token (auth_time checks). */
  let clockOffsetS = 0;
  let inflight: Promise<boolean> | undefined;
  let restoring = false;
  let initPromise: Promise<Settled> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setInterval> | undefined;
  let stopActivity: (() => void) | undefined;
  let stopOnline: (() => void) | undefined;
  let lastActivityWrite = 0;
  /** Another tab signed out while this one was not signed in (loading): its sign-in in progress is dropped. */
  let signedOutElsewhere = false;
  /** Refreshes retried in a row after the token endpoint refused one (refusedUnprocessed). */
  let unavailableRetries = 0;
  const listeners = new Set<(s: SessionState) => void>();
  const redirectListeners = new Set<(r: { reason: Reason }) => void>();

  const setState = (s: SessionState) => {
    state = s;
    for (const l of [...listeners]) {
      try {
        l(s);
      } catch (e) {
        log().error('session listener failed', { error: e });
      }
    }
  };

  // --- cross-tab channel ---------------------------------------------------------------------
  let channel: BroadcastChannel | undefined;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL_NAME) : undefined;
  } catch {
    channel = undefined;
  }
  const broadcast = (type: 'logout' | 'workspace-switched') => {
    try {
      channel?.postMessage({ type });
    } catch {
      // other tabs learn at their next refresh
    }
  };
  channel?.addEventListener('message', (ev: MessageEvent) => {
    const type = (ev.data as { type?: unknown } | null)?.type;
    if (state.status !== 'authenticated') {
      // Expired (idle, a lapsed session) or still loading: no tokens to drop, but the storage namespace is
      // the tenant's, which the sending tab just cleared; a write here would outlive the sign-out.
      if ((type === 'logout' || type === 'workspace-switched') && state.status !== 'anonymous') {
        restoring = false;
        dropTokens();
        getRuntime().storageNamespace = 'anon';
        if (type === 'logout') signedOutElsewhere = true; // a sign-in this tab is finishing must not undo it
        if (type === 'logout' && state.status === 'expired') setState({ status: 'anonymous', ...(workspace ? { workspace } : {}), reason: 'signed-out' });
      }
      return;
    }
    if (type === 'logout') {
      // The sending tab cleared storage, rotated the session id and set the signed-out mark.
      restoring = false;
      dropTokens();
      getRuntime().storageNamespace = 'anon';
      setState({ status: 'anonymous', ...(workspace ? { workspace } : {}), reason: 'signed-out' });
    } else if (type === 'workspace-switched') {
      expire({ serverEnded: false, idle: false });
    }
  });

  // --- tokens and timers ---------------------------------------------------------------------
  function stopTimers(): void {
    clearTimeout(refreshTimer);
    clearInterval(idleTimer);
    refreshTimer = undefined;
    idleTimer = undefined;
    stopActivity?.();
    stopActivity = undefined;
    stopOnline?.();
    stopOnline = undefined;
  }

  function dropTokens(): void {
    tokens = undefined;
    unavailableRetries = 0;
    stopTimers();
  }

  function expire(o: { serverEnded: boolean; idle: boolean }): void {
    restoring = false;
    dropTokens();
    setState({ status: 'expired', ...(workspace ? { workspace } : {}), serverEnded: o.serverEnded, idle: o.idle });
  }

  function scheduleRefresh(): void {
    clearTimeout(refreshTimer);
    if (!tokens) return;
    // A minute before expiry, but never more than a third of the token's lifetime, with jitter of at most
    // half the lead: a token is refreshed no sooner than half its lifetime after it was issued, however
    // short the realm's access-token lifespan. (With a fixed 60 s lead, a 60 s token was due for refresh
    // as soon as it arrived, and the tab refreshed many times a second.)
    const lead = Math.min(REFRESH_LEAD_MS, tokens.lifetimeMs / 3);
    const jitter = (internals.random() * 2 - 1) * Math.min(REFRESH_JITTER_MS, lead / 2);
    const delay = Math.max(0, tokens.expiresAt - lead + jitter - internals.now());
    refreshTimer = setTimeout(() => void refresh(), delay);
  }

  /** Shared activity: any tab's activity keeps every tab alive; every tab idles out together. */
  function lastActivity(): number {
    const v = Number(store('local')?.getItem(ACTIVITY_KEY) ?? NaN);
    return Math.max(Number.isFinite(v) ? v : 0, lastActivityWrite);
  }

  function touch(force = false): void {
    const now = internals.now();
    if (!force && now - lastActivityWrite < ACTIVITY_WRITE_MS) return; // debounced
    lastActivityWrite = now;
    try {
      store('local')?.setItem(ACTIVITY_KEY, String(now));
    } catch {
      // this tab's own activity still counts
    }
  }

  function startIdleWatch(): void {
    touch(true);
    const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    if (typeof target.addEventListener === 'function') {
      const onActivity = () => touch();
      for (const ev of ACTIVITY_EVENTS) target.addEventListener(ev, onActivity, { capture: true, passive: true });
      stopActivity = () => {
        for (const ev of ACTIVITY_EVENTS) target.removeEventListener?.(ev, onActivity, { capture: true });
      };
    }
    idleTimer = setInterval(() => {
      if (internals.now() - lastActivity() < cfg.idleTimeoutMs) return;
      rotateSessionId();
      expire({ serverEnded: false, idle: true });
    }, Math.min(IDLE_CHECK_MS, cfg.idleTimeoutMs));
  }

  /** Applies a token response; throws when it is unusable (missing fields or a bad ID token). */
  function accept(body: TokenResponse, w: Workspace, nonce: string, previous?: Tokens): Tokens {
    if (typeof body.access_token !== 'string' || body.access_token === '') throw new Error('token response has no access_token');
    const now = internals.now();
    const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 300;
    const refreshIn = typeof body.refresh_expires_in === 'number' && body.refresh_expires_in > 0 ? body.refresh_expires_in : undefined;
    let idToken = typeof body.id_token === 'string' ? body.id_token : undefined;
    let sub = previous?.sub;
    if (idToken) {
      const claims = jwtPayload(idToken);
      const problem = idTokenProblem(claims, w, nonce, previous?.sub);
      if (problem === 'device-clock') throw new DeviceClockError(internals.now() / 1000 - (claims!.iat as number));
      if (problem) throw new Error(`ID token rejected: ${problem}`);
      clockOffsetS = internals.now() / 1000 - (claims!.iat as number);
      sub = claims!.sub as string;
      user = userFrom(claims!, w.trial);
    } else if (!previous) {
      throw new Error('token response has no id_token');
    } else {
      idToken = previous.idToken;
    }
    return {
      access: body.access_token,
      idToken,
      // Keycloak rotates on every refresh; a response without one leaves the current token in place.
      refresh: typeof body.refresh_token === 'string' && body.refresh_token !== '' ? body.refresh_token : previous?.refresh,
      expiresAt: now + expiresIn * 1000,
      lifetimeMs: expiresIn * 1000,
      refreshExpiresAt: refreshIn !== undefined ? now + refreshIn * 1000 : previous?.refreshExpiresAt,
      sub: sub!,
      nonce,
    };
  }

  /** Why the ID token's claims fail OIDC Core §3.1.3.7 (signature excepted), or undefined. */
  function idTokenProblem(c: Record<string, unknown> | undefined, w: Workspace, nonce: string, sub?: string): string | undefined {
    if (!c) return 'not a JWT';
    if (c.iss !== issuer(w.realm)) return 'iss';
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(cfg.clientId)) return 'aud';
    if (c.azp !== undefined && c.azp !== cfg.clientId) return 'azp';
    // Refreshed ID tokens may omit the nonce; when present it must be the original one.
    if (c.nonce !== nonce && !(sub !== undefined && c.nonce === undefined)) return 'nonce';
    if (typeof c.iat !== 'number' || !Number.isFinite(c.iat)) return 'iat';
    // Judged on the provider's clock: iat is its time at receipt (the token just came from it).
    const offset = internals.now() / 1000 - c.iat;
    if (Math.abs(offset) > MAX_CLOCK_OFFSET_S) return 'device-clock';
    const now = c.iat;
    if (typeof c.exp !== 'number' || c.exp + SKEW_S < now) return 'exp';
    if (typeof c.sub !== 'string' || c.sub === '') return 'sub';
    if (sub !== undefined && c.sub !== sub) return 'sub changed';
    return undefined;
  }

  async function tokenRequest(realm: string, form: Record<string, string>): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
    try {
      return await fetch(endpoint(realm, 'token'), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function becomeAuthenticated(t: Tokens, w: Workspace): Settled {
    tokens = t;
    workspace = w;
    restoring = false;
    const ns = workspaceNamespace(w, user?.tenantId);
    if (w.trial && ns === 'anon') log().error('trial ID token has no valid tenant_id: storage stays anonymous', { realm: w.realm });
    getRuntime().storageNamespace = ns;
    stopTimers();
    scheduleRefresh();
    startIdleWatch();
    const s = { status: 'authenticated', user: user!, workspace: w, expiresAt: t.expiresAt } as const;
    setState(s);
    return s;
  }

  // --- redirects -----------------------------------------------------------------------------
  function runBeforeRedirect(reason: Reason): void {
    for (const l of [...redirectListeners]) {
      try {
        l({ reason });
      } catch (e) {
        log().error('beforeRedirect listener failed', { error: e, reason });
      }
    }
  }

  async function authorize(o: {
    workspace: Workspace;
    reason: Reason;
    returnUrl?: string | undefined;
    prompt?: 'none' | 'login' | undefined;
    maxAge?: number | undefined;
    loginHint?: string | undefined;
  }): Promise<void> {
    const w = o.workspace;
    if (!w || typeof w.realm !== 'string' || !REALM.test(w.realm) || typeof w.trial !== 'boolean') {
      throw new TypeError(`login needs a Workspace with a valid realm, got ${JSON.stringify(w?.realm)}`);
    }
    const now = internals.now();
    const record: PendingLogin = {
      state: randomToken(16),
      codeVerifier: randomToken(32),
      nonce: randomToken(16),
      workspace: { realm: w.realm, trial: w.trial, ...(w.slug ? { slug: w.slug } : {}), ...(w.tenantIdHint ? { tenantIdHint: w.tenantIdHint } : {}) },
      returnUrl: safeReturnUrl(o.returnUrl ?? currentUrl()),
      reason: o.reason,
      createdAt: now,
      ...(o.maxAge !== undefined ? { maxAge: o.maxAge } : {}),
    };
    const challenge = await s256(record.codeVerifier);
    purgePending(now);
    const s = store('session');
    try {
      if (!s) throw new Error('unavailable');
      s.setItem(`${PENDING_PREFIX}${record.state}`, JSON.stringify(record));
    } catch (e) {
      throw new Error('sign-in needs sessionStorage, which is unavailable', { cause: e });
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri(),
      scope: cfg.scopes.join(' '),
      state: record.state,
      nonce: record.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (o.prompt) params.set('prompt', o.prompt);
    if (o.maxAge !== undefined) params.set('max_age', String(o.maxAge));
    if (o.loginHint) params.set('login_hint', o.loginHint);
    runBeforeRedirect(o.reason);
    internals.assign(`${endpoint(w.realm, 'auth')}?${params.toString()}`);
  }

  /** One silent (prompt=none) attempt per tab: the loop guard is set first, cleared only on success. */
  async function silentRestore(w: Workspace, reason: Reason): Promise<boolean> {
    if (!flag('session', RESTORE_MARK_KEY, true)) return false; // no guard, no attempt: never risk a loop
    try {
      await authorize({ workspace: w, reason, returnUrl: currentUrl(), prompt: 'none' });
      return true;
    } catch (e) {
      log().error('silent sign-in could not start', { error: e });
      return false;
    }
  }

  /**
   * The refresh outcome was ambiguous: the token may have rotated. Drop the lineage and start a new one,
   * after `deferMs` when given (a page that is navigating away never gets there).
   */
  function restoreLineage(deferMs = 0): void {
    const w = workspace;
    dropTokens();
    if (!w) return;
    restoring = true;
    const go = () => {
      if (!restoring) return; // a logout or switch got there first
      void silentRestore(w, 'restore').then((started) => {
        if (!started) expire({ serverEnded: false, idle: false });
      });
    };
    // Offline, the redirect would land on the browser's error page: wait for the network.
    const whenOnline = () => {
      if (!restoring) return;
      if (isOnline()) {
        go();
        return;
      }
      stopOnline = subscribeOnline((online) => {
        if (!online) return;
        stopOnline?.();
        stopOnline = undefined;
        go();
      });
    };
    if (deferMs > 0) setTimeout(whenOnline, deferMs);
    else whenOnline();
  }

  // --- refresh -------------------------------------------------------------------------------
  /**
   * Notes whether the page starts leaving (beforeunload, pagehide) until stop(). Listening only while a
   * request is in flight: a standing beforeunload listener keeps Firefox from keeping the page in its
   * back/forward cache.
   */
  function watchLeaving(): { started(): boolean; stop(): void } {
    const target = globalThis as { addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener };
    let left = false;
    const onLeave = () => {
      left = true;
    };
    target.addEventListener?.('beforeunload', onLeave);
    target.addEventListener?.('pagehide', onLeave);
    return {
      started: () => left,
      stop: () => {
        target.removeEventListener?.('beforeunload', onLeave);
        target.removeEventListener?.('pagehide', onLeave);
      },
    };
  }

  async function doRefresh(): Promise<boolean> {
    const t = tokens;
    const w = workspace;
    if (!t || !w || restoring || state.status !== 'authenticated' || !t.refresh) return false;
    if (t.refreshExpiresAt !== undefined && internals.now() >= t.refreshExpiresAt) {
      expire({ serverEnded: false, idle: false });
      return false;
    }
    if (!isOnline()) {
      // Failed before sending: the token was never used, so keep it and try again once online.
      stopOnline?.();
      stopOnline = subscribeOnline((online) => {
        if (!online) return;
        stopOnline?.();
        stopOnline = undefined;
        void refresh();
      });
      return false;
    }
    let res: Response;
    let body: TokenResponse;
    const leaving = watchLeaving();
    try {
      res = await tokenRequest(w.realm, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: cfg.clientId });
      body = (await res.json().catch(() => ({}))) as TokenResponse;
    } catch (e) {
      if (tokens !== t) return false;
      if (leaving.started()) {
        // The browser cancelled the request because the page is navigating away (WebKit does so as the
        // navigation starts). Restoring now would send this page to the IdP and replace the user's
        // navigation; the next page restores its own session. Only a page that stays restores.
        log().info('token refresh cancelled by a navigation away', { error: e });
        restoreLineage(LEAVING_GRACE_MS);
        return false;
      }
      log().warn('token refresh outcome unknown: restoring the session', { error: e, essential: true });
      restoreLineage();
      return false;
    } finally {
      leaving.stop();
    }
    if (tokens !== t) return false; // logged out or switched meanwhile: discard the answer
    if (res.ok) {
      try {
        tokens = accept(body, w, t.nonce, t);
      } catch (e) {
        log().error('token refresh answer rejected: restoring the session', { error: e });
        restoreLineage();
        return false;
      }
      unavailableRetries = 0;
      scheduleRefresh();
      setState({ status: 'authenticated', user: user!, workspace: w, expiresAt: tokens.expiresAt });
      return true;
    }
    if (body?.error === 'invalid_grant') {
      const serverEnded = t.refreshExpiresAt !== undefined && internals.now() < t.refreshExpiresAt;
      // Keycloak ending a live session (revocation, conversion, reuse detection) is operational and
      // essential; a refresh token simply past its lifetime is routine and needs consent.
      if (serverEnded) log().warn('session ended', { server_ended: true, essential: true });
      else log().info('session ended', { server_ended: false });
      expire({ serverEnded, idle: false });
      return false;
    }
    if (refusedUnprocessed(res)) {
      // Every tab of every user would otherwise drop its tokens and redirect to an IdP that is down.
      const backoff = Math.min(REFRESH_RETRY_MAX_MS, REFRESH_RETRY_MS * 2 ** unavailableRetries) * (0.5 + internals.random() / 2);
      const wait = Math.max(backoff, retryAfterMs(res, REFRESH_RETRY_MAX_MS) ?? 0);
      // The retry must answer before getAccessToken stops handing the token out.
      if (internals.now() + wait < t.expiresAt - ACCESS_TOKEN_LEAD_MS) {
        unavailableRetries++;
        log().warn('token endpoint unavailable: retrying the refresh', { status: res.status, retry_in_ms: Math.round(wait), essential: true });
        // Waited inside this refresh, so getAccessToken and a 401 meanwhile join it (single-flight) and get
        // the retry's answer, instead of sending more requests or failing at once.
        await new Promise((resolve) => setTimeout(resolve, wait));
        if (tokens !== t) return false; // logged out or switched meanwhile
        return doRefresh();
      }
    }
    log().warn('token refresh failed: restoring the session', { status: res.status, error_code: typeof body?.error === 'string' ? body.error : undefined, essential: true });
    restoreLineage();
    return false;
  }

  function refresh(): Promise<boolean> {
    inflight ??= doRefresh()
      .catch((e: unknown) => {
        log().error('token refresh failed', { error: e });
        return false;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  /** Seconds since the signed-in user authenticated, on the provider's clock; Infinity without auth_time. */
  function authAgeS(): number {
    const authTime = state.status === 'authenticated' ? state.user.authTime : undefined;
    return authTime === undefined ? Number.POSITIVE_INFINITY : internals.now() / 1000 - clockOffsetS - authTime;
  }

  // --- init ----------------------------------------------------------------------------------
  async function handleCallback(params: URLSearchParams): Promise<Settled | undefined> {
    const now = internals.now();
    const record = takePending(params.get('state'), now);
    purgePending(now);
    if (!record) {
      log().warn('sign-in callback ignored: unknown or expired state', { essential: true });
      replaceUrl('/');
      return undefined; // the restore path continues as if there were no callback
    }
    replaceUrl(safeReturnUrl(record.returnUrl));
    const w = record.workspace;
    const anonymous = (reason: 'none' | 'login-required' | 'device-clock'): Settled => {
      const s = { status: 'anonymous', reason, ...(reason === 'login-required' ? { workspace: w } : {}) } as const;
      setState(s);
      return s;
    };
    if (params.get('iss') !== issuer(w.realm)) {
      log().error('sign-in callback rejected: iss does not match the realm', { realm: w.realm });
      return anonymous('none');
    }
    const error = params.get('error');
    if (error !== null) {
      if (SILENT_ERRORS.has(error) && record.reason === 'restore') return anonymous('login-required');
      log().warn('sign-in failed', { error_code: error.slice(0, 64), reason: record.reason, essential: true });
      return anonymous('none');
    }
    const code = params.get('code');
    if (!code) return anonymous('none');
    try {
      const res = await tokenRequest(w.realm, {
        grant_type: 'authorization_code',
        code,
        code_verifier: record.codeVerifier,
        redirect_uri: redirectUri(),
        client_id: cfg.clientId,
      });
      const body = (await res.json().catch(() => ({}))) as TokenResponse;
      if (!res.ok) throw new Error(`token endpoint answered ${res.status} ${typeof body?.error === 'string' ? body.error : ''}`.trim());
      const t = accept(body, w, record.nonce);
      if (signedOutElsewhere) {
        log().info('sign-in dropped: another tab signed out meanwhile');
        return anonymous('none');
      }
      await forgetPreviousUser(w.realm, t.sub);
      flag('session', RESTORE_MARK_KEY, false);
      flag('local', SIGNED_OUT_KEY, false);
      const settled = becomeAuthenticated(t, w);
      // An IdP that ignored prompt=login / max_age (a misconfiguration, a proxy) returns the old session:
      // signed in, but not re-authenticated. Reported, so a step-up loop has a cause in the logs.
      if (typeof record.maxAge === 'number' && authAgeS() > record.maxAge + STEP_UP_SKEW_S) {
        log().warn('step-up not performed by the identity provider: auth_time is older than max_age', { max_age: record.maxAge, essential: true });
      }
      return settled;
    } catch (e) {
      tokens = undefined;
      user = undefined;
      if (e instanceof DeviceClockError) {
        log().error('sign-in callback rejected: the device clock is off', { clock_offset_s: Math.round(e.offsetSeconds) });
        return anonymous('device-clock');
      }
      log().error('sign-in callback rejected', { error: e });
      return anonymous('none');
    }
  }

  async function runInit(): Promise<Settled> {
    const loc = globalThis.location;
    if (loc) {
      const url = new URL(loc.href);
      const p = url.searchParams;
      if (url.pathname === cfg.redirectPath && (p.has('code') || p.has('error'))) {
        const settled = await handleCallback(p);
        if (settled) return settled;
      } else {
        purgePending(internals.now());
      }
    }
    const signedOut = flag('local', SIGNED_OUT_KEY);
    const anonymous = (): Settled => {
      const s = { status: 'anonymous', reason: signedOut ? 'signed-out' : 'none' } as const;
      setState(s);
      return s;
    };
    if (signedOut || flag('session', RESTORE_MARK_KEY) || !loc) return anonymous();
    const slug = slugFromPath(loc.pathname, cfg);
    // A slug with no cache entry skips the restore: never another cached workspace under this URL.
    const w = slug !== undefined ? cachedWorkspace(slug) : cachedWorkspace();
    if (!w || !(await silentRestore(w, 'restore'))) return anonymous();
    return new Promise<never>(() => {}); // the page is leaving for Keycloak
  }

  // --- the provider --------------------------------------------------------------------------
  return {
    init() {
      initPromise ??= runInit();
      return initPromise;
    },

    login(o) {
      // After a local logout Keycloak's SSO session is still alive: on a shared device the next "Sign in"
      // would silently be the previous user, so credentials are asked for until a sign-in succeeds.
      const prompt = o.prompt ?? (flag('local', SIGNED_OUT_KEY) ? 'login' : undefined);
      return authorize({ workspace: o.workspace, reason: 'login', returnUrl: o.returnUrl, prompt, loginHint: o.loginHint });
    },

    async logout(o) {
      const idToken = tokens?.idToken;
      const w = workspace;
      restoring = false;
      dropTokens();
      clearAllAppStorage();
      rotateSessionId();
      flag('local', SIGNED_OUT_KEY, true);
      broadcast('logout');
      getRuntime().storageNamespace = 'anon';
      setState({ status: 'anonymous', ...(w ? { workspace: w } : {}), reason: 'signed-out' });
      // Global by default (report Issue 10): a local logout leaves the provider's SSO session alive, and on a
      // shared device the next person's sign-in then shows the previous user. { global: false } opts out.
      if (o?.global === false || !w) return;
      // POSTed (OIDC RP-Initiated Logout §2): the ID token, with the user's name and email, never goes in a URL.
      internals.post(endpoint(w.realm, 'logout'), {
        ...(idToken ? { id_token_hint: idToken } : {}),
        client_id: cfg.clientId,
        post_logout_redirect_uri: `${globalThis.location?.origin ?? ''}/`,
      });
    },

    async getAccessToken() {
      if (!tokens || restoring) return undefined;
      // Expired (or about to): join the tab's single refresh rather than send a dead token.
      if (internals.now() >= tokens.expiresAt - ACCESS_TOKEN_LEAD_MS) await refresh();
      return restoring ? undefined : tokens?.access;
    },

    refresh,

    async switchWorkspace(w) {
      restoring = false;
      dropTokens(); // old-realm tokens are discarded, never exchanged
      clearAllAppStorage();
      rotateSessionId();
      broadcast('workspace-switched');
      getRuntime().storageNamespace = 'anon';
      await authorize({ workspace: w, reason: 'switch' });
    },

    async reauthenticate(o) {
      if (state.status !== 'authenticated' || !workspace) throw new Error('reauthenticate needs a signed-in session');
      if (!Number.isInteger(o?.maxAgeSeconds) || o.maxAgeSeconds < 0) throw new TypeError('maxAgeSeconds must be a non-negative integer');
      await authorize({ workspace, reason: 'step-up', returnUrl: o.returnUrl, prompt: 'login', maxAge: o.maxAgeSeconds });
    },

    needsStepUp(maxAgeSeconds) {
      const authTime = state.status === 'authenticated' ? state.user.authTime : undefined;
      if (authTime === undefined || typeof maxAgeSeconds !== 'number' || !Number.isFinite(maxAgeSeconds)) return false;
      return internals.now() / 1000 - clockOffsetS - authTime > maxAgeSeconds; // on the provider's clock
    },

    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    beforeRedirect(l) {
      redirectListeners.add(l);
      return () => redirectListeners.delete(l);
    },

    getState: () => state,

    dispose() {
      restoring = false;
      dropTokens();
      inflight = undefined;
      listeners.clear();
      redirectListeners.clear();
      try {
        channel?.close();
      } catch {
        // already closed
      }
      channel = undefined;
    },
  };
}
