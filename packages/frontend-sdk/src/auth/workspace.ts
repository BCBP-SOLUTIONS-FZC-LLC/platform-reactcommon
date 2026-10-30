// Choosing the realm before login and caching it after (design doc §C1 /auth, "Choosing the realm").
// The cache is an SDK-reserved localStorage key outside /storage namespaces, so clearAllAppStorage()
// keeps it: it holds only slug, realm and the trial flag, which the next login needs.
import { tryGetConfig, type RuntimeConfig } from '../config/index.ts';
import { getLogger } from '../logging/index.ts';
import type { SessionUser, Workspace, WorkspaceResolver } from './types.ts';

type CachedWorkspace = Workspace & { readonly slug: string };

export const WORKSPACE_CACHE_KEY = '@platform/frontend-sdk:workspaces';
const MAX_CACHED = 20;
const SLUG = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const MAX_SLUG = 63;

function isSlug(v: unknown): v is string {
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
function readCache(): CachedWorkspace[] {
  let raw: unknown;
  try {
    raw = JSON.parse(localStore()?.getItem(WORKSPACE_CACHE_KEY) ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e: unknown) => {
    const { slug, realm, trial } = (e ?? {}) as Record<string, unknown>;
    return isSlug(slug) && typeof realm === 'string' && realm !== '' && typeof trial === 'boolean' ? [{ slug, realm, trial }] : [];
  });
}

function writeCache(w: CachedWorkspace): void {
  const entry = { slug: w.slug, realm: w.realm, trial: w.trial }; // never the tenantIdHint
  const next = [entry, ...readCache().filter((e) => e.slug !== w.slug)].slice(0, MAX_CACHED);
  try {
    localStore()?.setItem(WORKSPACE_CACHE_KEY, JSON.stringify(next));
  } catch {
    // no cache: the next visit asks PUB-1 or the user again
  }
}

/** Cached Workspace for `slug` (or the most recent one when omitted). Keyed by slug; every cached entry has one. */
export function cachedWorkspace(slug?: string): (Workspace & { slug: string }) | undefined {
  const cache = readCache();
  return slug === undefined ? cache[0] : cache.find((e) => e.slug === slug);
}

/**
 * Shell only, after sign-in: caches the signed-in Workspace with its slug (paid: from the realm; trial:
 * SessionContext.slug) and replaces the URL with `/t/<slug>/…` when it has no slug. A slug that does not
 * fit the realm is logged and not cached.
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
  if (!loc || slugFromPath(loc.pathname, cfg) !== undefined) return;
  const path = `${cfg.workspacePathPrefix}${w.slug}${loc.pathname.startsWith('/') ? loc.pathname : `/${loc.pathname}`}`;
  globalThis.history?.replaceState(globalThis.history.state, '', `${path}${loc.search}${loc.hash}`);
}

/**
 * Realm choice before login: slug from path → cached Workspace for it, else resolver.resolve(slug) (cached
 * when its realm fits the slug); no slug in path → the most recent cached Workspace. undefined → the
 * identifier-first screen. `forceResolve` skips the cache (a session the server ended early); if PUB-1 then
 * fails or answers nonsense, the cached entry is still used.
 */
export async function chooseWorkspace(o: {
  pathname: string;
  resolver: WorkspaceResolver;
  cfg: RuntimeConfig['auth'];
  forceResolve?: boolean;
  signal?: AbortSignal;
}): Promise<Workspace | undefined> {
  const slug = slugFromPath(o.pathname, o.cfg);
  if (slug === undefined) return cachedWorkspace();
  const cached = cachedWorkspace(slug);
  if (cached && !o.forceResolve) return cached;
  let resolved: Workspace | undefined;
  try {
    resolved = await o.resolver.resolve(slug, o.signal);
  } catch (e) {
    if (o.signal?.aborted) throw e;
    getLogger().warn('workspace resolve failed', { slug, error: e, cached: cached !== undefined });
    return cached;
  }
  if (!resolved) return undefined; // not found: the identifier screen, even when an old entry is cached
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
