---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/react`: `PlatformProvider`, session and workspace hooks (`useSession`,
`useCurrentUser`, `useWorkspace`, `useSessionContext`, `useBeforeAuthRedirect`, `useStepUp`,
`useSwitchWorkspace`), `useReadOnly` (session context or a `DENY_TENANT_READ_ONLY` seen),
`useFeatureFlag`, `useHasPermission` / `Can`, `useLocale` / `useT`, `useApi` / `useApiClient` bound to
the nearest MFE scope, `useRouteTemplate`, `useOnlineStatus`, `useAppUpdate`, `MFEErrorBoundary` and
`RemoteBoundary` (logs with the mfe scope, `platform_web_errors_total`, chunk-load reload once), and
`installGlobalErrorHandlers` (errors, rejections, redacted CSP violations).
