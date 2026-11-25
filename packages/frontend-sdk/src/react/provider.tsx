// PlatformProvider, Can and Writable.
import type { JSX, ReactNode } from 'react';
import { ShellContext, type ShellContextValue } from './context.ts';
import { useHasPermission, useReadOnly } from './hooks.ts';

/** Shell only: provides the signed-in user, workspace, session context, locale and switchWorkspace. */
export function PlatformProvider(p: { children: ReactNode; shell: ShellContextValue }): JSX.Element {
  return <ShellContext.Provider value={p.shell}>{p.children}</ShellContext.Provider>;
}

/** Renders `children` when the subject may do `action` on `resource`, else `fallback`. A UI hint only. */
export function Can(p: { action: string; resource: string; children: ReactNode; fallback?: ReactNode }): JSX.Element | null {
  const allowed = useHasPermission(p.action, p.resource);
  const shown = allowed ? p.children : p.fallback;
  return shown === undefined || shown === null ? null : <>{shown}</>;
}

/**
 * Renders `children` while the workspace is writable (useReadOnly() is false: neither the session context's
 * readOnly nor a DENY_TENANT_READ_ONLY answer seen on this page), else `fallback` (e.g. the same control,
 * disabled). No styling and no text: the shell tells the user why the workspace is read-only. Nests with
 * Can: `<Can action resource><Writable fallback={…}>…</Writable></Can>`. It checks no permission, and
 * shows `children` while the session context has not loaded (readOnly is not known then): put it inside
 * Can, which denies until the context loads. A UI hint only: the gateway refuses writes to a read-only
 * workspace whatever the UI shows.
 */
export function Writable(p: { children: ReactNode; fallback?: ReactNode }): JSX.Element | null {
  const shown = useReadOnly() ? p.fallback : p.children;
  return shown === undefined || shown === null ? null : <>{shown}</>;
}
