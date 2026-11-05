# platform-reactcommon — Low-Level Design

## Tender Management SaaS Platform — Shared Frontend Libraries

| | |
|---|---|
| Packages | `@bcbp-solutions-fzc-llc/frontend-sdk` · `@bcbp-solutions-fzc-llc/webpack-preset` · `@bcbp-solutions-fzc-llc/eslint-plugin` (one version, changesets `fixed`) |
| Version | `1.0.0-alpha.3` (tag `v1.0.0-alpha.3`, 2026-11-04, GitHub Packages, dist-tag `alpha`), after `1.0.0-alpha.1` (the first release) and `1.0.0-alpha.2` on 2026-11-03; `1.0.0-alpha.N` until the first end-to-end environment. This LLD also describes `[Unreleased]` in `CHANGELOG.md` (to ship as `1.0.0-alpha.4`, not yet released; breaking: shell and remotes upgrade together, §14.2) |
| Runtime | Evergreen browsers (ES2022, Trusted Types where supported); build tooling on Node ≥ 22 |
| Peers | `react` / `react-dom` `^19.0.0` (one major; floor tested in CI), `@opentelemetry/api` `~1.10.0`, `webpack` `^5.100.0`, `@rspack/core` `^2.2.0`, `@rsbuild/core` `^2.2.0` (the preset's bundler peers, each optional: an app installs the one it builds with; `/rsbuild` uses the Rspack inside `@rsbuild/core`), `eslint` `^9 \|\| ^10` |
| Design record | [`docs/design/frontend-sdk-design.md`](../design/frontend-sdk-design.md) (decisions, public API per subpath, contracts, backend changes) |
| Architecture | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) (diagrams, invariants, threat model) |

### Revision history

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-31 | First LLD, written from the implementation of design-doc steps 0–14 plus the `portal` domain and the CI pipeline (all on `main`). Step 15 (Tier 1 metric binding) is open; see §15 |
| 1.1 | 2026-11-03 | Aligned with the first release `1.0.0-alpha.1`: GitHub Packages distribution and its publish gate (§14.1), React 19 only, sign-out global by default (§8.7), one keepalive budget for all three signals on hide and `pagehide` (§7.5), metrics sent on page hide (§7.3), the reference two-tier Collector (§7.6), the test layers and nightly integrated run (§14.3), open items (§15) |
| 1.2 | 2026-11-03 | `@bcbp-solutions-fzc-llc/webpack-preset` supports Rspack 2 (`/rspack`) and Rsbuild 2 (`/rsbuild`) besides webpack 5, interoperable over the v1 Module Federation protocol (§13.1), released in `1.0.0-alpha.2` |
| 1.3 | 2026-11-05 | Aligned with `[Unreleased]` (`1.0.0-alpha.4`, PRs #41–#46): container global `__platform_mfe_<name>` and `SdkVersionPlugin` (§13.1), prefixed `/storage` keys (§4.4), refresh backoff on 429 / 503 + `Retry-After` (§8.5), sign-out by form POST and dropping the user's page state (§8.7), whole-attempt remote timeout and fetch timeouts (§5.4.3, §8.9), synthetic 502s and byte bodies (§5.4.1), boundary `resetKeys` (§5.4.4), the global error rate limit (§11.1), Tier 3 label limit and the Collector's label bounds (§7.3, §7.6), CSS SRI (§13.1), runtime sharing per pre-release (§6.1), open items (§15) |

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
- **Build tooling:** the Module Federation shared map and CSP-safe output (`@bcbp-solutions-fzc-llc/webpack-preset`, for webpack 5, Rspack and Rsbuild), and lint rules for consumers (`@bcbp-solutions-fzc-llc/eslint-plugin`).

### 2.2 Out of scope (owned elsewhere)

| Concern | Owner |
|---|---|
| Token validation, identity headers, authorization decisions | API gateway: Envoy `jwt_authn` + IAM AuthZ Enrichment (`ext_authz`) |
| Realms, the `tender-web` client, token lifetimes, rotation settings | IAM realm provisioner (RP #41) |
| PUB-1 (tenant resolve) and P-35 (session context) | iam-org-membership. The shell implements the SDK's ports over the `ApiClient` |
| Ratifying `platform_web_*` metrics | Observability governance (§D5, §D6 K) |
| Collector, Loki, Tempo, Mimir, Grafana, alert routing | Platform observability |
| CloudFront, S3, WAF, deploys | Infrastructure (`examples/cloudfront` documents the requirements) |
| UI components, design system | `@bcbp-solutions-fzc-llc/ui` (not this repo) |

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
    frontend-sdk/             @bcbp-solutions-fzc-llc/frontend-sdk
      src/<subpath>/index.ts    17 subpaths; index.ts is the only public surface of each
      src/internal/             runtime registry, events, instrument port, batcher, online,
                                redirect, locale, session, ids, urls, generated/ (contracts as TS)
      src/root.ts               the "." entry: throws (no barrel)
      contracts/                generated, committed (never edited)
      api/                      api-extractor report per subpath
      subpaths.json             subpaths, layers, allowed imports (single source)
    webpack-preset/           @bcbp-solutions-fzc-llc/webpack-preset (src/generated/sdk.ts generated)
    eslint-plugin/            @bcbp-solutions-fzc-llc/eslint-plugin  (src/generated/{sdk,forbidden-headers}.ts generated)
  test/                       unit/<subpath>, integration, e2e, smoke, fixtures, testenv (as platform-gincommon);
                              browser/ (Playwright, three engines, production CSP); collector/ (the reference
                              Collector in its image, Docker); stack/ (the production-like stack, Docker)
  examples/shell, examples/remote-tenders, examples/cloudfront
  examples/collector/         reference two-tier OTel Collector configuration (gateway.yaml, aggregator.yaml)
  docker/, docker-compose.yml the integrated stack (Keycloak, Envoy, IAM services, floci, Collectors)
  monitoring/                 the Tier 1 proposal, Grafana dashboard, Prometheus rules (proposed)
  scripts/                    sync-contracts, sync-exports, sync-docs, api-report, metrics-parity,
                              metrics-proposal, check-examples, check-publish (pure logic in scripts/lib, unit-tested)
  docs/                       design/, architecture/, lld/, observability/, problem-details/, e2e/, areas/
  .github/                    ci.yml, release.yml, validate-*.yml, changelog-check.yml, stack-nightly.yml;
                              scripts/ (shell logic, incl. check-npm-environment.sh)
  .claude/                    Claude Code reference set (CLAUDE.md and topic files)
```

`src/internal/` also holds `unload` (the page's keepalive budget for hide and `pagehide`, §7.5), `environments` (which environments are local), `reload` (the listeners run before an SDK-started reload, §8.9) and `retry-after` (`Retry-After` parsing for `/http` and the refresh backoff). `urls` holds `stripUrlQueries` (§7.2). Each package's tarball carries a `README.md` and `engines.node` `>=22`.

### 3.1 Library dependencies (direct, `@bcbp-solutions-fzc-llc/frontend-sdk`)

| Dependency | Used by | Why |
|---|---|---|
| `@opentelemetry/sdk-trace`, `sdk-logs`, `sdk-metrics` (OTel JS 3), `exporter-*-otlp-http` (0.300), `otlp-transformer`, `resources`, `core` | `/tracing`, `/logging`, `/metrics` only | OTLP/HTTP export; one pipeline, no Faro |
| `@opentelemetry/api` `~1.10.0` (peer, shared singleton) | the three telemetry subpaths | OTel JS 3 requires `>=1.10 <1.11`; one global API per page |
| `zod` 4 (`zod/mini`, jitless) | `/config` | Strict runtime-config validation; `zod/mini` keeps `/config` at about 11 KB gzipped (classic Zod: 93 KB) |
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
| Collector | OTLP/HTTP JSON on `/otel/v1/{traces,logs,metrics}`; on hide and `pagehide` one keepalive budget for all three signals (§7.5); the reference configuration is two-tier (§7.6) |

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

The **RUM session id** is a random v4 UUID kept in localStorage under `@bcbp-solutions-fzc-llc/frontend-sdk:session-id`, so it is shared by tabs and survives reloads. It is rotated on logout and idle timeout and after 24 hours (`@bcbp-solutions-fzc-llc/frontend-sdk:session-started`), and falls back to a per-page id when storage is blocked. It is sent as `x-session-id` and logged as `session_id`. It is never the IdP session.

### 4.2 Runtime configuration (`/config`)

`loadRuntimeConfig()` fetches `/config/runtime.json` with `cache: no-cache`, within `timeoutMs` (default 10 s, an integer from 1 to 2 147 483 647, else a `RangeError`; combined with the caller's `signal`; a timeout is a `RuntimeConfigError`). `RuntimeConfigSchema` (zod, strict at every level: an unknown key fails) parses it, and the result is deep-frozen. `setRuntimeConfig()` publishes it on the runtime; `getConfig()` throws `NotInitializedError` before that, and `tryGetConfig()` returns `undefined`. Fields and defaults are listed in §12.1. Zod runs in **jitless** mode: its first-parse `new Function('')` probe would otherwise fire a CSP violation on every page load.

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

Keys are `@bcbp-solutions-fzc-llc/frontend-sdk:storage:<namespace>:<appId>:<key>` (the prefix the SDK's other keys use). The namespace (set by `/auth` at login, on the runtime) is:
- the realm, for a paid workspace;
- `trial:<tenant_id>`, for the shared trial realm;
- `anon`, when there is no session, or for a trial token without a valid `tenant_id`.

`set` in `anon` is a no-op with a dev warning. Keys that look like credentials (`isSensitiveKey`: the redaction contract's key list, substrings and `*_key`) throw `ForbiddenStorageKeyError`. Storage that is unavailable or full falls back to an in-page map. `clearAllAppStorage()` removes every key with that prefix in both areas (never another library's keys), and keeps the SDK-reserved keys (session id, workspace cache, auth marks).

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

- Subpath imports only; `import '@bcbp-solutions-fzc-llc/frontend-sdk'` throws.
- Every public symbol is in `api/<subpath>.api.md`. A change is a reviewed diff plus a changeset and a `CHANGELOG.md` entry.
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
| `/react` | `PlatformProvider` · `useSession` · `useCurrentUser` · `useWorkspace` · `useSessionContext` · `useBeforeAuthRedirect` · `useReadOnly` · `useStepUp` · `useLocale` · `useSwitchWorkspace` · `useFeatureFlag` · `useHasPermission` · `Can` · `useApi` · `useApiClient` · `useRouteTemplate` · `useOnlineStatus` · `useAppUpdate` · `useSignOut` · `useT` · `MFEErrorBoundary` · `RemoteBoundary` · `installGlobalErrorHandlers` · types `ShellContextValue`, `ErrorInfoView` |
| `/testing` | `createTestPlatform` (`signOuts`, `reset`) · `mockApi` · `mockProblem` · `renderMetricInventory` · types `LogRecord`, `SpanRecord` |

### 5.4 Key behaviour specifications

#### 5.4.1 `ApiClient` calls

| Aspect | Behaviour |
|---|---|
| URL | `baseUrl` (default `api.baseUrl`) + template. A template is a path (`/…`) with no query, fragment, whitespace or `..`; every `:name` needs a non-empty param (URL-encoded), and an unused param is an error (`TypeError`). `query` values are appended encoded; `undefined` is skipped |
| Body | `string`, `FormData`, `Blob`, `URLSearchParams`, `ArrayBuffer` as is; anything else JSON with `content-type: application/json` |
| Accept | `application/json, application/problem+json` |
| Deadline | `timeoutMs` (default `api.timeoutMs`, 35 000 ms; above gincommon's 30 s server timeout), per attempt, combined with the caller's signal |
| Retries | `GET`, `PUT`, `DELETE` (or `retry: { unsafe: true }`): up to `attempts` (default 2, at most 5) more, on timeout, network error (online), 429, 502, 503, 504; wait `Retry-After` (≤ 30 s) else full-jitter `min(5 s, 250 ms · 2ⁿ)`; `retry: false` disables |
| Unusable answers | A 2xx body that is not the JSON it claims, or a redirect on a call carrying a token or correlation headers (`redirect: 'manual'`), is a synthetic 502 `ProblemError`. Typed arrays and DataViews are sent as bytes; a `ReadableStream` body is refused (not replayable) |
| 401 | Once per call: if a newer token exists use it, else join the tab's `refresh()`; a new token retries (not counted as a retry); otherwise `onUnauthorized()` |
| De-duplication | `GET` (unless `dedupe: false`): identical URL + token + headers share one call; the shared fetch is aborted only when every subscriber aborted |
| Result | `{ data, status, headers, requestId, traceId? }`; `data` is JSON when the content type says so, text otherwise, `undefined` for 204/205/empty |
| Errors | `ProblemError` (non-2xx), `TimeoutError`, `NetworkError { offline }` (offline fails at once, no fetch), `AbortedError` |

#### 5.4.2 `IdentityProvider` (`createOidcProvider`)

| Method | Behaviour |
|---|---|
| `init()` | Handles a callback (§8.3), else attempts one silent restore per tab (§8.4); resolves only to `authenticated` or `anonymous`; called twice → the same promise |
| `login({ workspace, returnUrl?, loginHint?, prompt? })` | Pending record + PKCE + `beforeRedirect('login')` + top-level redirect; throws when sessionStorage is unavailable |
| `getAccessToken()` | `undefined` when anonymous, expired or restoring; joins the refresh when within 5 s of expiry, and waits out a refresh backoff (§8.5) instead of failing |
| `refresh()` | Single-flight; `true` with new tokens, `false` otherwise (state already moved, §8.5); a 429 / 503 + `Retry-After` backoff is awaited inside it |
| `logout({ global? })` (global unless `global: false`) | §8.7 |
| `switchWorkspace(w)` | Local logout of the current realm without the signed-out mark, broadcast `workspace-switched`, then `login(w)` with reason `switch` |
| `reauthenticate({ maxAgeSeconds, returnUrl? })` | `prompt=login&max_age=<s>` with reason `step-up`; needs a session |
| `needsStepUp(s)` | `now − auth_time > s`; `false` when `auth_time` is unknown |
| `subscribe` / `beforeRedirect` / `getState` | Listeners isolated (a throwing one is logged, others still run) |
| `dispose()` (optional) | Stops the provider without signing out: closes the cross-tab channel, clears timers and listeners, forgets the tokens. For hot module replacement and tests |

#### 5.4.3 `loadRemote(name, module, { timeoutMs?, retries?, signal? })`

The steps:
1. Kill switch → `RemoteDisabledError`.
2. Otherwise, up to `1 + retries` attempts (default `remotes.retries`), each with `timeoutMs` (default `remotes.loadTimeoutMs`) for the whole attempt: the entry script, the share-scope `init` and the module's `get`. `loadManifest` uses the same timeout; the container cache is on the runtime.
3. Initialize the share scope (an already-initialized scope is fine; any other failure is `incompatible` and not retried).
4. `container.get(module)`, then the factory.

Any failure is a `RemoteLoadError` carrying the cause. One span `remote load` and one metric observation per call.

#### 5.4.4 Error boundaries

`MFEErrorBoundary { mfe, fallback?, resetKeys? }` sets the MFE scope for its subtree. Its error is cleared by retry, and when `mfe` or any of `resetKeys` changes (`RemoteBoundary`: `remote` or `module`).
- **On catch:**
  1. It counts `platform_web_errors_total{ source: boundary or chunk_load }`.
  2. A chunk-load error reloads the page once per version.
  3. Otherwise it logs: an API error as `warn` (the server answer is already traced), anything else as `error`.
- **Fallback view:** `{ message, traceId?, requestId?, retry }`; the default fallback takes focus. The message is `problemMessage` for problems; otherwise a `platform` catalog text (with an English default) for "unexpected", "unavailable" (kill switch) and "offline".
- **`RemoteBoundary`** creates a new lazy component per retry, because React caches a rejected lazy forever.
- An error thrown in the same update that changes `resetKeys` is caught and logged once.

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
| `beforeReload` (listeners) | `src/internal/reload` (`/react` `useBeforeAuthRedirect`) | `/mfe` and `/react` before an SDK-started reload |
| `readOnlyDenied` | `/http` | `/react` `useReadOnly` |
| `events` (topic → listeners) | `src/internal/events` | `/react` |
| `unload` (senders, keepalive ledger, reservations, metrics share) | `src/internal/unload` | `/tracing`, `/logging`, `/metrics` |

Created on first use on `globalThis[Symbol.for('@bcbp-solutions-fzc-llc/frontend-sdk')]`. A second SDK copy logs one error. It binds to the existing runtime when its version is compatible: the same major, or for a pre-release (or `0.x`) the same full version (`1.0.0-alpha.3` and `alpha.4` each keep their own, as two majors do; `compatibilityOf` in `src/internal/runtime.ts`). The container cache, the flag provider's subscription and the before-reload listeners (`beforeReload`) live on the runtime, so a second compatible copy shares them. `resetRuntimeForTests()` exists for tests only.

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
| Export | Drop-oldest batch processor: batch 512, delay 5 s, queue 2048, ≤ 2 sends in flight; spans dropped without `telemetry` consent (counted), queued ones too once it is withdrawn. Hidden: the newest spans that fit what is left of the page budget in one keepalive request, the rest from the next task; `pagehide`: the newest that fit, by `sendBeacon` (else fetch keepalive), started inside the listener, the rest counted in `droppedOnUnload` (§7.5) |
| Context | `StackContextManager` (no zone.js) |

### 7.2 Logs (`/logging`)

Every record carries the envelope `trace_id`, `span_id` (active span), `request_id` (when given), `session_id`, `mfe` (`shell` by default) and `page_route` (a registered template or `unknown`). Caller attributes of the same name are dropped. Attributes go through redaction:
- sensitive keys become `[REDACTED]`;
- JWT and `Bearer` patterns are masked;
- URL query strings and fragments are removed from every token that is a URL or a path (a `/` before its `?` or `#`: absolute URLs, scheme-less hosts such as `bucket.s3.amazonaws.com/k?X-Amz-Signature=…`, relative paths), in the message and every string, as in span names and attributes; prose such as `/help?` is left alone, and the pass is linear (`stripUrlQueries`, `src/internal/urls.ts`);
- stacks are cut to 4 KiB;
- a record's attributes are capped at about 8 KiB (`[TRUNCATED]` past it), so one record always fits the unload budget.

| Level | Leaves the page when |
|---|---|
| `error` | always |
| `warn` | `essential: true`, or `telemetry` consent |
| `info`, `debug` | `telemetry` consent (and `level` allows) |

The export uses batch 50, flush 5 s, queue 1 000 (drop oldest), and at most 2 sends in flight. On page hide and `pagehide`, the newest queued records that fit what is left of the page budget go in one `navigator.sendBeacon`, first among the signals after the metrics share (§7.5); a record too big for it alone is skipped. The rest, and anything the browser refuses, go back to the queue for fetch (a task later when hidden); their estimated size counts against the budget, since the exporter sends them with `keepalive` while the browser allows. Records that needed `telemetry` consent are dropped from the queue, before any send, once it is withdrawn. Before `initializeLogging`, loggers write to the console in `local`/`dev` (and when there's no identity) and are no-ops otherwise.

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

A Tier 3 metric declares at most 8 labels besides `domain`, `service` and `environment` (`MAX_SERVICE_LABELS`, the gateway's per-point limit; more is an `InvalidMetricError`), and its label values are capped at 100 per label, the overflow value being `__other__`. Export uses OTLP/HTTP with **delta** temporality every 60 s, through a consent gate that discards the interval when `telemetry` isn't granted. When the page is hidden or closing, the interval is collected then and sent by `sendBeacon` in the share the logs and spans leave it (§7.5); an empty interval sends nothing, a refused or oversized one goes through the exporter. Up to 1 000 label sets per instrument are kept for `renderMetricInventory()`. `shutdownMetrics` collects and sends the last interval.

### 7.4 Governance and CI

`pnpm metrics:parity` compares the SDK's registration checks with gincommon's `metricslint` case by case (recorded differences are listed in the script). It also runs `metricslint check -strict` on the SDK's rendered inventory.

The proposed Tier 1 browser metrics and their labels are listed in [docs/observability/README.md](../observability/README.md#tier-1-browser-metrics-proposed).

### 7.5 Page hide and unload: one keepalive budget (`src/internal/unload`)

Only keepalive requests (`sendBeacon`, fetch `keepalive`) outlive a closing tab, and the browser allows 64 KiB of their bodies in flight per page. The three signals share **one 60 KiB budget** (`PAGE_KEEPALIVE_BYTES`):

| Element | Behaviour |
|---|---|
| Senders | `onUnload({ priority, send, hide })`: metrics `-1`, logs `0`, spans `1`. One `pagehide` listener and one `visibilitychange` listener run them in priority order, each with what the earlier ones left, so the order the signals were initialised in never decides who gets the budget |
| Ledger | Every keepalive body sent is recorded (`spendKeepalive`) and counted for `KEEPALIVE_IN_FLIGHT_MS` (5 s); `keepaliveLeft()` is the budget minus those and minus active reservations. A `pagehide` right after the hidden phase hands out only what the hidden phase left |
| Metrics share | Metrics are collected asynchronously, so they send last. Their sender only reserves a share synchronously (`reserveKeepalive`), released when the interval is collected; the share is the last interval's size ×1.25, 1–8 KiB (2 KiB before the first) |
| Synchronous starts | Every unload request is started inside the listener: a closing tab may never run a later microtask |

A close as browsers do it (hidden, then `pagehide`) delivers spans, logs and metrics within one budget in Chromium, Firefox and WebKit (`test/browser/keepalive.spec.ts`). Engine limits are recorded in `test/browser/engine-notes.ts`.

### 7.6 Reference Collector (`examples/collector`)

The platform's Collector is deployed elsewhere; this repository ships its **reference configuration**, in two tiers:

| Tier | Does |
|---|---|
| Gateway (`gateway.yaml`, behind `/otel/*`, any number of replicas) | OTLP/HTTP on `/otel/v1/*`; keeps only the SDK's resource attributes on traces and logs (`service.name`, `service.version`, `service.namespace`, `deployment.environment.name`) and none on metrics (labels carry the identity; a version or forged name would split or mint series); allowlists metric names (a Tier 1 name of the proposal, or a `<domain>_*` matching the `domain` label, with a unit suffix), label keys (Tier 1 and Tier 2: the registry's and the proposal's; Tier 3: snake_case, not prohibited, at most 8 besides the const labels) and label values (registry vocabulary, this deployment's environment); `page_route` over 64 characters becomes `unknown`; cuts values at 128 characters; routes each metric stream to one aggregator (`loadbalancing`, `routing_key: streamID`) |
| Aggregator (`aggregator.yaml`) | Re-stamps each delta with its arrival time (device clocks are not trusted), then `delta_to_cumulative` for Mimir. One converter per stream: two Collectors converting the same stream would write conflicting totals |

The allowlists bound what one request adds, not the product of allowed values: set Mimir's per-tenant series limits too (`examples/collector/README.md`). `examples/collector/test` keeps the allowlists equal to the metric registry; `pnpm test-collector` (CI job `collector`) runs two gateways and two aggregators in the Collector image; the integrated stack routes `/otel` through both tiers.

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
  4. ID-token claims: `iss`, `aud` contains `client_id`, `azp` if present, `nonce`. Times are judged on the **provider's clock**: the token came straight from the token endpoint, so its `iat` is the provider's time at receipt, and the device's offset is taken from it (also for `auth_time` and step-up). An offset beyond 10 minutes (`MAX_CLOCK_OFFSET_S`) fails visibly: `anonymous { device-clock }` and an error log with `clock_offset_s` (report Issue 8). There's no signature check, because the token came straight from the token endpoint over TLS (OIDC Core §3.1.3.7).
  5. In the trial realm, a valid `tenant_id` sets the storage namespace; without one it stays `anon` and an error is logged.
- **Errors:** `?error=` answering a silent attempt (`login_required`, `interaction_required`, `consent_required`) becomes `anonymous { login-required, workspace }`. Any other error becomes `anonymous { none }`.
- **URL:** before `init()` resolves, it is replaced with the record's `returnUrl` (which must be a safe redirect, else `/`).

### 8.4 Silent restore (page load)
A silent restore runs only when all of these hold: no callback; no signed-out mark; the tab's loop guard isn't set; and a cached workspace exists, for the URL's slug or (with no slug) the most recent one.

The loop guard is set, then the page does one top-level redirect with `prompt=none` back to the current URL; `init()` never settles. A successful callback clears the guard. With no restore, the state is `anonymous`: reason `signed-out` when the mark is set, else `none`.

### 8.5 Refresh
- **When:** a timer at `expiresAt − lead ± jitter` (lead `min(60 s, lifetime / 3)`, jitter at most `min(10 s, lead / 2)`: a 300 s token at 230–250 s, a 60 s token at 30–50 s), `getAccessToken()` within 5 s of expiry, or `/http`'s 401 path.
- **Single-flight per tab.**
- **Offline before sending:** keep the token and retry on `online`.
- **Refresh token past `refresh_expires_in`:** `expired { serverEnded: false }` without sending.
- **200:** rotate (a response without `refresh_token` keeps the current one); refreshed ID tokens must keep `sub`, and their `nonce` if present.
- **`invalid_grant`:** `expired`, with `serverEnded = now < refreshExpiresAt`.
- **429, or 503 with `Retry-After`** (Keycloak or its gateway refused it without processing it): keep the tokens and retry after a backoff of 2 s doubling to 30 s with jitter, or `Retry-After` when longer, as long as the retry answers 5 s before the access token expires; otherwise restore as below. `getAccessToken()` and a 401 join the backoff instead of sending more. Logged once per retry as `token endpoint unavailable: retrying the refresh`.
- **Anything else that may have reached Keycloak:** network error after send, timeout, other errors (500, 502, 504, a bare 503: a gateway may answer so after Keycloak rotated the token), an invalid answer. The lineage is dropped, the page waits for `online`, runs `beforeRedirect('restore')`, then does a `prompt=none` redirect. A token that might already be rotated is never re-sent.
- **Cancelled by a navigation away:** `beforeunload` or `pagehide` fired while the request was in flight (listened to only then: a standing `beforeunload` listener keeps Firefox from using its back/forward cache). The lineage is dropped, but the restore waits 10 s, which an unloading page never reaches; a page that stays restores then. Restoring at once would send the leaving page to the IdP and replace the user's navigation.

### 8.6 Idle timeout
Activity events (`pointerdown`, `keydown`, `wheel`, `touchstart`, `scroll`, capture and passive) write the last-activity time to localStorage, at most every 5 s. Every 15 s (or `idleTimeoutMs` when shorter), each tab compares that shared time with `idleTimeoutMs` (1 min–8 h). Once it's exceeded, the tab rotates the session id and moves to `expired { idle: true }`; `signInAgain` then uses `prompt=login`. Every tab idles out together.

### 8.7 Logout and workspace switch
- **Logout:**
  1. Drop the tokens and stop the timers.
  2. `clearAllAppStorage()`, rotate the session id, and set the signed-out mark.
  3. Broadcast `logout`, forget the user's page state (storage namespace `anon`, no UI authorization subject, no flag provider, no read-only mark; topics `authz`, `flags`, `read-only` emitted), and move to `anonymous { signed-out }`.
  4. Unless `{ global: false }` (the default is global, report Issue 10): a hidden form's POST to the realm's `/logout` with `id_token_hint` (when held), `client_id` and `post_logout_redirect_uri=<origin>/` in the body (never the URL), ending the SSO session. The shell's CSP `form-action` must allow the IdP origin, or the browser blocks the POST, the SSO session stays alive, and a `content security policy violation` warn is logged. `{ global: false }` is a local-only sign-out: the SSO session stays alive, and the next sign-in on this device is a re-authentication of the previous user (`prompt=login`).
- **Workspace switch:** the same local steps without the signed-out mark (the user's page state is forgotten too), broadcast `workspace-switched`, then `login(w)`.
- **Other tabs on `logout`:** become `anonymous { signed-out }` and forget the user's page state. An `expired` tab does the same; a `loading` tab drops its tokens and storage namespace and discards a sign-in it was finishing.
- **Other tabs on `workspace-switched`:** become `expired { serverEnded: false, idle: false }`, so the shell's dialog offers sign-in again.
- **The channel** (`BroadcastChannel('platform-auth')`) carries only `{ type }`, never a token.

### 8.8 Step-up
Before an approver action, the UI checks `useStepUp().needed` (`now − auth_time > SessionContext.mfaFreshnessSeconds`). When it's needed, or when a request is denied with `DENY_MFA_STALE`, the UI calls `reauthenticate()`: `prompt=login&max_age`, after `beforeRedirect('step-up')`, returning to the same page. The request isn't retried automatically. `needed` turns true when the window lapses while the page stays open (checked every 15 s). A callback whose `auth_time` is still older than `max_age` is logged (`step-up not performed by the identity provider: auth_time is older than max_age`).

### 8.9 Remote load, chunk errors, app updates
See §5.4.3 and ARCHITECTURE.md § Remote loading.
- **Chunk errors:** `isChunkLoadError` recognises webpack's `ChunkLoadError` and the browsers' dynamic-import failure messages, including inside a `RemoteLoadError`. `reloadOnceForChunkError` reloads at most once per version, guarded by a sessionStorage key; without storage it never reloads. Before any SDK-started reload (this one, `useAppUpdate().reload`), the `beforeReload` listeners run synchronously (`src/internal/reload.ts`; `useBeforeAuthRedirect` subscribes), so a draft survives.
- **App updates:** `startVersionPolling` fetches `/version.json` every `appUpdate.pollIntervalMs` (default 5 min) and when the page becomes visible, each fetch with a 10 s timeout; an interval under 1 s is refused (`RangeError`). `loadManifest` times out after `remotes.loadTimeoutMs`. It notifies `subscribeAppUpdate` listeners once per newer version. The first version seen is the baseline when the identity's `buildVersion` is `unknown`.

### 8.10 i18n
- **Setup:** `initializeI18n({ defaultLocale, supported, detect? })` negotiates the locale: the exact tag, then the same language, then the default. It sets `<html lang dir>`.
- **Catalogs:** `registerNamespace(ns, loader)` registers a loader and loads that namespace for the current locale. `initializeI18n` and `setLocale` load every registered namespace for the chosen locale. Concurrent loads of one namespace and locale share one promise, and `subscribeI18n` listeners (`/react`'s `useT`) are notified when they finish. `t(ns, key, vars)` never loads: it looks the key up in the current locale, then the default one, and returns the key itself while no catalog has it. A loader that does not answer within 10 s counts as failed; a failed catalog is retried 2 s, 4 s and 8 s later while its locale is shown.
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
| Refresh-token use | Single-flight; never re-sent after an ambiguous failure; re-sent after 429 or 503 with `Retry-After` (refused unprocessed), with backoff, while the access token is valid; 502, 504 and a bare 503 are ambiguous |

### 9.3 Failure scenarios

| Scenario | Handling |
|---|---|
| sessionStorage blocked | `login()` throws (sign-in impossible, stated). `init()` does no silent restore (the loop guard can't be set) |
| localStorage blocked | Per-page session id; storage in memory; the workspace cache and signed-out mark are not shared |
| Clock skew | ID-token times are judged on the provider's clock (the offset from `iat` at receipt), with 60 s of leeway on `exp`; a device clock up to 10 minutes off is tolerated, beyond that the callback ends in `anonymous { device-clock }`; refresh timing uses `expires_in` relative to the local clock at receipt |
| Collector rejects or times out | Batch counted as failed; never retried |
| Manifest entry invalid | That remote dropped with an error log; the rest load |
| Two incompatible SDK copies on one page (another major, or another pre-release) | Separate runtimes, one error log (`Major (or pre-release) versions differ…`: identity, session and consent no longer shared) |
| Token endpoint shedding load (429, 503 + `Retry-After`) | Tokens kept; refresh retried with backoff while the access token is valid (§8.5) |
| `runtime.json`, manifest, `/version.json` or a catalog stalls | Each fetch times out (§4.2, §8.9, §8.10): the unavailable page, remotes' fallbacks, the next poll, the default-locale text |

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
- `form-action 'self' https://auth.bcbpsolutions.com` (the global sign-out's POST, §8.7);
- `require-trusted-types-for 'script'`, with the policies `platform-sdk`, `platform-webpack` and `dompurify`;
- no `eval` anywhere: preset `environment.globalThis`, Zod jitless, `examples:check`.

CSP violations after bootstrap are logged by `installGlobalErrorHandlers` (directive, blocked origin only, essential `warn`). Earlier ones go to `/csp-report`.

---

## 11. Observability of the SDK Itself

### 11.1 Log event catalogue

| Subpath | Level | Message | When |
|---|---|---|---|
| `/http` | warn (essential) | `dropped a forbidden request header` | an identity header was set by the caller (prod; dev throws) |
| `/http` | warn (essential) | `api call got no response` | a call ended with no HTTP answer: `reason` timeout, or network while online (`method`, `route` template, `request_id`, `mfe`). At most 10 a minute per page; the next one after the window carries `suppressed` |
| `/mfe` | error | `remote dropped from the manifest` | an invalid manifest entry (`remote`, `reason`) |
| `/mfe` | error | `remote failed to load` | `loadRemote` failed, not aborted (`reason`) |
| `/mfe` | warn (essential) | `chunk load failed: reloading` | a chunk of the running build is gone; logged before the one reload per version (`version`, `exception.*`) |
| `/react` | error | `remote failed to render` | a render error in an `MFEErrorBoundary` |
| `/react` | warn | `remote showed an error` | an API error reached a boundary |
| `/react` | error | `uncaught error` · `unhandled promise rejection` | global handlers; at most 10 per signature and 60 per page a minute (shared with the CSP line); the next line of a signature carries `suppressed` |
| `/react` | warn (essential) | `content security policy violation` | `securitypolicyviolation` (`violated_directive`, `blocked_uri` origin, `disposition`) |
| `/auth` | warn (essential) | `sign-in callback ignored: unknown or expired state` | callback without a valid record |
| `/auth` | error | `sign-in callback rejected: iss does not match the realm` | RFC 9207 check failed |
| `/auth` | error | `sign-in callback rejected: the device clock is off` | the ID token's `iat` is more than 10 minutes from the device clock (`clock_offset_s`); the session is `anonymous` with reason `device-clock` |
| `/auth` | error | `sign-in callback rejected` | exchange or ID-token check failed |
| `/auth` | warn (essential) | `sign-in failed` | `?error=` on an interactive login |
| `/auth` | error | `silent sign-in could not start` | restore redirect could not be prepared |
| `/auth` | error | `trial ID token has no valid tenant_id: storage stays anonymous` | trial token without `tenant_id` |
| `/auth` | warn (essential) | `step-up not performed by the identity provider: auth_time is older than max_age` | a step-up callback whose `auth_time` is older than the requested `max_age` (`max_age`) |
| `/auth` | warn (essential) | `token refresh outcome unknown: restoring the session` · `token refresh failed: restoring the session` | ambiguous refresh outcome |
| `/auth` | warn (essential) | `token endpoint unavailable: retrying the refresh` | 429, or 503 with `Retry-After`, on refresh; `status`, `retry_in_ms` |
| `/auth` | error | `token refresh answer rejected: restoring the session` · `token refresh failed` | invalid refresh answer; unexpected exception |
| `/auth` | warn (essential) / info | `session ended` | `invalid_grant`: warn when Keycloak ended a live session (`server_ended: true`), info when the refresh token's lifetime is unknown (`server_ended: false`) |
| `/auth` | info | `token refresh cancelled by a navigation away` | the refresh request failed after `beforeunload`/`pagehide` |
| `/auth` | warn (essential) / error | `workspace resolve failed` · `workspace resolve rejected: realm does not fit the slug` · `workspace not cached: slug and realm do not match` | PUB-1 and cache checks |
| `/auth` | error | `session listener failed` · `beforeRedirect listener failed` | a listener threw |

### 11.2 Metrics (Tier 1, proposed)
The `platform_web_*` metrics (vitals, the HTTP client, remote loads, errors) are recorded through the instrument port. They are no-ops until the names are ratified and the binding ships (§15). The list is in [docs/observability/README.md](../observability/README.md).

### 11.3 Counters for tests and support
`tracingStats()`, `loggingStats()` and `metricsStats()` (internal) count exported items, items dropped because the queue was full or consent was missing, export failures and beacons. `/testing`'s `createTestPlatform` exposes the logs and spans that would have been exported, and `signOuts` (its shell's `signOut`, for `useSignOut`); a new platform stops the previous one (unload listeners, logging, tracing, identity provider).

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
`__ENVIRONMENT__` and `__BUILD_VERSION__` (webpack's or Rspack's `DefinePlugin`, Rsbuild's `source.define`) feed `initializeCore`. The example shell takes the environment from `PLATFORM_ENVIRONMENT`: a production build without it fails (a development build defaults to `dev`); the repository's `pnpm build` passes `dev` when it is unset. The SDK's own `__SDK_VERSION__` is defined when the SDK is built.

### 12.3 Reserved browser storage keys

| Key | Area | Owner |
|---|---|---|
| `@bcbp-solutions-fzc-llc/frontend-sdk:session-id` | local | `/core` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:session-started` | local | `/core` (a new session id after 24 h) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:workspaces` | local | `/auth` (workspace cache) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:signed-out` | local | `/auth` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-activity` | local | `/auth` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-user` | local | `/auth` (SHA-256 of realm + `sub`) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:pending:<state>` | session | `/auth` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:restore-attempt` | session | `/auth` (loop guard) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:chunk-reload` | session | `/mfe` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:storage:<namespace>:<appId>:<key>` | both | `/storage` (cleared by `clearAllAppStorage`) |

---

## 13. Build Tooling Packages

### 13.1 `@bcbp-solutions-fzc-llc/webpack-preset`

| Export | Behaviour |
|---|---|
| `platformShared` | `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client` (pins from the preset's `package.json`, equal to the SDK's peer ranges), `@opentelemetry/api` `~1.10.0`, `@bcbp-solutions-fzc-llc/frontend-sdk` and every subpath except `/testing` under `^<major>.0.0-0`: all `singleton`, `strictVersion` |
| `sharedFor('shell' \| 'remote')` | shell: `eager: false`; remote: the SDK with `import: false` and `requiredVersion: ^<the SDK version it was built against>` |
| `containerName(remote)` | `__platform_mfe_` + the name with `-` → `_` (no element id or browser global shadows it); refuses `shell` and invalid names (the same rule as `loadRemote`) |
| `SdkVersionPlugin` | in every preset (webpack, `/rspack`, `/rsbuild`): fails the build when the SDK installed for the app (found as Node finds it, from the build context) is not the preset's version; no SDK installed, no check |
| `platformWebpackConfig({ role, name?, exposes?, mode })` | Module Federation plugin (remote: `var` library named `containerName`, `remoteEntry.js`); shell: `publicPath: '/'` and bundles under `assets/` (index.html is served for every deep link, so its scripts load from the root; `/assets/*` is the immutable behavior), remote: `publicPath: 'auto'` (chunks relative to its `remoteEntry.js`); content hashes in production; `trustedTypes: { policyName: 'platform-webpack' }`; `crossOriginLoading: 'anonymous'`; `environment.globalThis: true`; in production `ChunkIntegrityPlugin` (sha384 for every lazy JS and CSS chunk, fail-closed; the HTML's scripts and stylesheets pinned; lazy CSS through mini-css-extract-plugin's `beforeTagInsert`, webpack's native CSS `createStylesheet` or Rspack's `RuntimePlugin` `createLink` (`CssExtractRspackPlugin`, native CSS, Rsbuild), and a build whose lazy CSS loader sets no integrity fails); devtool `hidden-source-map` (production) / `cheap-module-source-map`, never eval |
| `/rspack`: `platformRspackConfig(options)` | The same mode, devtool, output and ids as `platformWebpackConfig` (tested equal), with Rspack's `ModuleFederationPluginV1` (the webpack-compatible container and share-scope protocol; Rspack's default plugin is the v2 runtime, which webpack builds and `loadRemote` don't speak), `ProvideSdkRspackPlugin` (shell; resolves each subpath with Rspack's resolver when applied, as its sharing plugins are native), `GlobalThisOnlyPlugin` (rewrites Rspack's global-object runtime to `globalThis`; Rspack keeps a `Function('return this')` fallback whatever `environment.globalThis` says), and the same `ChunkIntegrityPlugin` in production (its script and link hooks come from Rspack's `RuntimePlugin`) |
| `/rsbuild`: `pluginPlatform({ role, name?, exposes? })`, `PlatformPluginOptions`, `PLUGIN_PLATFORM_NAME` (`'platform-preset'`) | An Rsbuild plugin: the Rspack preset, built with the Rspack `@rsbuild/core` bundles, merged into Rsbuild's Rspack config with Rsbuild's mode; `output.environment` keeps Rsbuild's flags plus `globalThis`; `output.assetPrefix` `/` (shell) or `auto` (remote); the preset's file names and devtool win over Rsbuild's defaults. It refuses Rsbuild's own `moduleFederation` option (the v2 protocol) |

Shells and remotes built with webpack and Rspack interoperate: an Rspack shell provides the SDK to a webpack remote and the other way round (tested with real builds). Each entry point loads only its own bundler, in code and in its types: the main entry webpack, `/rspack` `@rspack/core`, `/rsbuild` `@rsbuild/core` (an Rsbuild app needs no `@rspack/core`); the tarball smoke test checks it. `/rspack` also re-exports `containerName`, `platformShared`, `sharedFor`, `integrityOf`, `MISSING_INTEGRITY`, `INTEGRITY_PLACEHOLDER`, `PresetOptions` and `SharedConfig`. The SDK subpaths and share range come from `src/generated/sdk.ts`, which `pnpm exports:sync` generates from `subpaths.json`.

### 13.2 `@bcbp-solutions-fzc-llc/eslint-plugin`

| Rule | Reports |
|---|---|
| `no-sdk-root-import` | `import` / `export … from` / `import()` / `require()` of `@bcbp-solutions-fzc-llc/frontend-sdk` |
| `no-sdk-deep-import` | any SDK specifier that is not a public subpath (or `package.json`) |
| `no-identity-headers` | a forbidden header (list generated from the contracts) as a key of a `headers: {}` object or `x.headers = {}`, in a `new Headers({})` or `new Headers([[name, v]])` (also `[[name, v]]` as `headers`), as the name in `.set` / `.append` (string or template without expressions), or in a computed assignment `h['x-user-id'] = v` |
| `no-raw-storage` | global `localStorage` / `sessionStorage`, also via `window`, `globalThis`, `self`, chains of them (`window.self`), a `const` / `let` alias never reassigned (`const w = window; w.localStorage`) and destructuring (`const { localStorage } = window`) |
| `no-unsafe-html` | without `sanitizeHtml(…)` imported from `@bcbp-solutions-fzc-llc/frontend-sdk/security` (named, aliased or through its namespace; the `sanitizers` option replaces it with names of your own): `innerHTML` / `outerHTML` / `srcdoc` assignment, `setAttribute('srcdoc', …)`, JSX `srcDoc`, `insertAdjacentHTML`, `setHTMLUnsafe`, `parseHTMLUnsafe`, `createContextualFragment`, `parseFromString` (any type: Trusted Types requires TrustedHTML for XML too), `dangerouslySetInnerHTML`; `document.write` / `writeln` always |
| `no-runtime-css-in-js` | `@emotion/*`, `styled-components`, `@mui/*`, `@stitches/react`, `goober`, `styled-jsx`, `@vanilla-extract/dynamic` (written exceptions via `allow`) |
| `api-route-template` | an `ApiClient`-style `get/post/put/patch/delete` whose path is a template literal with expressions or a `+` concatenation starting with `/` |

`configs.recommended` turns all seven on as errors, plus `no-eval`, `no-implied-eval` and `no-new-func`. Each rule's `meta.docs.url` is this section on GitHub (an absolute URL). The plugin is tested with ESLint 10 and, in CI, ESLint 9 (its peer range).

---

## 14. Release, Distribution and Testing

### 14.1 Release
The packages are released together with one version (changesets `fixed`):
1. A release PR runs `pnpm run version-packages` (`changeset version`, the bump, then `exports:sync`, the generated SDK version) and turns `[Unreleased]` in the root `CHANGELOG.md` into the version's section.
2. The merge commit is tagged `vX.Y.Z`.
3. `release.yml` verifies the tag (on `main`, versions equal to the tag, the `CHANGELOG.md` section present) and reruns the CI gates at the tag (all but `browser` and `collector`).
4. `npm-publish` publishes the three tarballs to **GitHub Packages** (`@bcbp-solutions-fzc-llc/*`, dist-tag from `publish:check`: `alpha`, `rc` or `latest`), with a build-provenance attestation each. It runs in the `npm` environment and refuses to publish unless publishing is gated (`.github/scripts/check-npm-environment.sh`): required reviewers, or (this private repository on GitHub Team) the environment accepts only release tags and an active tag ruleset limits creating, moving and deleting `v*` tags to admins and named teams. A version already published with the same integrity is skipped; a different one is refused.
5. It publishes a GitHub Release with the three tarballs, a CycloneDX SBOM, and `checksums.txt` with a Cosign keyless signature bundle. Pre-release tags (`v1.0.0-alpha.N`) are marked as pre-releases.

The first release is `v1.0.0-alpha.1` (2026-11-03); the latest is `v1.0.0-alpha.3` (2026-11-04). `[Unreleased]` (PRs #41–#46) is to ship as `1.0.0-alpha.4`, not yet released. Changesets v3's pre mode moves consumed changesets into `.changeset/pre/`; `changelog-check.yml` recognises that as a release PR.

### 14.2 Compatibility
- **During the alpha:** breaking changes bump `N` and are listed in the CHANGELOG. The shell shares the SDK under `^1.0.0-0`; each remote requires `^<the SDK version it was built against>`. Two pre-release SDK copies share the runtime only at the same version (§6.1).
- **`alpha.4`:** the shell and every remote upgrade together. The container global is `__platform_mfe_<name>` (a remote built with an older preset defines the old one, which the new `loadRemote` does not read); the shell's CSP `form-action` must allow the IdP origin; `/storage` values under the old keys are not read; a Tier 3 metric with more than 8 labels fails registration; `no-raw-storage` and `no-unsafe-html` report more.
- **From `1.0.0`:** SemVer is strict. A remote built for another major fails share negotiation, and that failure stays inside its boundary.

### 14.3 Testing
See ARCHITECTURE.md § Testing strategy. Key guarantees under test:
- the Keycloak fake revokes the whole session on any refresh-token reuse, and the tests assert no reuse across tabs and refresh failures;
- tokens never appear in storage or the channel;
- every redaction, identity, header and problem fixture shared with Go and Python passes;
- the tarballs install and typecheck in an empty project;
- in real engines (`test/browser`): the keepalive budget on tab close, page-lifecycle order, SRI on lazy chunks, Trusted Types;
- the reference Collector in its image (`test/collector`, CI job `collector`): streams routed to one aggregator, totals correct across device clocks, allowlists;
- the integrated deployment (`test/stack`, Docker): Keycloak, Envoy with the real IAM services, the distribution on floci, the two-tier Collector, in three engines. It runs nightly in CI (`stack-nightly.yml`, pinned backend commits or default branches on dispatch; a failing scheduled run opens an issue); results in `docs/e2e/integrated-deployment-report.md`.

---

## 15. Open Items

| Item | State | Effect until closed |
|---|---|---|
| Tier 1 `platform_web_*` metrics (design step 15) | Waiting on governance ratification (§D5, §D6 K) | The instrument port is a no-op; `startWebVitals` records nothing |
| OTLP → Prometheus name translation check for `platform_web_*` | Deferred to step 15 | — |
| Gateway issues from the integrated run (3: Envoy's own errors are not problem+json; 9: JWKS cache on key rotation; 14: `x-request-id` rewritten) | Open with Platform; IAM offers the two-phase key-rotation runbook | The SDK reads the gateway's plain replies as synthetic problems |
| Reference Collector deployment | `examples/collector` is a reference; the platform Collector is deployed by Platform observability | The browser's metrics need the two tiers (§7.6) to aggregate correctly |
| `createTestPlatform` option for remote → domain (`remotes`) | Proposed, not in §C1 | A remote's own tests cannot register Tier 2/3 metrics under its `ownerDomain` |
| changesets v3 pre mode | `changeset version` moves consumed changesets into `.changeset/pre/` instead of deleting them | `changelog-check.yml` accepts that as a release PR; `pnpm changeset pre exit` before `1.0.0` |
| Staging validation on real AWS and Keycloak | Not run: the integrated stack emulates AWS with floci (gaps E-n in `docs/e2e/integrated-deployment-report.md`) | Unverified outside the stack: the global sign-out's form POST under a real CloudFront CSP (`form-action`), CSS SRI served by CloudFront, Chromium's `report-to` (needs valid certificates, E-6) |
| Bundle-size budget | None: no size limit is checked in CI | A dependency or subpath can grow the shell's and remotes' bundles unnoticed |
| Load and soak testing | Not done | Behaviour under sustained traffic (refresh backoff at scale, Collector intake, long-lived tabs) is untested |
| Telemetry export during a Collector outage | Each failed batch is counted and dropped; exports are not paused | A Collector outage costs every tab one failed request per batch until it recovers |
| Design doc §C4 bootstrap diagram | The design record's diagram shows one session-context attempt; the shell retries a transient failure 3 times (§6.2, `examples/shell/src/session-context.ts`) | The diagram is noted, not redrawn |
