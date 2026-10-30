// The RUM session id (design doc §C1 /core). One id per browser profile: it is kept in
// localStorage under an SDK-reserved key (outside /storage namespaces), shared by every tab and
// kept across reloads. Logout and the cross-tab idle timeout rotate it (/auth calls
// rotateSessionId); other tabs see the new id on their next read. It is a random correlation id,
// never the IdP session id, and it is sent as x-session-id and logged as session_id.
// When localStorage is unavailable, a per-page id is kept on the PlatformRuntime instead.
import { UUID_V4_PATTERN, uuidV4 } from './ids.ts';
import { getRuntime } from './runtime.ts';

export const SESSION_ID_STORAGE_KEY = '@platform/frontend-sdk:session-id';

function localStore(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined; // access itself can throw (blocked storage, sandboxed iframes)
  }
}

function memoryId(): string {
  const rt = getRuntime();
  rt.memorySessionId ??= uuidV4();
  return rt.memorySessionId;
}

export function getSessionId(): string {
  const store = localStore();
  if (!store) return memoryId();
  try {
    const stored = store.getItem(SESSION_ID_STORAGE_KEY);
    if (stored !== null && UUID_V4_PATTERN.test(stored)) return stored;
    const id = getRuntime().memorySessionId ?? uuidV4();
    store.setItem(SESSION_ID_STORAGE_KEY, id);
    return id;
  } catch {
    return memoryId(); // quota or security errors: keep one stable id for this page
  }
}

/** Starts a new session (logout, idle timeout) in this tab and, through localStorage, every other. */
export function rotateSessionId(): string {
  const id = uuidV4();
  getRuntime().memorySessionId = id;
  try {
    localStore()?.setItem(SESSION_ID_STORAGE_KEY, id);
  } catch {
    // the per-page id above still rotates
  }
  return id;
}
