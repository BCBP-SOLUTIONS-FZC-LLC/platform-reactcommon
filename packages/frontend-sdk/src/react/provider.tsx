// PlatformProvider and Can.
import type { JSX, ReactNode } from 'react';
import { ShellContext, type ShellContextValue } from './context.ts';
import { useHasPermission } from './hooks.ts';

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
