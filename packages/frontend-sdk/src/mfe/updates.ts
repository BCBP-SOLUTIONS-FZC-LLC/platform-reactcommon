// New deployments (design doc §C1 /mfe, §C3): chunk-load errors after a deploy reload the page
// once per version, and /version.json polling tells the shell an update is available.
import { getIdentity } from '../core/index.ts';
import { tryGetConfig } from '../config/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { RemoteLoadError } from './remote.ts';

const RELOAD_GUARD_KEY = '@platform/frontend-sdk:chunk-reload';
const CHUNK_ERROR = /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

interface UpdateState {
  current: string | undefined;
  available: string | undefined;
  listeners: Set<(u: { current: string; available: string }) => void>;
}

function state(): UpdateState {
  const rt = getRuntime();
  rt.appUpdate ??= { current: undefined, available: undefined, listeners: new Set() } satisfies UpdateState;
  return rt.appUpdate as UpdateState;
}

/** The running build's version: the identity's buildVersion, else the first /version.json seen. */
function currentVersion(): string {
  const s = state();
  if (s.current) return s.current;
  const build = getIdentity()?.buildVersion;
  return build && build !== 'unknown' ? build : 'unknown';
}

/**
 * Whether `e` is a failed chunk load: webpack's ChunkLoadError, a failed dynamic import, or a
 * remote that failed because of one. Typically the old build's files are gone after a deploy.
 */
export function isChunkLoadError(e: unknown): boolean {
  if (e instanceof RemoteLoadError) return isChunkLoadError(e.cause);
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { name?: unknown; message?: unknown };
  return err.name === 'ChunkLoadError' || (typeof err.message === 'string' && CHUNK_ERROR.test(err.message));
}

/**
 * Reloads the page if `e` is a chunk-load error and no reload for this version happened yet in
 * this tab (sessionStorage guard keyed by the version), so a broken deploy cannot loop. Returns
 * whether it reloaded.
 */
export function reloadOnceForChunkError(e: unknown): boolean {
  if (!isChunkLoadError(e)) return false;
  const version = state().available ?? currentVersion();
  let store: Storage | undefined;
  try {
    store = globalThis.sessionStorage ?? undefined;
  } catch {
    store = undefined;
  }
  try {
    if (store?.getItem(RELOAD_GUARD_KEY) === version) return false;
    store?.setItem(RELOAD_GUARD_KEY, version);
  } catch {
    return false; // without a guard, never risk a reload loop
  }
  if (!store) return false;
  globalThis.location?.reload();
  return true;
}

/** Calls `l` once a newer version than the running one is deployed (immediately if already known). */
export function subscribeAppUpdate(l: (u: { current: string; available: string }) => void): () => void {
  const s = state();
  s.listeners.add(l);
  if (s.available) l({ current: currentVersion(), available: s.available });
  return () => s.listeners.delete(l);
}

async function check(url: string): Promise<void> {
  if (globalThis.document?.visibilityState === 'hidden') return;
  let version: unknown;
  try {
    const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (!res.ok) return;
    version = ((await res.json()) as { version?: unknown })?.version;
  } catch {
    return; // offline or mid-deploy: try again next time
  }
  if (typeof version !== 'string' || version === '') return;
  const s = state();
  if (currentVersion() === 'unknown') {
    s.current = version;
    return;
  }
  if (version === currentVersion() || version === s.available) return;
  s.available = version;
  const update = { current: currentVersion(), available: version };
  for (const l of [...s.listeners]) {
    try {
      l(update);
    } catch {
      // one listener's failure never stops the others
    }
  }
}

/**
 * Shell only: polls /version.json ({ "version": "…" }, written last by the deploy) every
 * `intervalMs` (default the config's appUpdate.pollIntervalMs) and when the page becomes visible,
 * and notifies subscribeAppUpdate listeners of a newer version. Returns a stop function.
 */
export function startVersionPolling(o?: { url?: string; intervalMs?: number }): () => void {
  const url = o?.url ?? '/version.json';
  const interval = o?.intervalMs ?? tryGetConfig()?.appUpdate.pollIntervalMs ?? 300_000;
  void check(url);
  const timer = setInterval(() => void check(url), interval);
  const onVisible = () => {
    if (globalThis.document?.visibilityState === 'visible') void check(url);
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisible);
  return () => {
    clearInterval(timer);
    globalThis.document?.removeEventListener?.('visibilitychange', onVisible);
  };
}
