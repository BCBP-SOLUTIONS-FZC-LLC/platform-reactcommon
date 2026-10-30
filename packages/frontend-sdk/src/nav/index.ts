/**
 * Cross-app navigation through the shell's router, and redirect-target validation.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/nav`.
 *
 * @packageDocumentation
 */
import { getRuntime } from '../internal/runtime.ts';

type Navigator = (appId: string, path: string, o?: { replace?: boolean }) => void;

const APP_ID = /^[a-z][a-z0-9_-]{0,62}$/;
// Control characters, any whitespace and backslashes are refused before parsing: the URL parser
// silently drops tabs and newlines and treats '\' as '/', which turns '/\t/evil' or '/\evil'
// into the protocol-relative '//evil'.
const UNSAFE = /[\p{Cc}\s\\\u2028\u2029]/u;

/**
 * Whether `url` is a safe redirect target: http(s) on the same origin as `base` (default: the
 * page), with no protocol-relative, backslash, whitespace or control-character tricks. Use it on
 * every returnUrl before following it.
 */
export function isSafeRedirect(url: string, base?: string): boolean {
  if (typeof url !== 'string' || url === '' || UNSAFE.test(url)) return false;
  const baseHref = base ?? globalThis.location?.href;
  if (typeof baseHref !== 'string') return false;
  let target: URL;
  let origin: URL;
  try {
    origin = new URL(baseHref);
    target = new URL(url, origin);
  } catch {
    return false;
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  if (target.username !== '' || target.password !== '') return false;
  return target.origin === origin.origin;
}

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
