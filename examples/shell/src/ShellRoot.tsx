// The shell's PlatformProvider with its live values: the locale follows setLocale (useLocale) and the
// session context follows its store (a background retry of P-35 that succeeds), instead of the values
// bootstrap saw once.
import { useMemo, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { SessionContext } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import { PlatformProvider, useLocale, type ShellContextValue } from '@bcbp-solutions-fzc-llc/frontend-sdk/react';
import type { Store } from './session-context';

export function ShellRoot(p: {
  shell: Omit<ShellContextValue, 'locale' | 'context'>;
  context: Store<SessionContext | undefined>;
  children: ReactNode;
}): JSX.Element {
  const { locale } = useLocale();
  const context = useSyncExternalStore(p.context.subscribe, p.context.get, p.context.get);
  const shell = useMemo<ShellContextValue>(() => ({ ...p.shell, locale, context }), [p.shell, locale, context]);
  return <PlatformProvider shell={shell}>{p.children}</PlatformProvider>;
}
