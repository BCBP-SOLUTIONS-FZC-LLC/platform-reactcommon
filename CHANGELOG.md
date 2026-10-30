# Changelog

All notable changes to this project are documented in this file. The three packages (`@platform/frontend-sdk`, `@platform/webpack-preset`, `@platform/eslint-plugin`) share one version and this one history.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see [VERSIONING.md](VERSIONING.md) (pre-release `1.0.0-alpha.N` until the first environment).

## [Unreleased]

> **First release** (`1.0.0-alpha.1`). Everything below is new. The SDK implements design-doc steps 0–14; the browser's Tier 1 metrics (step 15) wait for governance to ratify their names.

### Added

**`@platform/frontend-sdk` — Foundation**

- **`/core`:**
  - page identity (`initializeCore`), validated against the platform registry vocabulary, including the multi-domain shell's `portal` domain (platform-gincommon v2.3.0);
  - the `PlatformRuntime`, shared by every SDK copy on the page, with duplicate-copy detection;
  - correlation ids (`getSessionId`: one RUM session id per browser profile, shared by tabs; `newRequestId`);
  - consent (`setConsentProvider`, `hasConsent`);
  - log sanitizing with gincommon parity (`isSensitiveKey`, `sanitizeFields`, `sanitizeString`).
- **`/config`:**
  - the strict `RuntimeConfigSchema`: unknown keys rejected at every level, the design doc's defaults;
  - `loadRuntimeConfig`: no HTTP cache, and every failure a `RuntimeConfigError` with issue paths;
  - `setRuntimeConfig` / `getConfig` / `tryGetConfig`: set once, deep-frozen;
  - validation never constructs code at runtime (CSP-safe).
- **`/problem`:**
  - the platform error-type registry (`PlatformProblemTypes`, `typeForStatus`, `defineProblemType` with gincommon's rules);
  - the error model (`ProblemError`, `TimeoutError`, `NetworkError`, `AbortedError`);
  - `parseProblemResponse`, which decodes as gincommon does, with synthetic problems for non-problem responses;
  - the gateway deny codes (`GATEWAY_DENY_CODES`, `gatewayDenyCode`).

**`@platform/frontend-sdk` — Observability**

- **`/tracing`:**
  - OTLP/HTTP browser tracing with gincommon's resource attributes and sampler (`ParentBased`, Go's exact `TraceIDRatioBased`);
  - a bounded drop-oldest export queue gated on telemetry consent;
  - `withSpan`, `currentTraceId`, and `injectTraceHeaders` (page origin and an exact-origin allowlist only).
- **`/logging`:**
  - OTLP browser logs with gincommon's field names (`trace_id`, `span_id`, `request_id`, `session_id`, `mfe`, `page_route`);
  - redaction: sensitive keys, control characters, JWT and Bearer values, URL query strings;
  - consent gating: errors and essential warnings are always sent;
  - batching, with `sendBeacon` on page hide;
  - `setRouteTemplate`.
- **`/metrics`** (Tiers 2 and 3):
  - `getDomainMeter` and `getServiceMeter`, with gincommon's naming and label rules, checked against `metricslint`;
  - centrally injected `domain` / `service` / `environment`, and a remote's identity taken from its manifest owner domain;
  - cardinality bounds;
  - a delta OTLP exporter gated on telemetry consent.

**`@platform/frontend-sdk` — Data access**

- **`/http`:** `createApiClient`.
  - **Requests:** route templates; identity headers refused; request id, trace context and session id on the page origin and allowlist; the token on the page origin only; an idempotency key on `POST`; a client deadline.
  - **Errors and retries:** the 401 path through the tab's single token refresh; retries with backoff and `Retry-After` for idempotent calls.
  - **Concurrency:** shared concurrent `GET`s; offline detection (`isOnline`, `subscribeOnline`).

**`@platform/frontend-sdk` — Identity & access**

- **`/auth`:** `createOidcProvider`, Keycloak Authorization Code + PKCE S256, with tokens in memory only.
  - **Sign-in:** pending-login records; RFC 9207 `iss` and ID-token claim checks.
  - **Sessions:**
    - silent `prompt=none` restore, with a per-tab loop guard and a signed-out mark;
    - a single-flight refresh that never resends a replaced refresh token, and restores the session after an ambiguous failure;
    - a cross-tab idle timeout; local and global logout; `switchWorkspace`; step-up (`reauthenticate`, `needsStepUp`).
  - **Workspaces:** choosing and caching them (`slugFromPath`, `chooseWorkspace`, `cachedWorkspace`, `rememberWorkspace`, `isWrongWorkspace`).
  - **Also:** `signInAgain`, `initializeAuth`, `getSession`.
- **`/authz`:** UI permission hints (`hasPermission`, `roleMapAuthorizer`, `denyAll`, `setAuthorizer`, `setAuthzSubject`). Roles are re-parsed with gincommon's rule and fail closed.
- **`/storage`:** per-workspace, per-app JSON storage (`storage`, `workspaceNamespace`, `clearAllAppStorage`). It refuses credential-like keys (`ForbiddenStorageKeyError`) and writes nothing before sign-in.

**`@platform/frontend-sdk` — Micro-frontend platform**

- **`/mfe`:**
  - `loadManifest`: per-remote validation of the entry origin, version, registry owner domain and SRI;
  - `loadRemote`: kill switch, per-attempt timeout, retries, shared-module setup, `RemoteDisabledError` / `RemoteLoadError`;
  - `isChunkLoadError` / `reloadOnceForChunkError`;
  - `/version.json` polling with `subscribeAppUpdate`.
- **`/flags`:** `getFlag` (typed by its fallback), `isRemoteKilled`, the runtime-config and session-context flag providers, `setFlagProvider`.
- **`/nav`:** `navigate` through the shell's router (`registerNavigator`), and `isSafeRedirect` for return-URL validation.

**`@platform/frontend-sdk` — UI support**

- **`/i18n`:**
  - locale negotiation with `<html lang dir>` (RTL for Arabic);
  - per-remote message namespaces and ICU-lite messages (plural, select, offset; no `eval`);
  - `formatMoney`, `formatDate`, `formatNumber`;
  - `problemMessage`.
- **`/security`:** `sanitizeHtml` (DOMPurify; `TrustedHTML` where Trusted Types exist), `installTrustedTypesPolicy` (the CSP's `platform-sdk` policy) and `isAllowedOrigin`.

**`@platform/frontend-sdk` — Developer surface**

- **`/react`:** `PlatformProvider` and its hooks.
  - **Session and workspace:** `useSession`, `useCurrentUser`, `useWorkspace`, `useSessionContext`, `useBeforeAuthRedirect`, `useStepUp`, `useSwitchWorkspace`.
  - **Access, flags and language:** `useReadOnly`, `useFeatureFlag`, `useHasPermission` / `Can`, `useLocale` / `useT`.
  - **Data and page state:** `useApi` / `useApiClient` (bound to the nearest MFE scope), `useRouteTemplate`, `useOnlineStatus`, `useAppUpdate`.
  - **Error handling:** `MFEErrorBoundary` and `RemoteBoundary`, and `installGlobalErrorHandlers` (errors, rejections, redacted CSP violations).
- **`/testing`:** `createTestPlatform` (a real SDK runtime with in-memory logs and spans, a signed-in session, permissions and flags), `mockApi` and `mockProblem` (gincommon-shaped problems), and `renderMetricInventory` for `metricslint check` in a remote's CI.

**`@platform/webpack-preset`**

- **`platformShared`:** React, react-dom, `@opentelemetry/api` `~1.10.0` and every SDK subpath except `/testing`, all as strict singletons, with the SDK under `^1.0.0-0`.
- **`sharedFor('shell' | 'remote')`:** remotes never bundle the SDK.
- **`containerName`:** the SDK's container-global rule.
- **`platformWebpackConfig`:** Trusted Types policy `platform-webpack`, no `eval` devtools, hidden source maps, content hashes, `environment.globalThis`.

**`@platform/eslint-plugin`**

- **Rules:** `no-sdk-root-import`, `no-sdk-deep-import`, `no-identity-headers` (the SDK's forbidden-header list), `no-raw-storage`, `no-unsafe-html`, `no-runtime-css-in-js` and `api-route-template`.
- **`configs.recommended`:** all seven, plus `no-eval`, `no-implied-eval` and `no-new-func`.

**Contracts, examples, CI and docs**

- **Generated contracts** from pinned backend commits:
  - gincommon v2.3.0: registry, problem types, headers, redaction, log fields;
  - fastapicommon;
  - platform-interop-tests: shared fixtures, and the pair 4 interop run;
  - IAM AuthZ Enrichment: deny codes, injected headers;
  - IAM org-membership: PUB-1 / P-35 cases checked against its swagger.
- **Examples:**
  - a reference shell (the design doc's bootstrap, the IAM ports, its own screens);
  - the tenders remote;
  - CloudFront/CSP snippets: response-headers policy, SPA rewrite, `/csp-report` Lambda.
- **CI and release modelled on platform-gincommon:**
  - tests with a coverage gate, quality, contracts, package tarballs, Trivy, smoke tests, interop, a PR summary;
  - a tag-triggered release to a GitHub Release with an SBOM and Cosign-signed checksums.
- **Docs:** `ARCHITECTURE.md`, the LLD, functional areas, observability, problem details, `README.md`, `SECURITY.md`, `VERSIONING.md`, `CONTRIBUTING.md` and this changelog.

[Unreleased]: https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/commits/main
