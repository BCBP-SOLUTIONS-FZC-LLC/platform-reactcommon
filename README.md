# platform-reactcommon

The platform's shared **frontend SDK for React micro-frontends**: the browser-side system of record for how the shell and every remote identify the page, sign users in, call APIs, handle errors, trace, log, emit metrics, translate, sanitize HTML, load remotes and react to new deployments. It is the frontend counterpart of platform-gincommon:
- the same identity vocabulary and metric registry (Enterprise Platform Observability Standard);
- the same RFC 9457 error contract, header names and redaction rules;
- the same trace sampler.

It is also the browser's side of IAM: Keycloak sign-in with tokens kept in memory only, workspace (realm) choice, session restore, step-up MFA.

**Repository:** `github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon`
**Packages:** `@platform/frontend-sdk` · `@platform/webpack-preset` · `@platform/eslint-plugin`. pnpm monorepo, Node ≥ 22, TypeScript 6, ESM only. One version for all three (`1.0.0-alpha.N` until the first environment). **Never deployed**: consumers install the packages; `examples/` holds a reference shell and remote that are built and checked in CI, never run in production.
**Design:**
- **Decisions:** [`docs/design/frontend-sdk-design.md`](docs/design/frontend-sdk-design.md) is the decision record, including the public API per subpath.
- **Implementation:** [ARCHITECTURE.md](ARCHITECTURE.md) and the [LLD](docs/lld/platform-reactcommon-lld.md) describe what's built.
- **Contracts:** everything backend-shaped is generated from pinned backend commits ([`contracts/`](packages/frontend-sdk/contracts/README.md)).
- **Errors:** every API error is read as an [RFC 9457](docs/problem-details/README.md) problem.

---

## Mental model

| This library owns | It does NOT own |
|---|---|
| The **page identity** (`domain`, `service`, `environment`, `buildVersion`) validated against the platform registry, set once by the shell; remotes are told apart by `mfe` | Which identity a backend service has: gincommon / fastapicommon |
| **Sign-in in the browser**: Authorization Code + PKCE against Keycloak, tokens in a closure (never storage), silent restore, single-flight refresh per tab, idle timeout, logout, workspace switch, step-up | Token validation and identity headers: Envoy `jwt_authn` + IAM AuthZ Enrichment validate the token and inject identity. The browser never sends `x-user-id`, `x-tenant-id`, … |
| **UI permissions** (`hasPermission`, `<Can>`) from the user's roles | Authorization decisions: the gateway and services. UI permissions are hints |
| The **`ApiClient`**: route templates, correlation headers, token only to the page's origin, retries, 401 refresh, RFC 9457 problems | The APIs themselves, rate limiting, CORS (same-origin through CloudFront) |
| **Telemetry export** over OTLP/HTTP to `/otel`: correlated, redacted, consent-gated, bounded queues; registry rules for metrics | The OTel Collector, Tempo, Loki, Mimir, Grafana; ratifying `proposed` metrics (observability governance) |
| **Micro-frontend runtime**: the remote manifest, `loadRemote`, kill switches, chunk-load recovery, new-version detection; the shared-module map (`@platform/webpack-preset`) | CloudFront, S3 and the deploy pipeline (`examples/cloudfront` documents what they must do) |
| **UI support**: i18n (ICU-lite, RTL), formatting, HTML sanitizing, the Trusted Types policy | UI components and the design system (`@platform/ui`) |
| **Per-tenant browser storage** that refuses token-like keys | IAM APIs (PUB-1 resolve, P-35 session context): the shell implements them as ports over the `ApiClient` |

Shell and remotes import **subpaths only** (`@platform/frontend-sdk/http`); the package root throws. Remotes take the SDK from the shell through Module Federation (`import: false`), never bundling it, so the whole page shares one identity, one session, one consent state and one token source.

**Tracing guarantee:** every API call is a span whose `traceparent` the backend continues. The server's `X-Trace-ID` comes back on every response and error, so one trace id finds the browser span, the gateway, the service logs and Tempo.

---

## Why this library exists

Every remote needs the same cross-cutting concerns: who the user is, how to call an API, what an error means, how to log and measure, how not to break under the CSP, and how to fail without taking the shell down. Centralizing them in one library means:

- **One trust model.** Tokens never touch storage, identity headers are never sent, HTML is always sanitized, redirects are always checked. This is implemented and tested once, and enforced in consumer code by `@platform/eslint-plugin`.
- **One error contract.** Every remote reads gincommon's and fastapicommon's problems the same way. Interop tests run the SDK's own parser against both servers.
- **One log and metric vocabulary.** Browser logs carry the same fields as backend logs (`trace_id`, `request_id`, `session_id`), and browser metrics follow the same registry and `metricslint` rules as every service. Cross-tier queries work without translation.
- **One micro-frontend runtime.** Remotes load, fail, recover and update the same way, and share exactly one copy of React, the OTel API and the SDK.

This is enforced structurally:
- **Dependency rules:** the 17 subpaths follow layer rules generated from one file (`subpaths.json`) and checked by ESLint and dependency-cruiser.
- **Generated contracts:** everything backend-shaped is generated from pinned commits, and CI fails on drift.
- **Every PR runs** the coverage gate, API reports, smoke tests of the packed packages and interop tests.

---

## API overview

The source of truth for the public API is [`packages/frontend-sdk/api/<subpath>.api.md`](packages/frontend-sdk/api/) (api-extractor). CI fails when the code drifts from it, and every change needs a changeset. `src/internal`, the test seams and `examples/` are not public.

The 17 subpaths fall into seven functional areas, each with its own page in [`docs/areas/`](docs/areas/README.md).

### Foundation — `/core`, `/config`, `/problem`

| Subpath | Main exports |
|---|---|
| `/core` | `initializeCore`, `getIdentity`, `setConsentProvider`, `hasConsent`, `getSessionId`, `newRequestId`, `sanitizeString`, `sanitizeFields`, `isSensitiveKey`, `DOMAINS`, `ENVIRONMENTS` |
| `/config` | `loadRuntimeConfig`, `setRuntimeConfig`, `getConfig`, `tryGetConfig`, `RuntimeConfigSchema`, `RuntimeConfigError` |
| `/problem` | `ProblemError`, `isProblemError`, `parseProblemResponse`, `PlatformProblemTypes`, `defineProblemType`, `typeForStatus`, `toFieldErrorMap`, `gatewayDenyCode`, `TimeoutError`, `NetworkError`, `AbortedError` |

### Observability — `/tracing`, `/logging`, `/metrics`

| Subpath | Main exports |
|---|---|
| `/tracing` | `initializeTracing`, `getTracer`, `withSpan`, `currentTraceId`, `injectTraceHeaders`, `shutdownTracing` |
| `/logging` | `initializeLogging`, `getLogger({ mfe })`, `setRouteTemplate`, `serializeError` |
| `/metrics` | `initializeMetrics`, `getDomainMeter`, `getServiceMeter`, `startWebVitals`, `InvalidMetricError` |

### Data access — `/http`

| Subpath | Main exports |
|---|---|
| `/http` | `createApiClient({ baseUrl, mfe })` → `get` / `post` / `put` / `patch` / `delete`, `setTokenSource`, `isOnline`, `subscribeOnline`, `FORBIDDEN_REQUEST_HEADERS` |

### Identity & access — `/auth`, `/authz`, `/storage`

| Subpath | Main exports |
|---|---|
| `/auth` | `createOidcProvider` → `init`, `login`, `logout`, `refresh`, `switchWorkspace`, `reauthenticate`, `needsStepUp`, `subscribe`, `beforeRedirect`; `initializeAuth`, `getSession`, `chooseWorkspace`, `rememberWorkspace`, `cachedWorkspace`, `slugFromPath`, `isWrongWorkspace`, `signInAgain`; ports `WorkspaceResolver`, `SessionContextSource` |
| `/authz` | `roleMapAuthorizer`, `setAuthorizer`, `setAuthzSubject`, `hasPermission`, `denyAll` |
| `/storage` | `storage(appId, { area })`, `clearAllAppStorage`, `workspaceNamespace`, `ForbiddenStorageKeyError` |

### Micro-frontend platform — `/mfe`, `/flags`, `/nav` (+ `@platform/webpack-preset`)

| Subpath / package | Main exports |
|---|---|
| `/mfe` | `loadManifest`, `loadRemote`, `RemoteDisabledError`, `RemoteLoadError`, `isChunkLoadError`, `reloadOnceForChunkError`, `startVersionPolling`, `subscribeAppUpdate` |
| `/flags` | `getFlag`, `setFlagProvider`, `runtimeConfigFlagProvider`, `sessionContextFlagProvider`, `isRemoteKilled` |
| `/nav` | `navigate(appId, path)`, `registerNavigator`, `isSafeRedirect` |
| `@platform/webpack-preset` | `platformWebpackConfig({ role, name, exposes, mode })`, `platformShared`, `sharedFor(role)`, `containerName(remote)` |

### UI support — `/i18n`, `/security`

| Subpath | Main exports |
|---|---|
| `/i18n` | `initializeI18n`, `registerNamespace`, `setLocale`, `t`, `problemMessage`, `formatDate`, `formatNumber`, `formatMoney` |
| `/security` | `installTrustedTypesPolicy`, `sanitizeHtml`, `isAllowedOrigin` |

### Developer surface — `/react`, `/testing` (+ `@platform/eslint-plugin`)

| Subpath / package | Main exports |
|---|---|
| `/react` | `PlatformProvider`, `useSession`, `useCurrentUser`, `useWorkspace`, `useSessionContext`, `useApi`, `useApiClient`, `useT`, `useLocale`, `useFeatureFlag`, `useHasPermission`, `Can`, `useStepUp`, `useReadOnly`, `useRouteTemplate`, `useBeforeAuthRedirect`, `useOnlineStatus`, `useAppUpdate`, `useSwitchWorkspace`, `MFEErrorBoundary`, `RemoteBoundary`, `installGlobalErrorHandlers` |
| `/testing` (dev only) | `createTestPlatform`, `mockApi`, `mockProblem`, `renderMetricInventory` |
| `@platform/eslint-plugin` | `configs.recommended`; rules `no-sdk-root-import`, `no-sdk-deep-import`, `no-identity-headers`, `no-raw-storage`, `no-unsafe-html`, `no-runtime-css-in-js`, `api-route-template` |

---

## Input validation

The SDK validates everything that crosses into the page (runtime config, the remote manifest, callbacks, problem bodies) and everything app code hands it (identity, templates, storage keys, redirect targets, metric names). Failures are typed errors with the offending field named, never silent fixes.

An error from an API is always an RFC 9457 problem. A non-problem answer is replaced by one synthesized from the status, and its body is never surfaced:

```json
{
  "type": "https://errors.company.com/platform/validation-failed",
  "title": "Validation failed",
  "status": 400,
  "instance": "/api/v1/tenders/42",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errorCode": "VALIDATION_FAILED",
  "timestamp": "2026-10-30T12:13:47Z",
  "validationErrors": [{ "field": "deadline", "message": "must be in the future" }]
}
```

### Notable validation rules

| Rule | Enforcement |
|---|---|
| The page identity uses the registry vocabulary | `initializeCore`: `domain` ∈ registry domains, `environment` ∈ `local\|dev\|test\|staging\|prod`, service pattern → `InvalidIdentityError`; a different second identity → `IdentityMismatchError` |
| `runtime.json` is strict | Unknown keys rejected at every level; exact origins; same-origin paths; bounded numbers → `RuntimeConfigError` with every offending key path (the bootstrap shows a static "unavailable" page) |
| Identity headers are never sent | `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode` (generated from gincommon + AuthZ Enrichment): dropped with an essential warn log; `TypeError` in local/dev |
| API paths are route templates | `/…` with no query, fragment, whitespace or `..`; every `:name` filled, no unused params → `TypeError`. The template is the metric `route` label |
| Tokens go to the page's origin only | `Authorization` only for same-origin URLs; correlation headers only for the page and exact allowlisted origins |
| Sign-in callbacks are verified | One-time PKCE record per `state` (10-minute expiry), RFC 9207 `iss`, then ID-token `iss` / `aud` / `azp` / `nonce` / `exp` / `iat` (±60 s) → otherwise `anonymous`, the code never exchanged |
| Redirect targets are same-origin | `isSafeRedirect`: http(s), same origin, no credentials; whitespace, control characters, U+2028/2029 and backslashes refused before parsing |
| A workspace's realm fits its slug | Paid `tenant-<slug>` or the trial realm; anything else from PUB-1 is rejected and not cached; realms matching `^[a-z0-9][a-z0-9-]{0,62}$` only |
| Storage never holds credentials | Keys that look like credentials → `ForbiddenStorageKeyError`; writes before sign-in (`anon`) are no-ops |
| Remote entries come from allowed origins | Manifest: name pattern (not `shell`), same origin or exact allowed origin, version pattern, registry `ownerDomain`, SRI format; the origin is checked again before the script is added |
| Metric names and labels follow the registry | `getDomainMeter` / `getServiceMeter`: tier namespace, `_total` / `_seconds` / `_bytes`, prohibited labels and suffixes, registry values and buckets → `InvalidMetricError`; Tier 3 label values capped at 100 (`__other__`) |
| Problem bodies are bounded | Over 1 MiB or not `application/problem+json` → synthetic problem; extension member names validated |

---

## Architecture

```
packages/
  frontend-sdk/        17 subpaths (src/<subpath>/index.ts is the only public surface of each)
    src/internal/      PlatformRuntime registry, change events, instrument port, generated contracts
    contracts/         generated from pinned backend commits; never edited
    api/               api-extractor report per subpath
    subpaths.json      subpaths, layers, functional areas, allowed imports (single source)
  webpack-preset/      Module Federation shared map, CSP-safe output
  eslint-plugin/       consumer lint rules
examples/              shell, remote-tenders, cloudfront (built and checked in CI)
scripts/               contracts, exports, docs, API reports, metrics parity, example checks
docs/                  design · architecture · lld · areas · observability · problem-details
```

Full diagrams: [ARCHITECTURE.md](ARCHITECTURE.md).

### Dependency rules

Six layers, generated from `subpaths.json` into ESLint (`eslint-plugin-boundaries`, `no-restricted-imports`) and dependency-cruiser, and checked in CI:

```
L0  core · problem · authz          L3  http · flags · i18n
L1  config · security · storage     L4  auth · mfe · nav
L2  tracing · logging · metrics     L5  react · testing
```

- **Imports:** a subpath imports only the subpaths below it that it lists, and only through their `index.ts`. `/auth` never imports `/http`: `/http` gets tokens through the `TokenSource` port.
- **Third-party packages:** only `/react` and `/testing` import React; only `/tracing`, `/logging` and `/metrics` import OpenTelemetry.
- **Shared state:** subpaths never read each other's module state. They share state through the `PlatformRuntime`.

### Runtime components

| Component | Responsibility |
|---|---|
| `PlatformRuntime` (`globalThis[Symbol.for('@platform/frontend-sdk')]`) | One registry per page (identity, consent, config, session, token source, flags, permissions, manifest, i18n, change listeners) shared by every SDK copy; a second copy logs one error and binds to it when the major matches |
| OIDC provider (`/auth`) | Holds tokens in a closure; per-tab refresh lineage; `BroadcastChannel('platform-auth')` for `logout` / `workspace-switched` (never a token) |
| Export pipelines (`/tracing`, `/logging`, `/metrics`) | OTLP/HTTP to `/otel`; drop-oldest bounded queues; consent gates; beacon on page hide |
| Instrument port (`src/internal/instruments.ts`) | Where `/http`, `/mfe` and `/react` record platform metrics without importing names; a no-op until the Tier 1 names are ratified |

### Sibling platform libraries

| Library | Relationship |
|---|---|
| platform-gincommon | Source of the registry, problem types and rules, header names, redaction rules, log fields and the trace sampler's algorithm (generated contracts); `metricslint` runs in `metrics:parity` |
| platform-fastapicommon | Same problem and registry contract; its vendored registry is compared for drift |
| platform-interop-tests | Shared fixtures (headers, identity, redaction, problem bodies) and pair 4: the SDK's `/http` + `/problem` against live Go and Python servers |
| iam-authz-enrichment, iam-org-membership | Gateway deny codes and injected headers; PUB-1 / P-35 response shapes (contract cases checked against the swagger) |

---

## Integrating into a consuming app

### 1. Prerequisites

- **Toolchain:** React 18.3+ or 19, webpack 5 with Module Federation, Node ≥ 22 for builds.
- **Packages:** `@platform/frontend-sdk`, plus `@platform/webpack-preset` and `@platform/eslint-plugin` as dev dependencies. They're published as GitHub Release tarballs (see [Releases](#releases)).
- **Hosting:** the app is served behind the platform's CloudFront distribution: same-origin `/api`, `/otel`, `/config/runtime.json`, `/remotes/`, and the response headers of [`examples/cloudfront`](examples/cloudfront/README.md) (the CSP with the three Trusted Types policies).

### 2. Shell

The shell runs the bootstrap once, in this order (design doc §C2; [`examples/shell/src/bootstrap.tsx`](examples/shell/src/bootstrap.tsx) is the full code). The essentials:

```ts
installTrustedTypesPolicy();
initializeCore({ serviceName: 'web-app', domain: 'portal', environment: __ENVIRONMENT__, buildVersion: __BUILD_VERSION__ });
const cfg = await loadRuntimeConfig();
setRuntimeConfig(cfg);
setConsentProvider(cmp);
initializeTracing({ otlpBaseUrl: cfg.telemetry.otlpBaseUrl, sampleRatio: cfg.telemetry.sampleRatio, propagationAllowlist: cfg.api.propagationAllowlist });
initializeLogging({ otlpBaseUrl: cfg.telemetry.otlpBaseUrl, level: cfg.telemetry.logLevel });
initializeMetrics({ otlpBaseUrl: cfg.telemetry.otlpBaseUrl });
installGlobalErrorHandlers();

const idp = createOidcProvider(cfg.auth, workspaceResolver);
setTokenSource(initializeAuth(idp));
const session = await idp.init();             // may redirect once (prompt=none) and never settle
// anonymous → signed-out screen / login-required → idp.login / none → chooseWorkspace ?? identifier screen
// authenticated → session context → authorizer, flags, rememberWorkspace → i18n → loadManifest → render
```

Its webpack config is `platformWebpackConfig({ role: 'shell', mode })`.

### 3. Remote

```tsx
// webpack: platformWebpackConfig({ role: 'remote', name: 'tenders', exposes: { './EditTender': './src/EditTender.tsx' }, mode })
export default function EditTender({ id }: { id: string }) {
  return (
    <MFEErrorBoundary mfe="tenders">
      <EditTenderForm id={id} />
    </MFEErrorBoundary>
  );
}

function EditTenderForm({ id }: { id: string }) {
  useRouteTemplate('/tenders/:id/edit');
  const t = useT('tenders');
  const canEdit = useHasPermission('update', 'tender');
  const { data, error, loading } = useApi((c, signal) => c.get<Tender>('/tenders/:id', { params: { id }, signal }), [id]);
  if (loading) return <p>{t('loading')}</p>;
  if (error) throw error;                     // the boundary shows traceId / requestId
  return <TenderForm tender={data} readOnly={!canEdit} />;
}
```

A remote never initializes anything; it reads the shell's state. The shell renders it with `<RemoteBoundary remote="tenders" module="./EditTender" props={{ id }} />`. Full example: [`examples/remote-tenders`](examples/remote-tenders/src/EditTender.tsx).

### 4. Implementing the IAM ports (shell)

`/auth` never calls IAM directly. The shell implements two ports over the `ApiClient` ([`examples/shell/src/iam.ts`](examples/shell/src/iam.ts)), tested against the contract cases:
- **`WorkspaceResolver`:** PUB-1 `GET /api/v1/public/tenants/resolve?identifier=` → `Workspace`. A `shared` strategy is the trial realm; a paid slug is the realm after `tenant-`; `tenant_id` becomes `tenantIdHint`.
- **`SessionContextSource`:** P-35 `GET /api/v1/me/session-context` → `SessionContext` (snake_case → camelCase, lists never null).

### 5. API calls

Use `useApi` / `useApiClient` (React) or `createApiClient({ mfe })`. Always use templates plus `params` and `query`; never build URLs (the `api-route-template` lint rule).
- **`POST`:** each one carries an `Idempotency-Key`. Opt into retries for a non-idempotent call with `retry: { unsafe: true }` only when the server honours the key.
- **Large responses:** pass `dedupe: false` to opt out of GET de-duplication.

### 6. Custom metrics

```ts
getServiceMeter({ mfe: 'tenders' })
  .counter('tender_management_tenders_drafts_saved_total', 'Drafts saved.', ['outcome'])
  .add(1, { outcome: 'ok' });
```

- **Naming:** Tier 3 names are `<ownerDomain>_<remote>_*`. Tier 2 (`getDomainMeter`) accepts only registry entries for the remote's domain.
- **Labels:** never use user, tenant or request ids as labels; registration rejects them.
- **CI:** pipe `renderMetricInventory()` (from `/testing`) to gincommon's `metricslint check`.

### 7. Tracing and logging outside components

`getLogger({ mfe })` and `getTracer(scope)` / `withSpan(name, fn)` work anywhere. Logs carry the active trace, and `attrs.request_id` links a log to an API call. Use `attrs.error` for exceptions (serialized, stack capped at 4 KiB), and `essential: true` only for warnings that must be sent without telemetry consent.

### 8. Returning and handling errors

Match problems by type, never by message:

```ts
if (isProblemError(e) && e.is(PlatformProblemTypes.ValidationFailed)) setFieldErrors(toFieldErrorMap(e));
else if (isProblemError(e)) setFormError(problemMessage(e));      // localized by type, else the title
```

Gateway denials: `gatewayDenyCode(e)`.

| Code | What the UI does |
|---|---|
| `DENY_MFA_STALE` | Step-up |
| `DENY_TENANT_READ_ONLY` | `useReadOnly()` |
| `DENY_UNRESOLVABLE_SUBJECT` | "Workspace being set up" with bounded retries, never a sign-out |

Details: [docs/problem-details](docs/problem-details/README.md).

### 9. Feature flags and kill switches

`useFeatureFlag(key, fallback)` reads platform flags from `runtime.json` (`flags`), then tenant flags from the session context. A remote is switched off without a deploy by `remotes.killSwitch` or the flag `remote.<name>.disabled`; its slot then shows the boundary's "unavailable" fallback.

### 10. Testing a remote

```ts
const p = createTestPlatform({ permissions: ['update:tender'], flags: { 'ai.drafting': true } });
mockApi({ 'GET /tenders/:id': Response.json(tender), 'PUT /tenders/:id': mockProblem(PlatformProblemTypes.Conflict) });
// render(<p.Wrapper><EditTender id="1" /></p.Wrapper>) …
expect(p.logs.filter((l) => l.level === 'error')).toEqual([]);
```

`createTestPlatform` runs the real SDK with fakes only at the edges: in-memory exporters, a signed-in identity provider, a role-map authorizer. `p.reset()` clears records and undoes `mockApi`.

### 11. Upgrading between alpha versions

During `1.0.0-alpha.N`, a breaking change bumps `N`. Each one is listed in [CHANGELOG.md](CHANGELOG.md). Upgrade the shell and every remote together: they share the SDK as a strict singleton under `^1.0.0-0`. `1.0.0` is cut with the first environment, and SemVer is strict from then on.

---

## Local development

### Prerequisites

Node 22 (`.nvmrc`) and pnpm via corepack (`corepack enable`; the version comes from `packageManager`). To regenerate contracts or run metrics parity you also need Go (for go-probe and gincommon's `metricslint`), and sibling checkouts at the commits pinned in `contracts/sources.json`. The default layout is the workspace root two levels up; set `PLATFORM_ROOT` and `IAM_REPOS_DIR` to change it.

### Setup

```bash
pnpm install
pnpm verify
```

### Common commands

| Command | What it does |
|---|---|
| `pnpm verify` | Exports and docs checks, lint, typecheck, all tests, build, example checks, API reports, dependency rules (what CI's quality and test gates run) |
| `pnpm test` / `pnpm test:coverage` | Vitest (coverage of `packages/*/src`) |
| `pnpm lint` · `pnpm typecheck` · `pnpm build` | Individually |
| `pnpm api` / `pnpm api:check` | Update / check the api-extractor reports |
| `pnpm exports:sync` | Exports map + the SDK facts generated into the tooling packages |
| `pnpm contracts:sync` / `contracts:check` | Regenerate / check `contracts/` (`--update-pins` moves the pins to the checkouts' HEAD) |
| `pnpm docs:sync` / `docs:check` | Generated docs and the diagram blocks in ARCHITECTURE.md |
| `pnpm metrics:parity` | The SDK's metric checks vs gincommon's `metricslint` |
| `pnpm examples:check` | CSP and sharing checks on the example builds (after `pnpm build`) |
| `pnpm changeset` | Record a change to a published package |

### Running a single test

```bash
pnpm exec vitest run packages/frontend-sdk/test/http
pnpm exec vitest run -t "single-flight"
```

### Building the examples

`pnpm build` builds the packages and then `examples/shell` and `examples/remote-tenders` (webpack production builds into their `dist/`). `pnpm examples:check` then verifies the bundles:
- the remote defines `window.tenders` and contains no SDK code;
- nothing needs `eval`;
- source maps are emitted but hidden;
- `index.html` has no inline script.

The example shell can't run end to end on its own: it needs Keycloak, the IAM APIs and a CloudFront-like origin.

### Developer tools

| Tool | Use |
|---|---|
| `actionlint`, `shellcheck -x` | Workflows and `.github/scripts` (both clean; CI runs the pin and hygiene checks) |
| api-extractor reports | Review public API changes in `packages/frontend-sdk/api/` |
| [mermaid.live](https://mermaid.live) or an IDE preview | Architecture diagrams in `docs/architecture/mermaid/` |

---

## Testing observability locally

### How the pipeline works

```
shell / remotes
    ├── spans ──OTLP/HTTP POST /otel/v1/traces──┐
    ├── logs  ──OTLP/HTTP POST /otel/v1/logs ───┼──▶ CloudFront /otel/* ──▶ OTel Collector ──▶ Tempo · Loki · Mimir
    └── metrics ─OTLP/HTTP POST /otel/v1/metrics┘    (delta → cumulative, label allowlists)
```

### In tests (no infrastructure)

`createTestPlatform()` exports to memory: `p.logs` and `p.spans` hold exactly what the collector would receive (envelope fields, redaction, levels). Assert on them in unit tests.

### Against a local collector

gincommon's local stack (`make docker-up` in platform-gincommon) runs a collector with an OTLP/HTTP receiver on `localhost:4318` and a **traces pipeline to Tempo** (`localhost:3200`, Grafana on `3000`). Serve your app with a dev proxy that forwards `/otel` to `http://localhost:4318`, and set `telemetry.sampleRatio: 1` in `runtime.json` to see spans in Grafana Explore → Tempo. That collector has no logs or metrics pipelines: inspect those payloads in the browser's network panel (`/otel/v1/logs`, `/otel/v1/metrics`), or in tests.

### Troubleshooting observability

| Symptom | Check |
|---|---|
| No logs or spans at all | Consent: without `telemetry`, only errors and essential warnings are sent |
| Some logs missing | `telemetry.logLevel`; queue drops under load (`loggingStats` in tests) |
| Few traces | `telemetry.sampleRatio` (default 0.1); `ParentBased` follows the caller's decision |
| No `traceparent` on a call | Cross-origin calls get it only for exact origins in `api.propagationAllowlist` |
| A remote's metric throws | `InvalidMetricError` names the violated registry rule |

---

## Testing

### Canonical tests (do not break)

- **`test/auth/oidc.test.ts`**: against a Keycloak fake that revokes the whole session on any refresh-token reuse. It covers:
  - single-flight refresh, and two tabs refreshing alternately without reuse;
  - ambiguous failures restoring silently, never resending a token;
  - every callback check, the loop guard and the signed-out mark;
  - that no token ever reaches storage or the channel.
- **`test/http/http.test.ts`**: identity headers never sent, the token only to the page's origin, retries and `Retry-After`, the 401 refresh path, de-duplication.
- **`test/core/identity.test.ts`**, **`sanitize.test.ts`**: the identity and redaction fixtures shared with Go (go-probe) and Python.
- **`test/problem/parse.test.ts`**: real gincommon and fastapicommon error bodies decode as gincommon's own client decodes them.
- **`test/config/schema-csp.test.ts`**: parsing the runtime config never constructs a `Function` (CSP `script-src 'self'`).
- **`test/dependency-rules.test.ts`** + `scripts/lib/subpaths.test.ts`: the layer rules and functional areas from `subpaths.json`.
- **`examples/shell/test/iam.test.ts`**: the shell's PUB-1 / P-35 ports against the contract cases (contract #18).
- **`packages/webpack-preset/test/preset.test.ts`**: real webpack builds. Checks the container global, no SDK in remotes and no `eval`, and that the shared version ranges agree with webpack's own semver.
- **`examples/cloudfront/test/cloudfront.test.ts`**: the CSP equals the design doc's, and covers the SPA rewrite and the `/csp-report` Lambda.

### Coverage

`Validate / Test` fails below **94%** statement coverage of `packages/*/src` (`.github/scripts/coverage-gate.sh`). It's 94.8% today. Don't lower the threshold.

---

## Runtime configuration

The SDK reads no environment variables in the browser. Its configuration is one `/config/runtime.json` per environment, loaded by the shell and validated strictly. Unknown keys fail. The full reference is in [LLD §12.1](docs/lld/platform-reactcommon-lld.md#121-runtimejson).

| Key | Default | Purpose |
|---|---|---|
| `api.baseUrl` | — (**required**) | Same-origin API path (`/api`) |
| `api.timeoutMs` | `35000` | Client deadline per call (above gincommon's 30 s server timeout) |
| `api.propagationAllowlist` | `[]` | Exact origins, besides the page's, that get correlation and trace headers |
| `telemetry.otlpBaseUrl` · `sampleRatio` · `logLevel` · `sendSessionHeader` | `/otel` · `0.1` · `info` · `true` | Telemetry export |
| `auth.idpOrigin` · `clientId` · `scopes` | `https://auth.bcbpsolutions.com` · `tender-web` · `["openid"]` | Keycloak |
| `auth.trialRealm` · `paidRealmPrefix` · `workspacePathPrefix` | `trial` · `tenant-` · `/t/` | Workspace (realm) rules |
| `auth.idleTimeoutMs` · `auth.redirectPath` | — (**required**) | Idle timeout (1 min – 8 h); the callback path |
| `flags` | `{}` | Platform flags and kill switches |
| `remotes.killSwitch` · `allowedOrigins` | `[]` · `[]` | Remotes switched off; extra entry origins |
| `remotes.loadTimeoutMs` · `remotes.retries` | — (**required**) | Remote loading |
| `i18n.defaultLocale` · `supportedLocales` | — (**required**) | Canonical BCP 47 tags |
| `appUpdate.pollIntervalMs` | — (**required**) | `/version.json` polling (≥ 10 s) |

Build-time constants (shell): `__ENVIRONMENT__` and `__BUILD_VERSION__` (webpack `DefinePlugin`), passed to `initializeCore`.

---

## Security

| Topic | Guidance |
|---|---|
| **Tokens** | Held in one closure in `/auth`; never in storage, globals, logs or the cross-tab channel; the access token only to the page's own origin; the ID token kept only as `id_token_hint` for a global logout |
| **Identity headers** | Never sent from the browser (dropped by `/http`, reported by the lint rule); the gateway derives identity from the token and strips any it receives |
| **Sign-in** | PKCE S256, one-time `state` records, RFC 9207 `iss`, ID-token claim checks; refresh tokens never re-sent after an ambiguous failure (reuse would revoke every tab's session) |
| **Permissions** | `/authz`, flags and `useReadOnly` are UI hints; the gateway authorizes every request |
| **Content Security Policy** | Works under `script-src 'self'`, `style-src 'self'`, `require-trusted-types-for 'script'` (policies `platform-sdk`, `platform-webpack`, `dompurify`); no `eval` anywhere (checked on the example builds); violations logged after bootstrap, `/csp-report` before |
| **HTML** | Only through `sanitizeHtml` (DOMPurify + Trusted Types); lint rule `no-unsafe-html` |
| **Tenant isolation in the browser** | Storage namespaced by realm or `trial:<tenant_id>`; cleared on logout and workspace switch; nothing written before sign-in |
| **Redirects** | Every `returnUrl` and `navigate` target passes `isSafeRedirect` |
| **Remote code** | Entries only from the page's origin or exact allowed origins, checked twice; SRI when the manifest gives it; kill switch |
| **Telemetry** | Redacted with gincommon's rules (sensitive keys, JWT, `Bearer`, URL queries); consent-gated; the collector drops per-browser attributes |
| **Supply chain** | Actions pinned to commit SHAs; Trivy on dependencies, secrets and config; `pnpm audit --prod`; CycloneDX SBOM; Cosign-signed release checksums. Vulnerability reporting and trust model: [SECURITY.md](SECURITY.md) |

---

## Observability

**SLOs.** The SDK defines no SLO of its own. The proposed browser metrics (below) are what client-side SLOs and alerts will be built on; [runbooks.md](docs/observability/runbooks.md) lists the alerts proposed for them.

### Metrics

This follows the [Enterprise Platform Observability Standard](docs/observability/README.md)'s three tiers. The page identity (`domain`, `service`, `environment`) is injected centrally, never declared at a call site.

- **Tier 1, `platform_web_*` (emitted by the SDK, proposed):**
  - `platform_web_http_client_duration_seconds`, `platform_web_http_client_failures_total`;
  - `platform_web_remote_load_seconds`, `platform_web_remote_load_failures_total`;
  - `platform_web_errors_total`;
  - `platform_web_vitals_seconds`, `platform_web_vital_ratings_total`.

  They're recorded through the instrument port and stay no-ops until governance ratifies the names (design doc §D5, §D6 K).
- **Tier 2, `<domain>_*`:** registry entries only, through `getDomainMeter`.
- **Tier 3, `<domain>_<service>_*`:** free to add through `getServiceMeter`, validated at registration and by `metricslint` in the remote's CI.

The registry the SDK validates against: [metric-registry.md](docs/observability/metric-registry.md) (generated).

### Tracing and logs

Spans follow the W3C standard (`traceparent` / `tracestate`), with gincommon's sampler. The resource carries `service.name`, `service.version`, `service.namespace` (= domain) and `deployment.environment.name`.

Every log carries `trace_id`, `span_id`, `request_id`, `session_id`, `mfe` and `page_route`, and is redacted. The SDK's own log events (`remote failed to load`, `sign-in callback rejected`, `content security policy violation`, …) are catalogued in [LLD §11.1](docs/lld/platform-reactcommon-lld.md#111-log-event-catalogue).

---

## Releases

### Nothing is deployed

This repository publishes npm packages; the shell and remotes that use them are deployed elsewhere. A release is a **git tag `vX.Y.Z`**, and its GitHub Release carries:

| Artefact | Purpose |
|---|---|
| `platform-frontend-sdk-X.Y.Z.tgz`, `platform-webpack-preset-X.Y.Z.tgz`, `platform-eslint-plugin-X.Y.Z.tgz` | What shells and remotes install (no npm registry yet) |
| `checksums.txt` + `checksums.txt.sigstore.json` (Cosign) | Integrity of the tarballs and the SBOM |
| `sbom.cyclonedx.json` | CycloneDX SBOM (Trivy) |

### Versioning

SemVer over the public API ([VERSIONING.md](VERSIONING.md): what counts as public API, guarantees, how versions interact with Module Federation, compatibility matrix). All three packages share one version (changesets `fixed`). Every change to a published package adds a `.changeset/*.md` (the bump) and an entry under `[Unreleased]` in the root [CHANGELOG.md](CHANGELOG.md) (the history, [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), as platform-gincommon).

| Version | Status | Notes |
|---|---|---|
| `1.0.0-alpha.N` | Current line | Pre-release while nothing is deployed; a breaking change bumps `N`; remotes share the SDK under `^1.0.0-0` |
| `1.0.0` | Cut with the first end-to-end environment | Strict SemVer from then on |

### Cutting a release

1. Open a release PR: `pnpm changeset version` bumps all three packages and consumes the changesets; rename `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) to `## [X.Y.Z] - YYYY-MM-DD` (the version it set) and add a new empty `[Unreleased]`. Commit the result, run `pnpm install` if the lockfile changes, and merge.
2. Tag the merge commit `vX.Y.Z` (the version it set) and push the tag. `release.yml` does the rest:
   1. **Verify.** The tag must be reachable from `origin/main` (and a manual dispatch must start from `main` or the tag), all package versions must equal the tag, and `CHANGELOG.md` must have its section (`## [X.Y.Z]`; a pre-release tag may use its base version's section).
   2. **Gates.** The same gates as `ci.yml`, at the tag: tests, quality, contracts, package, Trivy, smoke, interop.
   3. **Publish.** Checksums over the tarballs and SBOM, a Cosign keyless `sign-blob` with verification, and the GitHub Release with that CHANGELOG section as its notes. A tag with a pre-release part is marked as a pre-release.

**Verifying a release** (needs [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) ≥ 2.4):

```bash
TAG=v1.0.0-alpha.1
REPO=BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon
IDENTITY="^https://github\.com/${REPO}/\.github/workflows/release\.yml@refs/(tags/${TAG}|heads/main)$"
gh release download "$TAG" -R "$REPO" -p checksums.txt -p checksums.txt.sigstore.json -p 'platform-*.tgz'
cosign verify-blob --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp "$IDENTITY" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
sha256sum --check --ignore-missing checksums.txt   # macOS: shasum -a 256 -c --ignore-missing
```

---

## CI

Six workflow files and one shared setup action. Shell logic lives in `.github/scripts/` (shellcheck-clean), and every third-party action is pinned to a full commit SHA (checked in CI). Dependabot version updates are **disabled** (`.github/dependabot.yml.disabled`; re-enable with `git mv .github/dependabot.yml.disabled .github/dependabot.yml`).

- **`ci.yml`:** the orchestrator, on every PR (any base) and pushes to `main`, skipping Markdown-only commits.
  1. In parallel: `validate-test`, `validate-quality`, `validate-contracts` and `package` (build + `pnpm pack` ×3).
  2. Then `trivy` (filesystem scan: runtime dependencies, secrets, config; CRITICAL/HIGH/UNKNOWN fails; SARIF; CycloneDX SBOM) and `smoke` (the tarballs installed into an empty consumer).
  3. Then `interop` (platform-interop-tests at a pinned SHA, pair 4 at this ref).
  4. Finally `pr-summary` (one updated PR comment, also on failure).
- **`validate-test.yml`** (reusable): a frozen install, then `pnpm test:coverage`, then `coverage-gate.sh` (**≥ 94%**), then the coverage report is uploaded.
- **`validate-quality.yml`** (reusable), in order:
  1. HTML-escaped-operator guard, action SHA pins, lockfile drift;
  2. exports and docs checks;
  3. lint (with `@platform/eslint-plugin` on the examples), typecheck, build;
  4. API reports, dependency-cruiser, example CSP checks;
  5. `pnpm audit --prod`.
- **`validate-contracts.yml`** (reusable): checks out the seven backend repos at their pins, then runs `contracts:check` and `metrics:parity`.
- **`changelog-check.yml`:** a PR that changes a published package must add a `.changeset/*.md` and update `CHANGELOG.md`. A release PR (which consumes changesets) passes with the `CHANGELOG.md` change alone.
- **`release.yml`** (`v*` tags or manual): `verify`, then the `ci.yml` gates at the tag, then `publish`.

**Secrets:** the org secrets `CI_REPO_READ_TOKEN` (sibling checkouts; `PLATFORM_REPOS_TOKEN` overrides it for contracts if set) and `GO_PRIVATE_TOKEN` (interop), as platform-gincommon uses them.

---

## Hosting (CloudFront)

There's no image. The shell and remotes are static files on S3 behind CloudFront. [`examples/cloudfront`](examples/cloudfront/README.md) documents the setup as IaC snippets (nothing deploys from here):
- the behaviors in precedence order, with `/api/*` going to the gateway;
- the response-headers policy (CSP, HSTS, COOP/CORP, …) generated from one source;
- the SPA-rewrite CloudFront Function (never a 403/404 → `index.html` error response, which would turn `/api` 404s into HTML);
- the `/csp-report` Lambda;
- the deploy order: remotes, then the manifest, then the shell, then `/version.json` last.

---

## Platform dependencies

### 1. Consuming apps (apps → this library)

| App | Uses |
|---|---|
| Shell `app.bcbpsolutions.com` (`domain: portal`, `service: web-app`) | Every area; the bootstrap; the IAM ports; `@platform/webpack-preset` (role `shell`) |
| Remotes (tenders, IAM administration, workflow design, dashboard) | Subpaths from the shell (`import: false`), `MFEErrorBoundary`, `useApi`, `useT`, `getServiceMeter`; `@platform/webpack-preset` (role `remote`); `@platform/eslint-plugin` |

None is deployed yet; [`examples/shell`](examples/shell) and [`examples/remote-tenders`](examples/remote-tenders) are the reference implementations, built and checked in CI.

### 2. Sibling libraries

| Library | Direction | Contract |
|---|---|---|
| `platform-gincommon` | contracts ← | Registry, problem types and rules, headers, redaction, log fields (pinned commit); `metricslint` for parity |
| `platform-fastapicommon` | contracts ← | Same contracts; its vendored registry is compared |
| `platform-interop-tests` | fixtures ←, CI → | Shared fixtures; pair 4 runs this SDK against both servers |
| `iam-authz-enrichment`, `iam-org-membership` | contracts ← | Deny codes, injected headers; PUB-1 / P-35 shapes |

### 3. Infrastructure dependencies

| System | Role | On failure |
|---|---|---|
| **CloudFront + S3** | Serves the app, `runtime.json`, the manifest, remotes, `/version.json` | `runtime.json` failure is fatal at bootstrap (static page); manifest failure → every remote shows its fallback |
| **Keycloak** (`auth.bcbpsolutions.com`) | Sign-in, refresh, logout | Refresh outcome unknown → the lineage is dropped and restored silently once reachable; no sign-out |
| **API gateway** | Validates tokens, injects identity, denies with problem bodies | Calls fail with typed errors; deny codes drive the UI (step-up, read-only, workspace set-up) |
| **OTel Collector** (`/otel`) | Receives all three signals | Bounded queues drop the oldest items; nothing else is affected |
| **IAM PUB-1 / P-35** | Workspace resolve; session context | Cached workspaces still work; without the context: deny-all permissions, platform flags only |

---

## Out of scope

| Concern | Where it lives |
|---|---|
| Token validation, identity headers, authorization decisions | API gateway (Envoy) + IAM AuthZ Enrichment |
| Realms, clients, token lifetimes, MFA policy | IAM realm provisioner / Keycloak |
| Business validation and domain logic | Each remote and its services |
| UI components and design system | `@platform/ui` |
| Collector, Tempo, Loki, Mimir, Grafana | Platform observability infrastructure |
| Ratifying `proposed` metrics | Observability governance (registry PRs in platform-gincommon) |
| CloudFront, S3, WAF, deploys | Infrastructure (`examples/cloudfront` documents the requirements) |

Keeping scope to **identity, data access, errors, observability and the micro-frontend runtime** keeps the SDK safe to upgrade across every app without business-logic risk.

---

## Contributing

| Document | Description |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, runtime registry, flow diagrams, invariants, threat model |
| [`docs/design/frontend-sdk-design.md`](docs/design/frontend-sdk-design.md) | The design and its decisions: public API per subpath, contracts, backend changes it relies on |
| [`docs/lld/platform-reactcommon-lld.md`](docs/lld/platform-reactcommon-lld.md) | Low-level design: implementation, limits, algorithms, state, failure handling, open items |
| [`docs/areas/`](docs/areas/README.md) | The seven functional areas, one page each |
| [`docs/architecture/`](docs/architecture/README.md) | Mermaid sources of the diagrams |
| [`docs/observability/README.md`](docs/observability/README.md) | The observability standard in the SDK |
| [`docs/observability/metric-registry.md`](docs/observability/metric-registry.md) | Generated registry inventory (`pnpm docs:sync`) |
| [`docs/observability/migration.md`](docs/observability/migration.md) | Moving an existing app onto the SDK |
| [`docs/observability/runbooks.md`](docs/observability/runbooks.md) | Frontend runbooks and proposed alerts |
| [`docs/problem-details/`](docs/problem-details/README.md) | RFC 9457 in the browser; generated type registry |
| [`packages/frontend-sdk/contracts/README.md`](packages/frontend-sdk/contracts/README.md) | Each generated contract and its source |
| [VERSIONING.md](VERSIONING.md) | SemVer rules, public API, Module Federation and versions, release process, compatibility matrix |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting, supported versions, trust model and known limitations, scope |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, layout, adding a subpath, metric, lint rule or contract, testing, PR checklist, releases |
| [CHANGELOG.md](CHANGELOG.md) | Release history (Keep a Changelog) |

**A change to a published package:**
- follows the design doc (update it in the same PR if behaviour changes);
- keeps `pnpm verify` green;
- updates the API reports (`pnpm api`) when the public API changes;
- adds a changeset (`pnpm changeset`) and a `CHANGELOG.md` entry under `[Unreleased]`.

**Contracts:**
- never edit them by hand;
- move a pin with `pnpm contracts:sync --update-pins`, review the diff, then run `pnpm docs:sync`.

---

## License / ownership

BCBP Solutions FZC LLC — internal platform shared library. Not for external distribution.
