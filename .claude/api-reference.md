# API Reference

The SemVer surface is the api-extractor report of each subpath, [`packages/frontend-sdk/api/<subpath>.api.md`](../packages/frontend-sdk/api/): regenerate with `pnpm api`, check with `pnpm api:check` (CI). A change to a report needs a changeset (major when it breaks). Signatures, options and defaults: those reports and LLD §5 (symbol catalogue §5.3, behaviour specifications §5.4). The design doc lists each subpath's intended API.

## `@bcbp-solutions-fzc-llc/frontend-sdk`

Import a subpath (`@bcbp-solutions-fzc-llc/frontend-sdk/http`), never the root (it throws). Layers as in [`architecture.md`](architecture.md). The table below lists each report's exported names (regenerate it from the reports when they change).

| Subpath | Layer | Area | Exports (from `api/<subpath>.api.md`) |
|---|---|---|---|
| `/authz` | 0 | Identity & access | `Authorizer`, `AuthzSubject`, `denyAll`, `hasPermission`, `roleMapAuthorizer`, `setAuthorizer`, `setAuthzSubject` |
| `/core` | 0 | Foundation | `ConsentCategory`, `ConsentProvider`, `CoreIdentity`, `CoreIdentityInput`, `Domain`, `DOMAINS`, `Environment`, `ENVIRONMENTS`, `getIdentity`, `getSessionId`, `hasConsent`, `IdentityMismatchError`, `initializeCore`, `InvalidIdentityError`, `isInitialized`, `isSensitiveKey`, `MfeScope`, `newRequestId`, `NotInitializedError`, `sanitizeFields`, `sanitizeString`, `scrubSecrets`, `ServiceName`, `setConsentProvider` |
| `/problem` | 0 | Foundation | `AbortedError`, `ApiError`, `DEFAULT_TYPE_BASE`, `defineProblemType`, `FieldError`, `GATEWAY_DENY_CODES`, `gatewayDenyCode`, `GatewayDenyCode`, `isProblemError`, `NetworkError`, `parseProblemResponse`, `PlatformProblemTypes`, `PROBLEM_CONTENT_TYPE`, `ProblemDetails`, `ProblemError`, `ProblemType`, `TimeoutError`, `toFieldErrorMap`, `typeForStatus` |
| `/config` | 1 | Foundation | `getConfig`, `loadRuntimeConfig`, `RuntimeConfig`, `RuntimeConfigError`, `RuntimeConfigSchema`, `setRuntimeConfig`, `tryGetConfig` |
| `/security` | 1 | UI support | `installTrustedTypesPolicy`, `isAllowedOrigin`, `sanitizeHtml` |
| `/storage` | 1 | Identity & access | `AppStorage`, `clearAllAppStorage`, `ForbiddenStorageKeyError`, `storage`, `workspaceNamespace` |
| `/logging` | 2 | Observability | `getLogger`, `initializeLogging`, `Logger`, `LogLevel`, `serializeError`, `setRouteTemplate` |
| `/metrics` | 2 | Observability | `Counter`, `getDomainMeter`, `getServiceMeter`, `Histogram`, `initializeMetrics`, `InvalidMetricError`, `startWebVitals` |
| `/tracing` | 2 | Observability | `bindTraceContext`, `currentTraceId`, `getTracer`, `initializeTracing`, `injectTraceHeaders`, `shutdownTracing`, `Span`, `Tracer`, `TracingOptions`, `withSpan` |
| `/flags` | 3 | Micro-frontend platform | `FlagProvider`, `FlagValue`, `getFlag`, `isRemoteKilled`, `runtimeConfigFlagProvider`, `sessionContextFlagProvider`, `setFlagProvider` |
| `/http` | 3 | Data access | `ApiClient`, `ApiResponse`, `createApiClient`, `FORBIDDEN_REQUEST_HEADERS`, `isOnline`, `RequestOptions`, `RouteTemplate`, `setTokenSource`, `subscribeOnline`, `TokenSource` |
| `/i18n` | 3 | UI support | `formatDate`, `formatMoney`, `formatNumber`, `initializeI18n`, `problemMessage`, `registerNamespace`, `setLocale`, `t` |
| `/auth` | 4 | Identity & access | `cachedWorkspace`, `chooseWorkspace`, `createOidcProvider`, `getSession`, `IdentityProvider`, `initializeAuth`, `isWrongWorkspace`, `rememberWorkspace`, `SessionContext`, `SessionContextSource`, `SessionState`, `SessionUser`, `signInAgain`, `slugFromPath`, `Workspace`, `WorkspaceResolver` |
| `/mfe` | 4 | Micro-frontend platform | `isChunkLoadError`, `loadManifest`, `loadRemote`, `reloadOnceForChunkError`, `RemoteDisabledError`, `RemoteLoadError`, `RemoteManifest`, `RemoteManifestEntry`, `startVersionPolling`, `subscribeAppUpdate` |
| `/nav` | 4 | Micro-frontend platform | `isSafeRedirect`, `navigate`, `registerNavigator` |
| `/react` | 5 | Developer surface | `Can`, `ErrorInfoView`, `installGlobalErrorHandlers`, `MFEErrorBoundary`, `PlatformProvider`, `RemoteBoundary`, `ShellContextValue`, `useApi`, `useApiClient`, `useAppUpdate`, `useBeforeAuthRedirect`, `useCurrentUser`, `useFeatureFlag`, `useHasPermission`, `useLocale`, `useOnlineStatus`, `useReadOnly`, `useRouteTemplate`, `useSession`, `useSessionContext`, `useSignOut`, `useStepUp`, `useSwitchWorkspace`, `useT`, `useWorkspace` |
| `/testing` | 5 | Developer surface | `createTestPlatform`, `LogRecord`, `mockApi`, `mockProblem`, `renderMetricInventory`, `SpanRecord` |

### Behaviour worth knowing before changing a call site

- **`IdentityProvider.logout(o?)`**, the shell's `signOut`, `useSignOut()`: **global by default** (ends the Keycloak session); `{ global: false }` is local-only (CHANGELOG `1.0.0-alpha.1`, Breaking).
- **`createApiClient`**: route templates only (`/tenders/:id`, no query or `..`); identity headers throw; the token goes to the page origin only.
- **`initializeMetrics`**: sends the interval by `sendBeacon` when the page is hidden or closing; Tier 1 `platform_web_*` names are recorded through the instrument port and stay no-ops until ratified (`startWebVitals` records nothing yet).
- **`sanitizeHtml`**: DOMPurify after a linear pre-pass that drops handler/style attributes and `<style>` (no CSP reports); returns `TrustedHTML` where Trusted Types exist.
- **`loadManifest`**: drops an entry without `integrity` outside local, dev and test.
- **`createTestPlatform()`** (`/testing`): a real SDK runtime with in-memory logs and spans, a signed-in session, permissions and flags; `mockApi`, `mockProblem`, `renderMetricInventory`.

## `@bcbp-solutions-fzc-llc/webpack-preset`

| Export | Purpose |
|---|---|
| `platformWebpackConfig({ role, name?, exposes?, mode })` | The webpack config for a shell (`publicPath: '/'`, `/assets`) or a remote (`remoteEntry.js`, `publicPath: 'auto'`); Trusted Types `platform-webpack`; no `eval`; hidden source maps; content hashes |
| `platformShared`, `sharedFor('shell' \| 'remote')` | Module Federation shared config: strict singletons for React, react-dom, `@opentelemetry/api`, every SDK subpath but `/testing`; remotes never bundle the SDK |
| `containerName(remote)` | The container-global naming rule |
| `ProvideSdkPlugin` | Shell: provides every SDK subpath lazily |
| `ChunkIntegrityPlugin`, `integrityOf`, `INTEGRITY_PLACEHOLDER`, `MISSING_INTEGRITY` | Production: sha384 for every lazy chunk, fail-closed (`MISSING_INTEGRITY`); pins the HTML's scripts |

No api-extractor report for this package; its surface is `src/index.ts`. LLD §13.1.

### Rspack and Rsbuild entry points

| Entry | Export | Purpose |
|---|---|---|
| `@bcbp-solutions-fzc-llc/webpack-preset/rspack` | `platformRspackConfig(options)` | The same settings as `platformWebpackConfig` for Rspack 2, with `ModuleFederationPluginV1` (webpack-compatible protocol) |
| | `ProvideSdkRspackPlugin`, `GlobalThisOnlyPlugin` | The shell's SDK provider; the runtime without the `Function('return this')` fallback |
| | `containerName`, `platformShared`, `sharedFor`, `integrityOf`, `MISSING_INTEGRITY`, `INTEGRITY_PLACEHOLDER` | As in the main entry |
| `@bcbp-solutions-fzc-llc/webpack-preset/rsbuild` | `pluginPlatform({ role, name?, exposes? })` | Rsbuild 2 plugin: the Rspack preset with Rsbuild's mode; refuses Rsbuild's `moduleFederation` option |

## `@bcbp-solutions-fzc-llc/eslint-plugin`

Rules `no-sdk-root-import`, `no-sdk-deep-import`, `no-identity-headers`, `no-raw-storage`, `no-unsafe-html`, `no-runtime-css-in-js`, `api-route-template`; `configs.recommended` = all seven + `no-eval`, `no-implied-eval`, `no-new-func`. LLD §13.2.
