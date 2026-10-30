/**
 * React bindings: the shell's provider, session/workspace/permission/flag/locale hooks, API hooks bound
 * to the nearest MFE scope, error boundaries for remotes, and page-wide error capture.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/react`.
 *
 * @packageDocumentation
 */
export type { ShellContextValue } from './context.ts';
export {
  useApi,
  useApiClient,
  useAppUpdate,
  useBeforeAuthRedirect,
  useCurrentUser,
  useFeatureFlag,
  useHasPermission,
  useLocale,
  useOnlineStatus,
  useReadOnly,
  useRouteTemplate,
  useSession,
  useSessionContext,
  useStepUp,
  useSwitchWorkspace,
  useT,
  useWorkspace,
} from './hooks.ts';
export { MFEErrorBoundary, RemoteBoundary, type ErrorInfoView } from './boundaries.tsx';
export { installGlobalErrorHandlers } from './global-errors.ts';
export { Can, PlatformProvider } from './provider.tsx';
