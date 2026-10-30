/**
 * Per-workspace browser storage for shell and remote code. Keys are namespaced by workspace (so
 * one tenant never reads another's data on a shared browser) and by app; token-like keys are
 * refused. Design contract: docs/design/frontend-sdk-design.md §C1 `/storage`.
 *
 * @packageDocumentation
 */
import { getIdentity, isSensitiveKey } from '../core/index.ts';
import { getRuntime } from '../internal/runtime.ts';

/** A key-value store scoped to the current workspace and one app. Values are JSON. */
export interface AppStorage {
  /** The value, or undefined when absent or not valid JSON. */
  get<T>(key: string): T | undefined;
  /** Stores `v` as JSON (undefined removes the key). A no-op, with a dev warning, before sign-in ('anon'). */
  set(key: string, v: unknown): void;
  remove(key: string): void;
  /** Removes every key of this app in this workspace and area. */
  clear(): void;
}

/** A key that looks like a credential (token, password, session, *_key …): never stored. */
export class ForbiddenStorageKeyError extends Error {
  override readonly name = 'ForbiddenStorageKeyError';
}

const ANON = 'anon';
const APP_ID = /^[a-z][a-z0-9_-]{0,62}$/;
const REALM = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Keys this module writes: `<ns>:<appId>:<key>`, ns being anon, a realm or trial:<uuid>. */
const SDK_KEY = /^(?:anon|[a-z0-9][a-z0-9-]{0,62}|trial:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):[a-z][a-z0-9_-]{0,62}:/;

type Area = 'local' | 'session';
// Used when the browser's storage is unavailable or full: keeps values for this page only.
const memory: Record<Area, Map<string, string>> = { local: new Map(), session: new Map() };
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  const env = getIdentity()?.environment;
  if (env === undefined || env === 'local' || env === 'dev') console.warn(`@platform/frontend-sdk/storage: ${message}`);
}

function browserStorage(area: Area): Storage | undefined {
  try {
    return (area === 'local' ? globalThis.localStorage : globalThis.sessionStorage) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The namespace of a workspace: its realm for a paid workspace (one realm is one tenant);
 * `trial:<tenant_id>` in the shared trial realm (the realm alone would mix tenants); 'anon' when
 * there is no session or the trial token has no valid tenant_id. /auth sets it at login.
 */
export function workspaceNamespace(w: { realm: string; trial: boolean }, trialTenantId?: string): string {
  if (!w || typeof w.realm !== 'string') return ANON;
  if (w.trial) return typeof trialTenantId === 'string' && UUID.test(trialTenantId) ? `trial:${trialTenantId.toLowerCase()}` : ANON;
  return REALM.test(w.realm) ? w.realm : ANON;
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key === '' || /\p{Cc}/u.test(key)) throw new TypeError(`storage key must be a non-empty string without control characters`);
  if (isSensitiveKey(key)) throw new ForbiddenStorageKeyError(`storage key ${JSON.stringify(key)} looks like a credential; credentials are never stored`);
}

/** Storage for `appId` (the remote's name, or 'shell') in the current workspace. */
export function storage(appId: string, o?: { area?: Area }): AppStorage {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new TypeError(`appId must match ${APP_ID.source}, got ${JSON.stringify(appId)}`);
  const area: Area = o?.area === 'session' ? 'session' : 'local';
  const ns = () => getRuntime().storageNamespace;
  const fullKey = (key: string) => `${ns()}:${appId}:${key}`;

  const read = (k: string): string | null => {
    const s = browserStorage(area);
    try {
      const v = s?.getItem(k);
      if (v !== null && v !== undefined) return v;
    } catch {
      // fall through to the in-page copy
    }
    return memory[area].get(k) ?? null;
  };
  const remove = (k: string) => {
    memory[area].delete(k);
    try {
      browserStorage(area)?.removeItem(k);
    } catch {
      // nothing stored there
    }
  };

  return {
    get<T>(key: string): T | undefined {
      checkKey(key);
      const raw = read(fullKey(key));
      if (raw === null) return undefined;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return undefined;
      }
    },
    set(key: string, v: unknown): void {
      checkKey(key);
      if (ns() === ANON) {
        warnOnce(`anon:${appId}`, `set("${key}") ignored: no workspace is signed in, and nothing is written that a later tenant could read`);
        return;
      }
      if (v === undefined) {
        remove(fullKey(key));
        return;
      }
      let text: string;
      try {
        text = JSON.stringify(v);
      } catch (e) {
        throw new TypeError(`storage value for ${JSON.stringify(key)} is not JSON-serialisable`, { cause: e });
      }
      const k = fullKey(key);
      try {
        const s = browserStorage(area);
        if (!s) throw new Error('unavailable');
        s.setItem(k, text);
        memory[area].delete(k);
      } catch {
        memory[area].set(k, text);
        warnOnce(`write:${area}`, `${area}Storage is unavailable or full; values are kept for this page only`);
      }
    },
    remove(key: string): void {
      checkKey(key);
      remove(fullKey(key));
    },
    clear(): void {
      const prefix = `${ns()}:${appId}:`;
      for (const k of [...memory[area].keys()]) if (k.startsWith(prefix)) memory[area].delete(k);
      const s = browserStorage(area);
      try {
        if (!s) return;
        for (let i = s.length - 1; i >= 0; i--) {
          const k = s.key(i);
          if (k?.startsWith(prefix)) s.removeItem(k);
        }
      } catch {
        // nothing to clear
      }
    },
  };
}

/**
 * Removes every key this module wrote, in every workspace and app, in both areas. Called on
 * logout and workspace switch. It keeps the SDK-reserved keys outside /storage (the RUM session
 * id, the workspace cache), which the next login needs, and every key other code wrote.
 */
export function clearAllAppStorage(): void {
  for (const area of ['local', 'session'] as const) {
    memory[area].clear();
    const s = browserStorage(area);
    try {
      if (!s) continue;
      for (let i = s.length - 1; i >= 0; i--) {
        const k = s.key(i);
        if (k !== null && SDK_KEY.test(k)) s.removeItem(k);
      }
    } catch {
      // nothing to clear
    }
  }
}
