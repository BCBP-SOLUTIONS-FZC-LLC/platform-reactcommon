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

/**
 * Shell only: the function navigate() calls. It routes by the path: a path under the shell router's
 * basename is a router navigation, any other same-origin path a full page load. A path inside the remote
 * already mounted must reach that remote's router (remount it, or have its router follow the URL), or the
 * URL changes while the remote's page does not.
 */
export function registerNavigator(n: Navigator): void {
  if (typeof n !== 'function') throw new TypeError('registerNavigator needs a function');
  getRuntime().navigator = n;
}

/**
 * Navigates to `path`, a same-origin path, through the shell's router. The path decides where the page
 * goes: a cross-remote path carries the workspace prefix (`/t/${slug}/admin/users` with the default
 * auth.workspacePathPrefix; the slug from useSessionContext(), as useWorkspace() may have none after a
 * trial sign-in from an invitation; never hard-coded; offered only once the context has loaded). `appId` names the app the path belongs to (a remote's name, or
 * 'shell'); it is informational, and a shell's navigator may ignore it. Within a remote, use the remote's
 * own router instead. Without a registered navigator (a remote run standalone) it is a full page
 * navigation. An unsafe path throws a TypeError.
 */
export function navigate(appId: string, path: string, o?: { replace?: boolean }): void {
  if (typeof appId !== 'string' || !APP_ID.test(appId)) throw new TypeError(`appId must match ${APP_ID.source}, got ${JSON.stringify(appId)}`);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || !isSafeRedirect(path, globalThis.location?.href ?? 'http://localhost/')) {
    throw new TypeError(`navigate needs a same-origin path such as '/t/acme/tenders/42', got ${JSON.stringify(path)}`);
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
