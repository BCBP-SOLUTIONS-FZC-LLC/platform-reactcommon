# platform-reactcommon — Low-Level Design

## Tender Management SaaS Platform — Shared Frontend Libraries

| | |
|---|---|
| Packages | `@platform/frontend-sdk` · `@platform/webpack-preset` · `@platform/eslint-plugin` (one version, changesets `fixed`) |
| Version | `1.0.0-alpha.N` (pre-release until the first end-to-end environment) |
| Runtime | Evergreen browsers (ES2022, Trusted Types where supported); build tooling on Node ≥ 22 |
| Peers | `react` / `react-dom` `^18.3.0 \|\| ^19.0.0`, `@opentelemetry/api` `~1.10.0`, `webpack` `^5.100.0`, `eslint` `^9 \|\| ^10` |
| Design record | [`docs/design/frontend-sdk-design.md`](../design/frontend-sdk-design.md) (decisions, public API per subpath, contracts, backend changes) |
| Architecture | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (diagrams, invariants, threat model) |

### Revision history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-31 | First LLD, written from the implementation of design-doc steps 0–14 plus the `portal` domain and the CI pipeline (all on `main`). Step 15 (Tier 1 metric binding) is open; see §15 |

### Table of Contents

1. [Document Overview](#1-document-overview)
2. [Library Responsibilities and Boundaries](#2-library-responsibilities-and-boundaries)
3. [Architecture and Package Layout](#3-architecture-and-package-layout)
4. [Domain Model and Contracts](#4-domain-model-and-contracts)
5. [Public API Contract](#5-public-api-contract)
6. [Page State and Initialisation](#6-page-state-and-initialisation)
7. [Telemetry Architecture](#7-telemetry-architecture)
8. [Key Flows](#8-key-flows)
9. [Concurrency, Consistency, and Failure Handling](#9-concurrency-consistency-and-failure-handling)
10. [Security](#10-security)
11. [Observability of the SDK Itself](#11-observability-of-the-sdk-itself)
12. [Configuration](#12-configuration)
13. [Build Tooling Packages](#13-build-tooling-packages)
14. [Release, Distribution and Testing](#14-release-distribution-and-testing)
15. [Open Items](#15-open-items)

---

## 1. Document Overview

This LLD describes how the three packages are built. It records the limits, algorithms, state, and failure handling a reviewer or a maintainer needs, and that the design doc leaves at the level of intent.

Where the two disagree, the code and this LLD describe what ships; the design doc says why. Any disagreement is a bug in one of them, and §15 lists the known open items.

### 1.1 Relationship to the design doc and the platform standards

| Source | Role here |
|---|---|
| Design doc §C1 | The public API per subpath. `packages/frontend-sdk/api/*.api.md` (api-extractor) is the checked snapshot; CI fails when the code drifts from it |
| Design doc §C2–§C4 | Bootstrap order, Module Federation and CloudFront, examples. Implemented in `examples/` |
| Design doc §C5 | Contracts. Generated into `packages/frontend-sdk/contracts/` from pinned backend commits (§4.6) |
| Enterprise Platform Observability Standard | Registry, tiers, labels, `metricslint`. The SDK enforces the same rules at registration time (§7.3) |
| RFC 9457, as platform-gincommon emits it | Error model. The SDK parses gincommon's and fastapicommon's bodies identically (§4.5) |
| IAM HLD/LLDs (realms, PUB-1, P-35, AuthZ Enrichment) | Sign-in, workspace choice, session context and gateway denials (§8.3–§8.8) |

---

## 2. Library Responsibilities and Boundaries

### 2.1 In scope

- **Page identity and correlation:** `domain`, `service`, `environment` and `buildVersion` validated against the registry vocabulary; a RUM session id shared by tabs; request ids.
- **Consent:** `essential`, `telemetry` and `analytics` categories, read by every exporter.
- **Runtime configuration:** one `/config/runtime.json` per environment, validated strictly and frozen.
- **Telemetry:** traces, logs and metrics over OTLP/HTTP to `/otel`, with gincommon's sampler, its redaction rules and the registry's metric rules.
- **HTTP:** the `ApiClient`, built on route templates, with correlation and trace propagation, identity-header stripping, retries, 401 refresh, request de-duplication and RFC 9457 problems.
- **Sign-in:** Keycloak with Authorization Code + PKCE, tokens in memory only, workspace (realm) choice and caching, silent restore, refresh, idle timeout, logout, workspace switch and step-up.
- **UI support:** a UI authorizer (roles to permissions), feature flags, i18n (ICU-lite) with direction, per-workspace storage, HTML sanitizing and the Trusted Types policy, and safe navigation.
- **Micro-frontends:** the remote manifest, `loadRemote`, kill switches, chunk-load recovery and new-version detection.
- **React bindings:** hooks, `PlatformProvider`, error boundaries and global error handlers.
- **Testing:** a test platform with in-memory telemetry, plus API mocks.
- **Build tooling:** the Module Federation shared map and CSP-safe output (`@platform/webpack-preset`), and lint rules for consumers (`@platform/eslint-plugin`).

### 2.2 Out of scope (owned elsewhere)

| Concern | Owner |
|---|---|
| Token validation, identity headers, authorization decisions | API gateway: Envoy `jwt_authn` + IAM AuthZ Enrichment (`ext_authz`) |
| Realms, the `tender-web` client, token lifetimes, rotation settings | IAM realm provisioner (RP #41) |
| PUB-1 (tenant resolve) and P-35 (session context) | iam-org-membership. The shell implements the SDK's ports over the `ApiClient` |
| Ratifying `platform_web_*` metrics | Observability governance (§D5, §D6 K) |
| Collector, Loki, Tempo, Mimir, Grafana, alert routing | Platform observability |
| CloudFront, S3, WAF, deploys | Infrastructure (`examples/cloudfront` documents the requirements) |
| UI components, design system | `@platform/ui` (not this repo) |

### 2.3 Ownership split with sibling libraries

| Shared item | Source of truth | How this repo stays in line |
|---|---|---|
| Domain and environment vocabularies, service and version patterns | gincommon `registry.json` | `contracts/registry-vocab.json` → `/core` |
| Metric registry (tiers, metrics, labels, buckets, rules) | gincommon `registry.json` | `contracts/metric-registry.json` → `/metrics`; `metrics:parity` runs gincommon's `metricslint` |
| Header names, identity headers, propagation | gincommon `pkg/gincommon` + AuthZ Enrichment injected headers | `contracts/headers.json`, `gateway-headers.json` → `FORBIDDEN_REQUEST_HEADERS` |
| Log redaction rules | gincommon `log_sanitizer.go` | `contracts/redaction.json` → `/core` `isSensitiveKey`, `/logging` |
| Problem types, status mapping, wire rules | gincommon `pkg/problem` + `internal/problem` | `contracts/problem-types.json` → `/problem` |
| Gateway deny codes | AuthZ Enrichment `decision.go` | `contracts/gateway-deny-codes.json` |
| PUB-1 / P-35 response shapes | org-membership swagger | `contracts/tenant-resolve-cases.json`, `session-context-cases.json` (cases checked against the swagger) |
| Behaviour across languages | platform-interop-tests | shared fixtures + pair 4 (ts-probe) |

---

## 3. Architecture and Package Layout

```
platform-reactcommon/
  packages/
    frontend-sdk/             @platform/frontend-sdk
      src/<subpath>/index.ts    17 subpaths; index.ts is the only public surface of each
      src/internal/             runtime registry, events, instrument port, batcher, online,
                                redirect, locale, session, ids, urls, generated/ (contracts as TS)
      src/root.ts               the "." entry: throws (no barrel)
      contracts/                generated, committed (never edited)
      api/                      api-extractor report per subpath
      subpaths.json             subpaths, layers, allowed imports (single source)
      test/<subpath>/           Vitest
    webpack-preset/           @platform/webpack-preset (src/generated/sdk.ts generated)
    eslint-plugin/            @platform/eslint-plugin  (src/generated/{sdk,forbidden-headers}.ts generated)
  examples/shell, examples/remote-tenders, examples/cloudfront
  scripts/                    sync-contracts, sync-exports, sync-docs, api-report, metrics-parity,
                              check-examples (pure logic in scripts/lib, unit-tested)
  docs/                       design/, architecture/, lld/, observability/, problem-details/
  .github/                    ci.yml, release.yml, validate-*.yml, changeset-check.yml
```

### 3.1 Library dependencies (direct, `@platform/frontend-sdk`)

| Dependency | Used by | Why |
|---|---|---|
| `@opentelemetry/sdk-trace`, `sdk-logs`, `sdk-metrics` (OTel JS 3), `exporter-*-otlp-http` (0.300), `otlp-transformer`, `resources`, `core` | `/tracing`, `/logging`, `/metrics` only | OTLP/HTTP export; one pipeline, no Faro |
| `@opentelemetry/api` `~1.10.0` (peer, shared singleton) | the three telemetry subpaths | OTel JS 3 requires `>=1.10 <1.11`; one global API per page |
| `zod` 4 (jitless) | `/config` | Strict runtime-config validation |
| `dompurify` 3 | `/security` | HTML sanitizing (own entry so other subpaths do not pay its ~20 KB) |
| `react`, `react-dom` (peers) | `/react`, `/testing` only | |

### 3.2 Dependency rules

Generated from `subpaths.json` into the exports map, the ESLint config (`eslint-plugin-boundaries` and `no-restricted-imports`), dependency-cruiser's rules and the webpack preset's shared list (diagram: ARCHITECTURE.md § Package dependency graph).

- A subpath imports only the subpaths listed for it, and another subpath only through its `index.ts`.
- `/testing` is exempt from the index-only rule ("testing ─► anything, dev only"), so it can install the test exporters.
- `src/internal` may import only `/core`.
- React only in `/react` and `/testing`; `@opentelemetry/*` only in `/tracing`, `/logging`, `/metrics` and `/testing`.
- No subpath reads another's module state: shared state is on the `PlatformRuntime` (§6.1).

### 3.3 Integration points

| Consumer | Integrates through |
|---|---|
| Shell | The bootstrap (§6.2); ports `WorkspaceResolver` and `SessionContextSource`; `PlatformProvider`; its own screens |
| Remote | Subpath imports taken from the shell (`import: false`); `MFEErrorBoundary`; `useApi`; `useT`; `getServiceMeter` |
| CI of a remote | `renderMetricInventory()` → `metricslint check`; `createTestPlatform`, `mockApi` in unit tests |
| Gateway / backends | HTTP headers (§5.4.1), RFC 9457 bodies, `X-Trace-ID` / `X-Request-ID` echoes |
| Keycloak | Fixed endpoints under `${idpOrigin}/realms/${realm}/protocol/openid-connect/` |
| Collector | OTLP/HTTP JSON on `/otel/v1/{traces,logs,metrics}`; `sendBeacon` for logs on page hide |

---

## 4. Domain Model and Contracts

### 4.1 Page identity (`/core`)

`initializeCore({ serviceName, domain, environment, buildVersion })` validates and freezes one identity per page:

| Field | Rule | Failure |
|---|---|---|
| `domain` | ∈ `DOMAINS` (registry vocabulary: `iam`, `workflow`, `billing`, `tender_management`, `notifications`, `documents`, `bff`, `portal`) | `InvalidIdentityError('domain')` |
| `serviceName` | registry service pattern `^[a-z][a-z0-9_-]{0,62}$` | `InvalidIdentityError('serviceName')` |
| `environment` | ∈ `ENVIRONMENTS` (`local`, `dev`, `test`, `staging`, `prod`; no aliases) | `InvalidIdentityError('environment')` |
| `buildVersion` | registry version pattern after sanitizing; `unknown` when empty | — |

Strings are sanitized like gincommon (Go's whitespace trim, control characters removed; the SDK also strips U+2028/2029, a deliberate stricter difference recorded in the identity fixture as `expectedSdk`). A second call with the same normalised identity is a no-op; a different one throws `IdentityMismatchError` naming the field. A remote never calls it: it reads the shell's identity from the runtime.

The **RUM session id** is a random v4 UUID kept in localStorage under `@platform/frontend-sdk:session-id`, so it is shared by tabs and survives reloads. It is rotated on logout and idle timeout, and falls back to a per-page id when storage is blocked. It is sent as `x-session-id` and logged as `session_id`. It is never the IdP session.

### 4.2 Runtime configuration (`/config`)

`loadRuntimeConfig()` fetches `/config/runtime.json` with `cache: no-cache`. `RuntimeConfigSchema` (zod, strict at every level: an unknown key fails) parses it, and the result is deep-frozen. `setRuntimeConfig()` publishes it on the runtime; `getConfig()` throws `NotInitializedError` before that, and `tryGetConfig()` returns `undefined`. Fields and defaults are listed in §12.1. Zod runs in **jitless** mode: its first-parse `new Function('')` probe would otherwise fire a CSP violation on every page load.

### 4.3 Session model (`/auth`)

```ts
SessionUser   { sub; name?; email?; tenantId? /* trial realm only */; authTime? /* epoch s */ }
Workspace     { realm; trial; slug?; tenantIdHint? /* trial, from PUB-1 */ }
SessionContext{ tenantId; slug; roles; departments[{ id, level }]; plan?; featureFlags; readOnly;
                mfaFreshnessSeconds?; locale? }            // IAM P-35, UI hints only
SessionState  = loading
              | anonymous { workspace?; reason: 'none' | 'signed-out' | 'login-required' }
              | authenticated { user; workspace; expiresAt }
              | expired { workspace?; serverEnded; idle }  // runtime only, never from init()
```

**Realm rules.**
- A paid workspace's realm is `${paidRealmPrefix}${slug}` (`tenant-acme`); a trial workspace's realm is `trialRealm` (`trial`).
- `chooseWorkspace` rejects, and never caches, a resolved realm that doesn't fit the slug.
- `authorize()` refuses a realm that doesn't match `^[a-z0-9][a-z0-9-]{0,62}$`, so a realm can't change the URL path.

### 4.4 Storage namespaces (`/storage`)

Keys are `<namespace>:<appId>:<key>`. The namespace (set by `/auth` at login, on the runtime) is:
- the realm, for a paid workspace;
- `trial:<tenant_id>`, for the shared trial realm;
- `anon`, when there is no session, or for a trial token without a valid `tenant_id`.

`set` in `anon` is a no-op with a dev warning. Keys that look like credentials (`isSensitiveKey`: the redaction contract's key list, substrings and `*_key`) throw `ForbiddenStorageKeyError`. Storage that is unavailable or full falls back to an in-page map. `clearAllAppStorage()` removes every SDK-namespaced key in both areas, and keeps the SDK-reserved keys (session id, workspace cache, auth marks).

### 4.5 Problem model (`/problem`)

`ProblemDetails` carries:
- **the standard members:** `type`, `title`, `status`, `detail`, `instance`;
- **gincommon's members:** `traceId`, `errorCode`, `tenantId`, `timestamp`, `validationErrors`;
- **`extensions`:** every other top-level member.

`ProblemError` adds `typeId`: the last two path segments of an absolute `type`, `undefined` for `about:blank`. It also adds `requestId`, `synthetic` (`true` when built from the status, not a body), and `is(type)`, which compares type ids only.

A body over 1 MiB, or one that isn't `application/problem+json`, is never parsed: the problem is synthesized from `typeForStatus(status)`, with the `X-Trace-ID` header as its `traceId`. The other `ApiError`s are `TimeoutError { timeoutMs, requestId }` and `NetworkError { offline, requestId }`. A caller's abort becomes `AbortedError`, which is never reported. Platform types and deny codes: [docs/problem-details/registry.md](../problem-details/registry.md).

### 4.6 Contracts

| File | From | Read by |
|---|---|---|
| `registry-vocab.json` | gincommon registry | `/core` |
| `metric-registry.json` | gincommon registry | `/metrics` |
| `problem-types.json` | go-probe `contracts-export` + gincommon `internal/problem` | `/problem` |
| `headers.json`, `gateway-headers.json` | go-probe + gincommon `internal/core/domain`; AuthZ Enrichment | `/core`, `/http`, eslint-plugin |
| `redaction.json` | gincommon log sanitizer | `/core`, `/logging` |
| `log-fields.json` | gincommon logging middleware | `/logging` |
| `gateway-deny-codes.json` | AuthZ Enrichment `decision.go` (checked against its pinned test) | `/problem` |
| `tenant-resolve-cases.json`, `session-context-cases.json` | SDK-authored cases, each checked against the org-membership swagger | `/auth` tests, the shell's port tests |
| `fixtures/*.json` | platform-interop-tests (byte copies) | `/core`, `/http`, `/problem` tests |

The TypeScript constants (`src/internal/generated/*.ts`, one module per contract, so a subpath bundles only what it uses) are generated from the same objects. `pnpm contracts:check` fails CI when anything differs from what the pinned commits generate.

---

## 5. Public API Contract

### 5.1 Conventions

- Subpath imports only; `import '@platform/frontend-sdk'` throws.
- Every public symbol is in `api/<subpath>.api.md`. A change is a reviewed diff plus a changeset.
- "Shell only" functions (`initialize*`, `set*Provider`, `loadManifest`, `startVersionPolling`, `PlatformProvider`, `installGlobalErrorHandlers`, `initializeAuth`) are called once, by the shell. A second `initialize*` call is a no-op, except `initializeCore` with a different identity.
- Functions that need an earlier step throw `NotInitializedError` (for example `initializeTracing` before `initializeCore`). Read paths degrade instead: no-op spans, a console logger, `denyAll`, platform flags.
- Errors are typed classes (`InvalidIdentityError`, `RuntimeConfigError`, `InvalidMetricError`, `ForbiddenStorageKeyError`, `RemoteDisabledError`, `RemoteLoadError`, `ProblemError` …), never strings.

### 5.2 Ordering rules

| Rule | Why |
|---|---|
| `installTrustedTypesPolicy` before anything injects script or HTML | Under `require-trusted-types-for 'script'` the policy must exist first |
| `initializeCore` before telemetry | Telemetry needs the identity (the OTel resource) |
| `setConsentProvider` before telemetry exports | Nothing leaves the page without consent |
| `initializeAuth(idp)` before `idp.init()` and the first API call | `/http` reads the token source from the runtime |
| `loadManifest` before `RemoteBoundary` renders | `loadRemote` reads the manifest from the runtime |
| `setAuthzSubject` / flag provider after the session context loads | Permissions and tenant flags come from P-35 |

### 5.3 Symbol catalogue

| Subpath | Public symbols |
|---|---|
| `/core` | `initializeCore` · `getIdentity` · `isInitialized` · `setConsentProvider` · `hasConsent` · `getSessionId` · `newRequestId` · `sanitizeString` · `sanitizeFields` · `isSensitiveKey` · `DOMAINS` · `ENVIRONMENTS` · types `CoreIdentity(Input)`, `Domain`, `Environment`, `ServiceName`, `ConsentCategory`, `ConsentProvider`, `MfeScope` · `InvalidIdentityError` · `IdentityMismatchError` · `NotInitializedError` |
| `/problem` | `parseProblemResponse` · `isProblemError` · `ProblemError` · `TimeoutError` · `NetworkError` · `AbortedError` · `ApiError` · `PlatformProblemTypes` · `defineProblemType` · `typeForStatus` · `toFieldErrorMap` · `gatewayDenyCode` · `GATEWAY_DENY_CODES` · `DEFAULT_TYPE_BASE` · `PROBLEM_CONTENT_TYPE` · types `ProblemDetails`, `ProblemType`, `FieldError`, `GatewayDenyCode` |
| `/authz` | `roleMapAuthorizer` · `setAuthorizer` · `setAuthzSubject` · `hasPermission` · `denyAll` · types `Authorizer`, `AuthzSubject` |
| `/config` | `loadRuntimeConfig` · `setRuntimeConfig` · `getConfig` · `tryGetConfig` · `RuntimeConfigSchema` · `RuntimeConfigError` · type `RuntimeConfig` |
| `/security` | `installTrustedTypesPolicy` · `sanitizeHtml` · `isAllowedOrigin` |
| `/storage` | `storage(appId, { area })` · `clearAllAppStorage` · `workspaceNamespace` · `ForbiddenStorageKeyError` · type `AppStorage` |
| `/tracing` | `initializeTracing` · `shutdownTracing` · `getTracer` · `withSpan` · `currentTraceId` · `injectTraceHeaders` · types `Tracer`, `Span`, `TracingOptions` |
| `/logging` | `initializeLogging` · `getLogger({ mfe })` · `setRouteTemplate` · `serializeError` · types `Logger`, `LogLevel` |
| `/metrics` | `initializeMetrics` · `getDomainMeter` · `getServiceMeter` · `startWebVitals` (no-op until Tier 1) · `InvalidMetricError` · types `Counter`, `Histogram` |
| `/http` | `createApiClient({ baseUrl, mfe })` · `setTokenSource` · `isOnline` · `subscribeOnline` · `FORBIDDEN_REQUEST_HEADERS` · types `ApiClient`, `ApiResponse`, `RequestOptions`, `RouteTemplate`, `TokenSource` |
| `/flags` | `getFlag` · `setFlagProvider` · `runtimeConfigFlagProvider` · `sessionContextFlagProvider` · `isRemoteKilled` · types `FlagProvider`, `FlagValue` |
| `/i18n` | `initializeI18n` · `registerNamespace` · `setLocale` · `t` · `problemMessage` · `formatDate` · `formatNumber` · `formatMoney` |
| `/auth` | `createOidcProvider` · `initializeAuth` · `getSession` · `chooseWorkspace` · `cachedWorkspace` · `rememberWorkspace` · `slugFromPath` · `isWrongWorkspace` · `signInAgain` · types `IdentityProvider`, `SessionState`, `SessionUser`, `Workspace`, `SessionContext`, `WorkspaceResolver`, `SessionContextSource` |
| `/mfe` | `loadManifest` · `loadRemote` · `isChunkLoadError` · `reloadOnceForChunkError` · `startVersionPolling` · `subscribeAppUpdate` · `RemoteDisabledError` · `RemoteLoadError` · types `RemoteManifest`, `RemoteManifestEntry` |
| `/nav` | `navigate(appId, path)` · `registerNavigator` · `isSafeRedirect` |
| `/react` | `PlatformProvider` · `useSession` · `useCurrentUser` · `useWorkspace` · `useSessionContext` · `useBeforeAuthRedirect` · `useReadOnly` · `useStepUp` · `useLocale` · `useSwitchWorkspace` · `useFeatureFlag` · `useHasPermission` · `Can` · `useApi` · `useApiClient` · `useRouteTemplate` · `useOnlineStatus` · `useAppUpdate` · `useT` · `MFEErrorBoundary` · `RemoteBoundary` · `installGlobalErrorHandlers` · types `ShellContextValue`, `ErrorInfoView` |
| `/testing` | `createTestPlatform` · `mockApi` · `mockProblem` · `renderMetricInventory` · types `LogRecord`, `SpanRecord` |

### 5.4 Key behaviour specifications

#### 5.4.1 `ApiClient` calls

| Aspect | Behaviour |
|---|---|
| URL | `baseUrl` (default `api.baseUrl`) + template. A template is a path (`/…`) with no query, fragment, whitespace or `..`; every `:name` needs a non-empty param (URL-encoded), and an unused param is an error (`TypeError`). `query` values are appended encoded; `undefined` is skipped |
| Body | `string`, `FormData`, `Blob`, `URLSearchParams`, `ArrayBuffer` as is; anything else JSON with `content-type: application/json` |
| Accept | `application/json, application/problem+json` |
| Deadline | `timeoutMs` (default `api.timeoutMs`, 35 000 ms; above gincommon's 30 s server timeout), per attempt, combined with the caller's signal |
| Retries | `GET`, `PUT`, `DELETE` (or `retry: { unsafe: true }`): up to `attempts` (default 2) more, on timeout, network error (online), 429, 502, 503, 504; wait `Retry-After` (≤ 30 s) else full-jitter `min(5 s, 250 ms · 2ⁿ)`; `retry: false` disables |
| 401 | Once per call: if a newer token exists use it, else join the tab's `refresh()`; a new token retries (not counted as a retry); otherwise `onUnauthorized()` |
| De-duplication | `GET` (unless `dedupe: false`): identical URL + token + headers share one call; the shared fetch is aborted only when every subscriber aborted |
| Result | `{ data, status, headers, requestId, traceId? }`; `data` is JSON when the content type says so, text otherwise, `undefined` for 204/205/empty |
| Errors | `ProblemError` (non-2xx), `TimeoutError`, `NetworkError { offline }` (offline fails at once, no fetch), `AbortedError` |

#### 5.4.2 `IdentityProvider` (`createOidcProvider`)

| Method | Behaviour |
|---|---|
| `init()` | Handles a callback (§8.3), else attempts one silent restore per tab (§8.4); resolves only to `authenticated` or `anonymous`; called twice → the same promise |
| `login({ workspace, returnUrl?, loginHint?, prompt? })` | Pending record + PKCE + `beforeRedirect('login')` + top-level redirect; throws when sessionStorage is unavailable |
| `getAccessToken()` | `undefined` when anonymous, expired or restoring; joins the refresh when within 5 s of expiry |
| `refresh()` | Single-flight; `true` with new tokens, `false` otherwise (state already moved, §8.5) |
| `logout({ global? })` | §8.7 |
| `switchWorkspace(w)` | Local logout of the current realm without the signed-out mark, broadcast `workspace-switched`, then `login(w)` with reason `switch` |
| `reauthenticate({ maxAgeSeconds, returnUrl? })` | `prompt=login&max_age=<s>` with reason `step-up`; needs a session |
| `needsStepUp(s)` | `now − auth_time > s`; `false` when `auth_time` is unknown |
| `subscribe` / `beforeRedirect` / `getState` | Listeners isolated (a throwing one is logged, others still run) |

#### 5.4.3 `loadRemote(name, module, { timeoutMs?, retries?, signal? })`

The steps:
1. Kill switch → `RemoteDisabledError`.
2. Otherwise, up to `1 + retries` attempts (default `remotes.retries`), each with `timeoutMs` (default `remotes.loadTimeoutMs`) to inject the entry script.
3. Initialize the share scope (an already-initialized scope is fine; any other failure is `incompatible` and not retried).
4. `container.get(module)`, then the factory.

Any failure is a `RemoteLoadError` carrying the cause. One span `remote load` and one metric observation per call.

#### 5.4.4 Error boundaries

`MFEErrorBoundary { mfe, fallback? }` sets the MFE scope for its subtree.
- **On catch:**
  1. It counts `platform_web_errors_total{ source: boundary or chunk_load }`.
  2. A chunk-load error reloads the page once per version.
  3. Otherwise it logs: an API error as `warn` (the server answer is already traced), anything else as `error`.
- **Fallback view:** `{ message, traceId?, requestId?, retry }`. The message is `problemMessage` for problems; otherwise a `platform` catalog text (with an English default) for "unexpected", "unavailable" (kill switch) and "offline".
- **`RemoteBoundary`** creates a new lazy component per retry, because React caches a rejected lazy forever.

---

## 6. Page State and Initialisation

### 6.1 Page-wide state inventory (`PlatformRuntime`)

| Field | Owner (writes) | Readers |
|---|---|---|
| `sdkVersion`, `owner` | runtime creation | duplicate-copy detection |
| `identity`, `consent`, `memorySessionId` | `/core` | everything |
| `instruments` (port) | `/metrics` (no-op default) | `/http`, `/mfe`, `/react` |
| `config` | `/config` | everything |
| `tracing`, `logging`, `metrics` | their subpaths | their subpaths, `/testing` |
| `pageRoute`, `routeTemplates` | `/logging` `setRouteTemplate` | logs, `/metrics` (bounds `page_route`) |
| `remotes` (mfe → ownerDomain), `manifest`, `appUpdate` | `/mfe` | `/metrics`, `/react` |
| `authorizer`, `authzSubject` | `/authz` | `/authz`, `/react` |
| `flagProvider` | `/flags` | `/flags`, `/mfe` (kill switch), `/react` |
| `identityProvider`, `tokenSource`, `storageNamespace` | `/auth` | `/http`, `/storage`, `/react` |
| `i18n` | `/i18n` | `/i18n`, `/react` (locale via `src/internal/locale`) |
| `navigator`, `trustedTypesPolicy` | `/nav`, `/security` | `/nav`, `/mfe` (script URLs), `/security` |
| `readOnlyDenied` | `/http` | `/react` `useReadOnly` |
| `events` (topic → listeners) | `src/internal/events` | `/react` |

Created on first use on `globalThis[Symbol.for('@platform/frontend-sdk')]`. A second SDK copy with the same major binds to it; another major keeps its own and logs one error. `resetRuntimeForTests()` exists for tests only.

### 6.2 Initialisation order (shell)

The order is fixed by design doc §C2 and drawn in ARCHITECTURE.md § Shell bootstrap:
1. Trusted Types policy.
2. Core identity.
3. Runtime config.
4. Consent provider.
5. Tracing, logging, metrics, global handlers, web vitals.
6. Runtime-config flags.
7. OIDC provider, `initializeAuth`, `init()`.
8. Session context, then the authorizer and subject, remembering the workspace, tenant flags, and i18n.
9. Manifest and version polling.
10. Render.

### 6.3 Idempotency

| Call | Second call |
|---|---|
| `initializeCore` (same identity) | no-op; a different identity throws `IdentityMismatchError` |
| `initializeTracing` / `initializeLogging` / `initializeMetrics` | no-op |
| `idp.init()` | returns the first promise |
| `loadManifest` | re-validates and replaces the published manifest |
| `setConsentProvider` / `setFlagProvider` / `setAuthorizer` / `setAuthzSubject` | replace; flags and authz emit their topic |

---

## 7. Telemetry Architecture

### 7.1 Traces (`/tracing`)

| Item | Value |
|---|---|
| Provider | OTel JS 3 `TracerProvider`; resource `service.name`, `service.version`, `service.namespace` (= domain), `deployment.environment.name`; no `service.instance.id` (would explode cardinality) |
| Sampler | `ParentBased`, root = `AlwaysOn` (ratio ≥ 1), `AlwaysOff` (≤ 0), else Go's `TraceIDRatioBased` algorithm, so browser and Go roots agree for the same trace id; default ratio 0.1 |
| Propagation | W3C `traceparent` / `tracestate` to the page's origin and exact allowlisted origins only |
| Export | Drop-oldest batch processor: batch 512, delay 5 s, queue 2048, ≤ 2 sends in flight; flush on page hide; spans dropped without `telemetry` consent (counted) |
| Context | `StackContextManager` (no zone.js) |

### 7.2 Logs (`/logging`)

Every record carries the envelope `trace_id`, `span_id` (active span), `request_id` (when given), `session_id`, `mfe` (`shell` by default) and `page_route` (a registered template or `unknown`). Caller attributes of the same name are dropped. Attributes go through redaction:
- sensitive keys become `[REDACTED]`;
- JWT and `Bearer` patterns are masked;
- URL query strings and fragments are removed;
- stacks are cut to 4 KiB.

| Level | Leaves the page when |
|---|---|
| `error` | always |
| `warn` | `essential: true`, or `telemetry` consent |
| `info`, `debug` | `telemetry` consent (and `level` allows) |

The export uses batch 50, flush 5 s, queue 1 000 (drop oldest), and at most 2 sends in flight. On page hide, the queue drains through `navigator.sendBeacon` in chunks under 60 KiB; whatever the browser refuses goes back to the queue. Before `initializeLogging`, loggers write to the console in `local`/`dev` (and when there's no identity) and are no-ops otherwise.

### 7.3 Metrics (`/metrics`)

| Tier | Constructor | Names | Labels injected |
|---|---|---|---|
| 1 platform | none public; the instrument port (`/http`, `/mfe`, `/react`) | `platform_web_*` | page identity; **no-op until ratified** (§15) |
| 2 domain | `getDomainMeter({ mfe? })` | only registry entries with `tier: "domain"` for the scope's domain | `service`, `environment` (+ `domain`) |
| 3 service | `getServiceMeter({ mfe? })` | `<domain>_<service>_<metric>` (gincommon `ServicePrefix`) | same |

For a remote, `domain` is its manifest `ownerDomain` and `service` is the remote's name. A remote missing from the manifest can't register (`InvalidMetricError('namespace')`).

**Registration checks.** These are the rules of gincommon's `metricslint`:
- the name pattern;
- `_total` for counters;
- `_seconds` or `_bytes` for histograms (`_bytes` only with the registry unit `bytes`);
- no prohibited labels or suffixes;
- registry labels and values;
- known bucket presets, at most 50 buckets;
- no reuse of a legacy name.

Tier 3 label values are capped at 100 per label, and the overflow value is `__other__`. Export uses OTLP/HTTP with **delta** temporality every 60 s, through a consent gate that discards the interval when `telemetry` isn't granted. Up to 1 000 label sets per instrument are kept for `renderMetricInventory()`.

### 7.4 Governance and CI

`pnpm metrics:parity` compares the SDK's registration checks with gincommon's `metricslint` case by case (recorded differences are listed in the script). It also runs `metricslint check -strict` on the SDK's rendered inventory.

The proposed Tier 1 browser metrics and their labels are listed in [docs/observability/README.md](../observability/README.md#tier-1-browser-metrics-proposed).

---

## 8. Key Flows

Sequence and state diagrams for these flows are in [ARCHITECTURE.md](../../ARCHITECTURE.md); this chapter records the rules they follow.

### 8.1 API call
See §5.4.1. One logical call is one span (`HTTP <METHOD>`, attributes `http.request.method`, `url.template`, `mfe`, `http.response.status_code`) and one instrument observation. Status class and error class follow gincommon's server labels. A `ProblemError` with errorCode `DENY_TENANT_READ_ONLY` sets `runtime.readOnlyDenied` and emits `read-only`.

### 8.2 Workspace choice (before login)
The rules, in order:
1. **The URL has a slug** (`/t/<slug>/…`): use the cached workspace for that slug. Otherwise call PUB-1 `resolve(slug)`, and accept the result only if the realm fits the slug, then cache it.
2. **PUB-1 fails** (unreachable or rate-limited): use the cached entry if there is one.
3. **PUB-1 answers "not found":** return `undefined`, which means the identifier-first screen. A different cached workspace is never used.
4. **The URL has no slug:** use the most recently cached workspace.
5. **`forceResolve`** (a session the server ended): skip the cache.

After sign-in, the shell calls `rememberWorkspace({ ...workspace, slug })`, taking the slug from P-35 for trial workspaces. The URL then becomes `/t/<slug>/…` if it had no slug. A trial result from an invitation email has no slug and is never cached.

### 8.3 Login and callback
- **Pending record:** one per `state` (128-bit `state` and `nonce`, a 32-byte verifier, an S256 challenge), in sessionStorage, expiring after 10 minutes. The callback deletes it before the exchange.
- **Callback checks, in order:**
  1. The `state` record must exist; otherwise the callback is ignored, the URL goes to `/`, and the page continues as a normal load.
  2. RFC 9207 `iss` must equal the record's issuer; otherwise the state is `anonymous` and the code is never exchanged.
  3. The code is exchanged, with a 15 s timeout.
  4. ID-token claims: `iss`, `aud` contains `client_id`, `azp` if present, `nonce`, and `exp`/`iat` within ±60 s of skew. There's no signature check, because the token came straight from the token endpoint over TLS (OIDC Core §3.1.3.7).
  5. In the trial realm, a valid `tenant_id` sets the storage namespace; without one it stays `anon` and an error is logged.
- **Errors:** `?error=` answering a silent attempt (`login_required`, `interaction_required`, `consent_required`) becomes `anonymous { login-required, workspace }`. Any other error becomes `anonymous { none }`.
- **URL:** before `init()` resolves, it is replaced with the record's `returnUrl` (which must be a safe redirect, else `/`).

### 8.4 Silent restore (page load)
A silent restore runs only when all of these hold: no callback; no signed-out mark; the tab's loop guard isn't set; and a cached workspace exists, for the URL's slug or (with no slug) the most recent one.

The loop guard is set, then the page does one top-level redirect with `prompt=none` back to the current URL; `init()` never settles. A successful callback clears the guard. With no restore, the state is `anonymous`: reason `signed-out` when the mark is set, else `none`.

### 8.5 Refresh
- **When:** a timer at `expiresAt − 60 s ± 10 s`, `getAccessToken()` within 5 s of expiry, or `/http`'s 401 path.
- **Single-flight per tab.**
- **Offline before sending:** keep the token and retry on `online`.
- **Refresh token past `refresh_expires_in`:** `expired { serverEnded: false }` without sending.
- **200:** rotate (a response without `refresh_token` keeps the current one); refreshed ID tokens must keep `sub`, and their `nonce` if present.
- **`invalid_grant`:** `expired`, with `serverEnded = now < refreshExpiresAt`.
- **Anything else that may have reached Keycloak:** network error after send, timeout, other errors, an invalid answer. The lineage is dropped, the page waits for `online`, runs `beforeRedirect('restore')`, then does a `prompt=none` redirect. A token that might already be rotated is never re-sent.

### 8.6 Idle timeout
Activity events (`pointerdown`, `keydown`, `wheel`, `touchstart`, `scroll`, capture and passive) write the last-activity time to localStorage, at most every 5 s. Every 15 s (or `idleTimeoutMs` when shorter), each tab compares that shared time with `idleTimeoutMs` (1 min–8 h). Once it's exceeded, the tab rotates the session id and moves to `expired { idle: true }`; `signInAgain` then uses `prompt=login`. Every tab idles out together.

### 8.7 Logout and workspace switch
- **Logout:**
  1. Drop the tokens and stop the timers.
  2. `clearAllAppStorage()`, rotate the session id, and set the signed-out mark.
  3. Broadcast `logout`, set the storage namespace to `anon`, and move to `anonymous { signed-out }`.
  4. **Global** logout only: redirect to the realm's `/logout` with `id_token_hint` (when held), `client_id` and `post_logout_redirect_uri=<origin>/`.
- **Other tabs on `logout`:** become `anonymous { signed-out }`.
- **Other tabs on `workspace-switched`:** become `expired { serverEnded: false, idle: false }`, so the shell's dialog offers sign-in again.
- **The channel** (`BroadcastChannel('platform-auth')`) carries only `{ type }`, never a token.

### 8.8 Step-up
Before an approver action, the UI checks `useStepUp().needed` (`now − auth_time > SessionContext.mfaFreshnessSeconds`). When it's needed, or when a request is denied with `DENY_MFA_STALE`, the UI calls `reauthenticate()`: `prompt=login&max_age`, after `beforeRedirect('step-up')`, returning to the same page. The request isn't retried automatically.

### 8.9 Remote load, chunk errors, app updates
See §5.4.3 and ARCHITECTURE.md § Remote loading.
- **Chunk errors:** `isChunkLoadError` recognises webpack's `ChunkLoadError` and the browsers' dynamic-import failure messages, including inside a `RemoteLoadError`. `reloadOnceForChunkError` reloads at most once per version, guarded by a sessionStorage key; without storage it never reloads.
- **App updates:** `startVersionPolling` fetches `/version.json` every `appUpdate.pollIntervalMs` (default 5 min) and when the page becomes visible. It notifies `subscribeAppUpdate` listeners once per newer version. The first version seen is the baseline when the identity's `buildVersion` is `unknown`.

### 8.10 i18n
- **Setup:** `initializeI18n({ defaultLocale, supported, detect? })` negotiates the locale: the exact tag, then the same language, then the default. It sets `<html lang dir>`.
- **Catalogs:** `registerNamespace(ns, loader)` registers a loader and loads that namespace for the current locale. `initializeI18n` and `setLocale` load every registered namespace for the chosen locale. Concurrent loads of one namespace and locale share one promise, and `subscribeI18n` listeners (`/react`'s `useT`) are notified when they finish. `t(ns, key, vars)` never loads: it looks the key up in the current locale, then the default one, and returns the key itself while no catalog has it.
- **Formatting:** messages use ICU-lite (`{name}`, `{n, plural, …}`, `{x, select, …}`). An invalid message is shown as is, with a dev warning.
- **Lookup:** own properties only, so `constructor` and other prototype keys never resolve.
- **Direction:** `dir` is `rtl` for Arabic, Hebrew, Persian, Urdu and the other right-to-left languages.

---

## 9. Concurrency, Consistency, and Failure Handling

### 9.1 Concurrency model
See ARCHITECTURE.md § Concurrency model. All shared mutable state is on the runtime. Listeners are snapshotted before notify, and a throwing listener never stops the others.

### 9.2 Idempotency of side effects

| Effect | Guard |
|---|---|
| Authorization code exchange | Pending record deleted before the exchange |
| Silent restore | Loop guard (one per tab) |
| Reload on chunk error | Per-version sessionStorage key |
| POST retries | Only with `retry: { unsafe: true }`; every POST carries an `Idempotency-Key` |
| Refresh-token use | Single-flight; never re-sent after an ambiguous failure |

### 9.3 Failure scenarios

| Scenario | Handling |
|---|---|
| sessionStorage blocked | `login()` throws (sign-in impossible, stated). `init()` does no silent restore (the loop guard can't be set) |
| localStorage blocked | Per-page session id; storage in memory; the workspace cache and signed-out mark are not shared |
| Clock skew | ID-token checks allow ±60 s; refresh timing uses `expires_in` relative to the local clock at receipt |
| Collector rejects or times out | Batch counted as failed; never retried |
| Manifest entry invalid | That remote dropped with an error log; the rest load |
| Two SDK majors on one page | Separate runtimes, one error log (identity, session and consent no longer shared) |

### 9.4 Consistency guarantees
- **Session state:** each tab's `SessionState` changes only through its provider. Other tabs follow through the channel (logout, switch), through shared localStorage (idle), or at their own next refresh (a session the server ended).
- **Permissions and flags:** they reflect the last `setAuthzSubject` / `setFlagProvider`; `/react` re-renders on the topic.

---

## 10. Security

### 10.1 Trust boundary
The browser is untrusted. Everything it sends is checked again by the gateway; `/authz`, `/flags` and `useReadOnly` are UI hints only. The SDK protects the user's session and data in the page: tokens, tenant isolation in storage, XSS resistance and redirect safety.

### 10.2 Token handling
- Access, refresh and ID tokens live in one closure in `createOidcProvider`.
- The access token is sent only to the page's own origin.
- The ID token is kept only as the `id_token_hint` for a global logout.
- The access token is never parsed.
- Tokens never reach storage, globals, logs (redaction masks JWT and `Bearer` patterns as a second line of defence) or the BroadcastChannel.

### 10.3 Input validation

| Input | Validation |
|---|---|
| `runtime.json` | zod, strict; exact origins (https, or http on localhost); same-origin paths; bounded numbers |
| Remote manifest | name, entry origin, version pattern, registry domain, SRI format; unknown fields rejected per entry |
| Redirect targets (`returnUrl`, `navigate`) | `isSafeRedirect`: same origin, http(s), no credentials; whitespace, control characters, U+2028/2029 and backslashes refused before parsing |
| Storage keys | non-empty, no control characters, not credential-like |
| Problem bodies | content type, 1 MiB cap, standard members typed, extension names checked |
| PUB-1 result | realm must fit the slug (paid prefix or trial realm) |

### 10.4 Content Security Policy
The SDK works under the CSP of `examples/cloudfront/csp.mjs`:
- `script-src 'self'` and `style-src 'self'`;
- `connect-src 'self' https://auth.bcbpsolutions.com`;
- `require-trusted-types-for 'script'`, with the policies `platform-sdk`, `platform-webpack` and `dompurify`;
- no `eval` anywhere: preset `environment.globalThis`, Zod jitless, `examples:check`.

CSP violations after bootstrap are logged by `installGlobalErrorHandlers` (directive, blocked origin only, essential `warn`). Earlier ones go to `/csp-report`.

---

## 11. Observability of the SDK Itself

### 11.1 Log event catalogue

| Subpath | Level | Message | When |
|---|---|---|---|
| `/http` | warn (essential) | `dropped a forbidden request header` | an identity header was set by the caller (prod; dev throws) |
| `/mfe` | error | `remote dropped from the manifest` | an invalid manifest entry (`remote`, `reason`) |
| `/mfe` | error | `remote failed to load` | `loadRemote` failed, not aborted (`reason`) |
| `/react` | error | `remote failed to render` | a render error in an `MFEErrorBoundary` |
| `/react` | warn | `remote showed an error` | an API error reached a boundary |
| `/react` | error | `uncaught error` · `unhandled promise rejection` | global handlers |
| `/react` | warn (essential) | `content security policy violation` | `securitypolicyviolation` (`violated_directive`, `blocked_uri` origin, `disposition`) |
| `/auth` | warn | `sign-in callback ignored: unknown or expired state` | callback without a valid record |
| `/auth` | error | `sign-in callback rejected: iss does not match the realm` | RFC 9207 check failed |
| `/auth` | error | `sign-in callback rejected` | exchange or ID-token check failed |
| `/auth` | warn | `sign-in failed` | `?error=` on an interactive login |
| `/auth` | error | `silent sign-in could not start` | restore redirect could not be prepared |
| `/auth` | error | `trial ID token has no valid tenant_id: storage stays anonymous` | trial token without `tenant_id` |
| `/auth` | warn | `token refresh outcome unknown: restoring the session` · `token refresh failed: restoring the session` | ambiguous refresh outcome |
| `/auth` | error | `token refresh answer rejected: restoring the session` · `token refresh failed` | invalid refresh answer; unexpected exception |
| `/auth` | info | `session ended` | `invalid_grant` (`server_ended`) |
| `/auth` | warn / error | `workspace resolve failed` · `workspace resolve rejected: realm does not fit the slug` · `workspace not cached: slug and realm do not match` | PUB-1 and cache checks |
| `/auth` | error | `session listener failed` · `beforeRedirect listener failed` | a listener threw |

### 11.2 Metrics (Tier 1, proposed)
The `platform_web_*` metrics (vitals, the HTTP client, remote loads, errors) are recorded through the instrument port. They are no-ops until the names are ratified and the binding ships (§15). The list is in [docs/observability/README.md](../observability/README.md).

### 11.3 Counters for tests and support
`tracingStats()`, `loggingStats()` and `metricsStats()` (internal) count exported items, items dropped because the queue was full or consent was missing, export failures and beacons. `/testing`'s `createTestPlatform` exposes the logs and spans that would have been exported.

---

## 12. Configuration

### 12.1 `runtime.json`

| Key | Default | Rule |
|---|---|---|
| `api.baseUrl` | — (required) | same-origin path |
| `api.timeoutMs` | 35000 | 1 000–300 000 |
| `api.propagationAllowlist` | `[]` | exact origins |
| `telemetry.otlpBaseUrl` | `/otel` | same-origin path |
| `telemetry.sampleRatio` | 0.1 | 0–1 |
| `telemetry.logLevel` | `info` | debug · info · warn · error |
| `telemetry.sendSessionHeader` | `true` | |
| `auth.idpOrigin` | `https://auth.bcbpsolutions.com` | exact origin |
| `auth.trialRealm` | `trial` | kebab slug; must not start with `paidRealmPrefix` |
| `auth.paidRealmPrefix` | `tenant-` | lower-case, ends with `-` |
| `auth.workspacePathPrefix` | `/t/` | same-origin path ending with `/` |
| `auth.clientId` | `tender-web` | OIDC client id |
| `auth.scopes` | `["openid"]` | must include `openid` |
| `auth.idleTimeoutMs` | — (required) | 60 000 – 8 h (the refresh token's idle lifetime) |
| `auth.redirectPath` | — (required) | same-origin path |
| `flags` | `{}` | name → boolean / string / finite number |
| `remotes.killSwitch` | `[]` | remote names |
| `remotes.loadTimeoutMs` | — (required) | 1 000–120 000 |
| `remotes.retries` | — (required) | 0–5 |
| `remotes.allowedOrigins` | `[]` | exact origins |
| `i18n.defaultLocale`, `i18n.supportedLocales` | — (required) | canonical BCP 47; the list includes the default |
| `appUpdate.pollIntervalMs` | — (required) | 10 s – 24 h |

### 12.2 Build-time constants (shell)
`__ENVIRONMENT__` and `__BUILD_VERSION__` (webpack `DefinePlugin`) feed `initializeCore`. The SDK's own `__SDK_VERSION__` is defined when the SDK is built.

### 12.3 Reserved browser storage keys

| Key | Area | Owner |
|---|---|---|
| `@platform/frontend-sdk:session-id` | local | `/core` |
| `@platform/frontend-sdk:workspaces` | local | `/auth` (workspace cache) |
| `@platform/frontend-sdk:auth:signed-out` | local | `/auth` |
| `@platform/frontend-sdk:auth:last-activity` | local | `/auth` |
| `@platform/frontend-sdk:auth:pending:<state>` | session | `/auth` |
| `@platform/frontend-sdk:auth:restore-attempt` | session | `/auth` (loop guard) |
| `@platform/frontend-sdk:chunk-reload` | session | `/mfe` |
| `<namespace>:<appId>:<key>` | both | `/storage` (cleared by `clearAllAppStorage`) |

---

## 13. Build Tooling Packages

### 13.1 `@platform/webpack-preset`

| Export | Behaviour |
|---|---|
| `platformShared` | `react`, `react-dom` (pins from the preset's `package.json`, equal to the SDK's peer ranges), `@opentelemetry/api` `~1.10.0`, `@platform/frontend-sdk` and every subpath except `/testing` under `^<major>.0.0-0`: all `singleton`, `strictVersion` |
| `sharedFor('shell' \| 'remote')` | shell: `eager: false`; remote: the SDK with `import: false` |
| `containerName(remote)` | name with `-` → `_`; refuses `shell` and invalid names (the same rule as `loadRemote`) |
| `platformWebpackConfig({ role, name?, exposes?, mode })` | Module Federation plugin (remote: `var` library named `containerName`, `remoteEntry.js`); `publicPath: 'auto'`; content hashes in production; `trustedTypes: { policyName: 'platform-webpack' }`; `crossOriginLoading: false`; `environment.globalThis: true`; devtool `hidden-source-map` (production) / `cheap-module-source-map`, never eval |

The SDK subpaths and share range come from `src/generated/sdk.ts`, which `pnpm exports:sync` generates from `subpaths.json`.

### 13.2 `@platform/eslint-plugin`

| Rule | Reports |
|---|---|
| `no-sdk-root-import` | `import` / `export … from` / `import()` / `require()` of `@platform/frontend-sdk` |
| `no-sdk-deep-import` | any SDK specifier that is not a public subpath (or `package.json`) |
| `no-identity-headers` | a forbidden header in a `headers: {}` object, `new Headers({})`, or `.set` / `.append` (list generated from the contracts) |
| `no-raw-storage` | global `localStorage` / `sessionStorage` (also via `window`, `globalThis`, `self`) |
| `no-unsafe-html` | `innerHTML` / `outerHTML` assignment, `insertAdjacentHTML`, or `dangerouslySetInnerHTML` without `sanitizeHtml(…)` (configurable); `document.write` |
| `no-runtime-css-in-js` | `@emotion/*`, `styled-components`, `@mui/*`, `@stitches/react`, `goober`, `styled-jsx`, `@vanilla-extract/dynamic` (written exceptions via `allow`) |
| `api-route-template` | an `ApiClient`-style `get/post/put/patch/delete` whose path is a template literal with expressions or a `+` concatenation starting with `/` |

`configs.recommended` turns all seven on as errors, plus `no-eval`, `no-implied-eval` and `no-new-func`.

---

## 14. Release, Distribution and Testing

### 14.1 Release
The packages are released together with one version (changesets `fixed`):
1. A release PR runs `pnpm changeset version`.
2. The merge commit is tagged `vX.Y.Z`.
3. `release.yml` verifies the tag (on `main`, versions equal to the tag, CHANGELOG sections present) and reruns every CI gate at the tag.
4. It publishes a GitHub Release with the three tarballs, a CycloneDX SBOM, and `checksums.txt` with a Cosign keyless signature bundle.

There's no npm registry yet. Pre-release tags (`v1.0.0-alpha.N`) are marked as pre-releases.

### 14.2 Compatibility
- **During the alpha:** breaking changes bump `N` and are listed in the CHANGELOG. Remotes share the SDK under `^1.0.0-0`.
- **From `1.0.0`:** SemVer is strict. A remote built for another major fails share negotiation, and that failure stays inside its boundary.

### 14.3 Testing
See ARCHITECTURE.md § Testing strategy. Key guarantees under test:
- the Keycloak fake revokes the whole session on any refresh-token reuse, and the tests assert no reuse across tabs and refresh failures;
- tokens never appear in storage or the channel;
- every redaction, identity, header and problem fixture shared with Go and Python passes;
- the tarballs install and typecheck in an empty project.

---

## 15. Open Items

| Item | State | Effect until closed |
|---|---|---|
| Tier 1 `platform_web_*` metrics (design step 15) | Waiting on governance ratification (§D5, §D6 K) | The instrument port is a no-op; `startWebVitals` records nothing |
| OTLP → Prometheus name translation check for `platform_web_*` | Deferred to step 15 | — |
| npm registry for the packages | Not chosen (GitHub Release only) | Consumers install from release tarballs |
| `createTestPlatform` option for remote → domain (`remotes`) | Proposed, not in §C1 | A remote's own tests cannot register Tier 2/3 metrics under its `ownerDomain` |
| changesets v3 `pre.json` format | `changeset status` rewrites `.changeset/pre.json`; versioning is unaffected | Leave the committed file until the next `changeset version` |
