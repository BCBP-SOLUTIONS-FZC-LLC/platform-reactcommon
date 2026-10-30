// React contexts: the shell's values (PlatformProvider) and the nearest MFE scope (MFEErrorBoundary,
// RemoteBoundary), which binds useApiClient and logs to a remote.
import { createContext } from 'react';
import type { SessionContext, SessionUser, Workspace } from '../auth/index.ts';

export interface ShellContextValue {
  user?: SessionUser;
  workspace?: Workspace;
  /** undefined until loaded (IAM P-35), or when it could not be loaded. */
  context?: SessionContext;
  locale: string;
  /** Resolves `identifierOrSlug` (PUB-1) and switches; the shell shows "workspace not found" itself. */
  switchWorkspace(identifierOrSlug: string): Promise<void>;
}

export const ShellContext = createContext<ShellContextValue | undefined>(undefined);
ShellContext.displayName = 'PlatformShell';

/** The remote (MFE) the subtree belongs to; undefined in the shell's own code. */
export const MfeContext = createContext<string | undefined>(undefined);
MfeContext.displayName = 'PlatformMfe';
