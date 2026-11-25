// React contexts: the shell's values (PlatformProvider) and the nearest MFE scope (MFEErrorBoundary,
// RemoteBoundary), which binds useApiClient and logs to a remote.
import { createContext } from 'react';
import type { SessionContext, SessionUser, Workspace } from '../auth/index.ts';

export interface ShellContextValue {
  user?: SessionUser | undefined;
  workspace?: Workspace | undefined;
  /** undefined until loaded (IAM P-35), or when it could not be loaded. */
  context?: SessionContext | undefined;
  locale: string;
  /** Resolves `identifierOrSlug` (PUB-1) and switches; the shell shows "workspace not found" itself. */
  switchWorkspace(identifierOrSlug: string): Promise<void>;
  /**
   * Signs out (the shell's IdentityProvider.logout): global by default, ending the SSO session too;
   * `{ global: false }` signs out of this browser only. Every tab of the browser follows. Optional for
   * shells written before it; useSignOut rejects then.
   */
  signOut?: ((o?: { global?: boolean }) => Promise<void>) | undefined;
  /**
   * Reloads the session context (IAM P-35) and applies it, for useRefreshSessionContext. Resolves true when
   * a new context was applied; false when it was not: the load failed and the old context was kept, or the
   * shell took over the page (another workspace's context, a refusal it shows its own screen for, a
   * sign-out). The shell handles every refusal itself; the SDK does not interpret the result further.
   * It must settle (bound the load, e.g. the ApiClient's timeout): the SDK queues later calls behind it.
   * Optional for shells written before it: the hook then resolves false.
   */
  refreshContext?: (() => Promise<boolean>) | undefined;
}

export const ShellContext = createContext<ShellContextValue | undefined>(undefined);
ShellContext.displayName = 'PlatformShell';

/** The remote (MFE) the subtree belongs to; undefined in the shell's own code. */
export const MfeContext = createContext<string | undefined>(undefined);
MfeContext.displayName = 'PlatformMfe';
