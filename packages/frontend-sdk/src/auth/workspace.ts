// Choosing the realm before login and caching it after (design doc §C1 /auth, "Choosing the realm").
// The cache is an SDK-reserved localStorage key outside /storage namespaces, so clearAllAppStorage()
// keeps it: it holds only slug, realm and the trial flag, which the next login needs.
import { tryGetConfig, type RuntimeConfig } from '../config/index.ts';
import { getLogger } from '../logging/index.ts';
import type { SessionUser, Workspace, WorkspaceResolver } from './types.ts';

type CachedWorkspace = Workspace & { readonly slug: string };
type CacheEntry = { readonly slug: string; readonly realm: string; readonly trial: boolean };

export const WORKSPACE_CACHE_KEY = '@bcbp-solutions-fzc-llc/frontend-sdk:workspaces';
const MAX_CACHED = 20;
const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_SLUG = 63;
const REALM = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A workspace slug: lowercase words joined by '-', at most 63 characters. */
export function isSlug(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_SLUG && SLUG.test(v);
}

/** Whether `realm` is the one a workspace with `slug` must have: `${paidRealmPrefix}${slug}`, or trialRealm. */
export function realmMatches(w: { realm: string; trial: boolean }, slug: string, cfg: RuntimeConfig['auth']): boolean {
  return w.trial ? w.realm === cfg.trialRealm : w.realm === `${cfg.paidRealmPrefix}${slug}`;
}

/** `/t/<slug>/…` → '<slug>'; anything else → undefined. Pure. A slug does NOT say whether the tenant is paid or trial. */
export function slugFromPath(pathname: string, cfg: RuntimeConfig['auth']): string | undefined {
  if (typeof pathname !== 'string' || !pathname.startsWith(cfg.workspacePathPrefix)) return undefined;
  const segment = pathname.slice(cfg.workspacePathPrefix.length).split('/')[0];
  return isSlug(segment) ? segment : undefined;
}

function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** The cache, most recent first; malformed entries are skipped. */
function readCache(): CacheEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStore()?.getItem(WORKSPACE_CACHE_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  // An entry written by another version or by other code must still fit its slug (the realm decides the
  // login URL): without the config, only the realm's shape is checked.
  const cfg = tryGetConfig()?.auth;
  return raw.flatMap((e: unknown) => {
    const { slug, realm, trial } = (e ?? {}) as Record<string, unknown>;
    if (!isSlug(slug) || typeof realm !== 'string' || !REALM.test(realm) || typeof trial !== 'boolean') return [];
    return !cfg || realmMatches({ realm, trial }, slug, cfg) ? [{ slug, realm, trial }] : [];
  });
}

function writeCache(w: CachedWorkspace): void {
  const entry: CacheEntry = { slug: w.slug, realm: w.realm, trial: w.trial }; // never the tenantIdHint
  const next = [entry, ...readCache().filter((e) => e.slug !== w.slug)].slice(0, MAX_CACHED);
  try {
    localStore()?.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(next));
  } catch {
    // no cache: the next visit asks PUB-1 or the user again
  }
}

/** Drops `slug`'s entry only while it still names `realm`: another tab may have cached a newer answer. */
function dropCache(slug: string, realm: string): void {
  try {
    localStore()?.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(readCache().filter((e) => e.slug !== slug || e.realm !== realm)));
  } catch {
    // the stale entry stays: the next visit asks PUB-1 again
  }
}

/** Cached Workspace for `slug` (or the most recent one when omitted). Keyed by slug; every cached entry has one. */
export function cachedWorkspace(slug?: string): (Workspace & { slug: string }) | undefined {
  const cache = readCache();
  const e = slug === undefined ? cache[0] : cache.find((c) => c.slug === slug);
  return e ? { slug: e.slug, realm: e.realm, trial: e.trial } : undefined;
}

/**
 * Shell only, after sign-in: caches the signed-in Workspace with its slug (paid: from the realm; trial:
 * SessionContext.slug) and puts it in the URL: `/t/<slug>/…` when the URL has no slug, and in place of another
 * slug (the user signed in to another workspace than the URL named, e.g. after "not found"), so the next
 * load restores this workspace; a `popstate` event then tells a mounted router. A slug that does not fit the realm is logged and not cached.
 */
export function rememberWorkspace(w: Workspace & { slug: string }): void {
  const cfg = tryGetConfig()?.auth;
  if (!cfg) throw new Error('rememberWorkspace: call setRuntimeConfig first');
  if (!w || !isSlug(w.slug) || typeof w.realm !== 'string' || typeof w.trial !== 'boolean' || !realmMatches(w, w.slug, cfg)) {
    getLogger().error('workspace not cached: slug and realm do not match', { realm: w?.realm, slug: w?.slug, trial: w?.trial });
    return;
  }
  writeCache(w);
  const loc = globalThis.location;
  if (!loc) return;
  const urlSlug = slugFromPath(loc.pathname, cfg);
  if (urlSlug === w.slug) return;
  const rest = urlSlug === undefined ? loc.pathname : loc.pathname.slice(`${cfg.workspacePathPrefix}${urlSlug}`.length) || '/';
  const path = `${cfg.workspacePathPrefix}${w.slug}${rest.startsWith('/') ? rest : `/${rest}`}`;
  globalThis.history?.replaceState(globalThis.history.state, '', `${path}${loc.search}${loc.hash}`);
  // Replacing another slug changes the route: a router already mounted (the shell's session-context retry)
  // re-reads the location on popstate. Adding a missing slug leaves the route as it was, so no event.
  if (urlSlug !== undefined && typeof globalThis.dispatchEvent === 'function' && typeof PopStateEvent === 'function') {
    globalThis.dispatchEvent(new PopStateEvent('popstate', { state: globalThis.history?.state }));
  }
}

/**
 * Realm choice before login: slug from path → cached Workspace for it, else resolver.resolve(slug) (cached
 * when its realm fits the slug); no slug in path → the most recent cached Workspace. undefined → the
 * identifier-first screen (with no slug in the URL, a most recent entry PUB-1 no longer knows is dropped and
 * the next one is tried). A cached **trial** entry is always re-checked with PUB-1: a trial → paid
 * conversion moves the tenant and its users to `tenant-<slug>`, and the trial realm's sign-in page can then
 * only refuse them (one PUB-1 call per trial sign-in). `forceResolve` also
 * re-checks a paid entry for the URL's slug (a session the server ended early). If PUB-1 then fails or
 * answers nonsense, the cached entry is still used.
 */
export async function chooseWorkspace(o: {
  pathname: string;
  resolver: WorkspaceResolver;
  cfg: RuntimeConfig['auth'];
  forceResolve?: boolean;
  signal?: AbortSignal;
}): Promise<Workspace | undefined> {
  const pathSlug = slugFromPath(o.pathname, o.cfg);
  const cached = pathSlug === undefined ? cachedWorkspace() : cachedWorkspace(pathSlug);
  const slug = pathSlug ?? cached?.slug;
  if (slug === undefined) return undefined;
  // A paid realm never changes; forceResolve re-checks it only for the URL's own slug.
  if (cached && !cached.trial && (!o.forceResolve || pathSlug === undefined)) return cached;
  const w = await resolveSlug({ slug, cached, resolver: o.resolver, cfg: o.cfg, signal: o.signal });
  // No slug in the URL and the most recent entry is gone (not found, now dropped): the next cached one.
  // Only when the drop took effect, so a cache that cannot be written ends here instead of looping.
  if (w === undefined && pathSlug === undefined && cachedWorkspace()?.slug !== slug) return chooseWorkspace(o);
  return w;
}

/** How long a re-check of a cached entry may wait on PUB-1 before the cached entry is used. */
export const RECHECK_TIMEOUT_MS = 5_000;

/**
 * PUB-1 for `slug`; the answer is cached when its realm fits the slug. Not found → undefined (and the cached
 * entry is dropped); PUB-1 down or a realm that does not fit → `cached`. With a `cached` entry to fall back
 * on, the call is bounded by RECHECK_TIMEOUT_MS (raced as well as aborted, so a resolver that ignores the
 * signal cannot hold sign-in either). A caller's abort is passed through. Internal: also used by the provider
 * for a trial `login-required`.
 */
export async function resolveSlug(o: {
  slug: string;
  cached: Workspace | undefined;
  resolver: WorkspaceResolver;
  cfg: RuntimeConfig['auth'];
  signal?: AbortSignal | undefined;
}): Promise<Workspace | undefined> {
  const outer = o.signal;
  const ctrl = new AbortController();
  let unlisten = () => {};
  // The caller's abort settles the call at once, even when the resolver ignores the signal.
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => {
      ctrl.abort(outer?.reason);
      reject(outer?.reason);
    };
    if (outer?.aborted) onAbort();
    else if (outer) {
      outer.addEventListener('abort', onAbort, { once: true });
      unlisten = () => outer.removeEventListener('abort', onAbort);
    }
  });
  aborted.catch(() => {}); // settled by the race or never
  let timer: ReturnType<typeof setTimeout> | undefined;
  const racers: Promise<Workspace | undefined | typeof TIMED_OUT>[] = [lookup({ ...o, signal: ctrl.signal }), aborted];
  if (o.cached !== undefined) {
    // A cached entry to fall back on: bounded. Without one, the answer is awaited.
    racers.push(
      new Promise((settle) => {
        timer = setTimeout(() => {
          ctrl.abort(new Error('workspace re-check timed out'));
          settle(TIMED_OUT);
        }, RECHECK_TIMEOUT_MS);
      }),
    );
  }
  try {
    const r = await Promise.race(racers);
    if (outer?.aborted) throw outer.reason; // the caller's abort wins, whatever the resolver did
    if (r !== TIMED_OUT) return r;
  } catch (e) {
    if (outer?.aborted || !ctrl.signal.aborted) throw e; // the caller's abort, or a real error: never hidden
  } finally {
    clearTimeout(timer);
    unlisten();
  }
  getLogger().warn('workspace re-check timed out', { slug: o.slug, essential: true });
  return o.cached;
}

const TIMED_OUT = Symbol('timed out');

async function lookup(o: {
  slug: string;
  cached: Workspace | undefined;
  resolver: WorkspaceResolver;
  cfg: RuntimeConfig['auth'];
  signal?: AbortSignal | undefined;
}): Promise<Workspace | undefined> {
  const { slug, cached } = o;
  let resolved: Workspace | undefined;
  try {
    resolved = await o.resolver.resolve(slug, o.signal);
  } catch (e) {
    if (o.signal?.aborted) throw e;
    getLogger().warn('workspace resolve failed', { slug, error: e, cached: cached !== undefined, essential: true });
    return cached;
  }
  // An answer after an abort (a resolver that ignored the signal) is dropped, never cached: a timed-out
  // re-check has already gone ahead with the cached entry, and a caller's abort must reach the caller.
  if (o.signal?.aborted) throw o.signal.reason;
  if (!resolved) {
    // Not found: the identifier screen, even when an old entry is cached. The entry is dropped, so a deleted
    // tenant does not cost a silent restore and PUB-1 calls on every visit.
    if (cached) dropCache(slug, cached.realm);
    return undefined;
  }
  if (typeof resolved.realm !== 'string' || typeof resolved.trial !== 'boolean' || !realmMatches(resolved, slug, o.cfg)) {
    getLogger().error('workspace resolve rejected: realm does not fit the slug', { slug, realm: resolved.realm, trial: resolved.trial });
    return cached;
  }
  const w: CachedWorkspace = {
    realm: resolved.realm,
    trial: resolved.trial,
    slug,
    ...(resolved.trial && typeof resolved.tenantIdHint === 'string' ? { tenantIdHint: resolved.tenantIdHint } : {}),
  };
  writeCache(w);
  return w;
}

/**
 * Wrong-workspace check: true when `w` is a trial Workspace with a `tenantIdHint` and the token's
 * `tenant_id` differs. False without a hint. The shell must not call rememberWorkspace() when it is true. Pure.
 */
export function isWrongWorkspace(w: Workspace, user: SessionUser): boolean {
  if (!w?.trial || typeof w.tenantIdHint !== 'string' || w.tenantIdHint === '') return false;
  return typeof user?.tenantId !== 'string' || user.tenantId.toLowerCase() !== w.tenantIdHint.toLowerCase();
}
