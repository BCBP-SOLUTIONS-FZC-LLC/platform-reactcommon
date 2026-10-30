/**
 * Cross-app navigation through the shell's router, and redirect-target validation.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/nav`.
 *
 * @packageDocumentation
 */
import { isSafeRedirect } from '../internal/redirect.ts';
import { getRuntime } from '../internal/runtime.ts';

export { isSafeRedirect };

type Navigator = (appId: string, path: string, o?: { replace?: boolean }) => void;

const APP_ID = /^[a-z][a-z0-9_-]{0,62}$/;

/** Shell only: the router function navigate() calls (e.g. one that maps appId to a route prefix). */
export function registerNavigator(n: Navigator): void {
  if (typeof n !== 'function') throw new TypeError('registerNavigator needs a function');
  getRuntime().navigator = n;
}

/**
 * Navigates to `path` (a same-origin path such as '/tenders/42') in `appId` (a remote's name or
 * 'shell') through the shell's router. Without a registered router (a remote run standalone) it
 * falls back to a full page navigation. An unsafe path throws a TypeError.
 */
export function navigate(appId: string, path: string, o?: { replace?: boolean }): void {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new TypeError(`appId must match ${APP_ID.source}, got ${JSON.stringify(appId)}`);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || !isSafeRedirect(path, globalThis.location?.href ?? 'http://localhost/')) {
    throw new TypeError(`navigate needs a same-origin path such as '/tenders/42', got ${JSON.stringify(path)}`);
  }
  const n = getRuntime().navigator as Navigator | undefined;
  if (n) {
    n(appId, path, o?.replace === undefined ? undefined : { replace: o.replace });
    return;
  }
  const loc = globalThis.location;
  if (!loc) return;
  if (o?.replace) loc.replace(path);
  else loc.assign(path);
}
