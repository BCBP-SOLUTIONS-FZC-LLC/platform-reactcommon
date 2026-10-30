# `@platform/frontend-sdk` — design contract

Status: **approved for implementation, except the `/metrics` Tier 1 binding** (2026-10-30) · Scope: design
only (deliverables C1–C5). Each subpath is implemented in a follow-up, one module at a time, against
this document.

"Implement" means the code and its unit tests can be written now against this document (with
mocks for missing IAM endpoints). Nothing is in production, so the last column lists what the
**first end-to-end dev environment** needs, not production release gates. Backend changes the SDK
relies on are listed in §D6.

| Module | Implement | Needed for the first end-to-end environment |
|---|---|---|
| `/core`, `/config`, `/tracing`, `/logging`, `/security`, `/flags`, `/nav`, `/i18n`, `/storage` | **Ready** | — |
| `/problem` | **Ready** | — (gateway denials are RFC 9457 since AuthZ Enrichment #39, §D6 H) |
| `/http`, `/mfe` | **Ready** (metrics via the no-op instrument port) | — |
| `@platform/webpack-preset`, `@platform/eslint-plugin` | **Ready** | — |
| `/authz` | **Ready** | — (real roles come from session context, IAM item A, merged: O&M #42/#46) |
| `/auth` | **Ready**, including token refresh: the Keycloak multi-tab rotation test passed with RP #41's settings (§D6 L, RP #44). Resolve endpoint and session context are mocked from their contracts (§C5 #18) | (IAM rounds 1 and 2 are merged.) PUB-1 enabled at the edge, which needs the platform rate-limit service and the WAF challenge (§D6 B); web-app base URLs per environment (§D6 F). G (bff-signup returns the slug) is needed for the signup handoff |
| `/react`, `/testing` | **Ready** | Session/workspace hooks ship with `/auth`; role, plan and flag hooks read session context (IAM item A, merged) |
| `/metrics` | **Ready, except the Tier 1 binding.** Exporter, central label injection, registration checks, `getDomainMeter`/`getServiceMeter` (Tier 2/3), `renderMetricInventory`, the metricslint CI and the observability layout. Tier 3 needs no approval; Tier 2 names come from the existing registry | Binding the `platform_web_*` instruments waits for governance ratification (D5, §D6 K); until then they stay no-ops. Designed to the Enterprise Platform Observability Standard, validated by `metricslint` |
| Shared package versions | — | SDK starts at `1.0.0-alpha.N`; `1.0.0` is cut with the first environment (§C3) |
| Shell bootstrap (`domain: 'portal'`) | — | **Registry PR for `portal` (D1)**: `initializeCore` rejects the domain until the PR merges and `contracts/` is regenerated |

Implementation order: `/core` → `/problem` → `/config` → `/tracing` → `/logging` → `/metrics` (Tier 2/3, exporter,
checks) → `/authz`, `/storage`, `/security`, `/flags`, `/nav` → `/i18n` → `/http` → `/mfe` → `/auth` → `/react` →
`/metrics` Tier 1 binding (after D5).

Sources of truth this design was checked against (read from source, not READMEs):

| Contract | Source |
|---|---|
| Problem model, registry, extensions | `go/platform-gincommon/internal/problem/{problem,types,extensions,client}.go` (v2.1.0) · `python/platform-fastapicommon/src/fastapicommon/problem/core.py` (v0.4.1) |
| Header names, limits, request-id rule | `go/platform-gincommon/internal/core/domain/{transport,validation}.go` |
| Outbound propagation | `go/platform-gincommon/pkg/gincommon/propagate.go` |
| Log redaction | `go/platform-gincommon/internal/core/service/log_sanitizer.go` |
| Resource attributes, sampler | `go/platform-gincommon/internal/adapter/outbound/otel/setup.go` |
| Identity vocabulary, metric naming, labels | `go/platform-gincommon/internal/obsregistry/registry.json` |
| Realm model, login flows, token lifetimes, ingress strip-list | `XPertPMS/IAM/iam-hld-docs/iam-hld-tender-saas-v1.58.md` §4.1, §5.4, §8.2, §8.10.2, §11.1, §11.3 |
| Workspace resolution (PUB-1) | `iam-org-membership` `internal/adapter/inbound/http/router.go`, LLD `docs/lld/iam-lld-org-membership-service.md` rev 2.14 (§5.4, OQ-10, OQ-11) |
| Gateway deny codes, MFA freshness | `iam-authz-enrichment` `internal/domain/decision.go`, `internal/adapter/inbound/grpc/response.go`, LLD §8.4, §17, AE-42 |
| Realms and OIDC clients | `iam-realm-provisioner` `internal/adapter/outbound/keycloak/realm-template.json`, LLD RP-INV-2, RP-3 |
| Verification and invitation emails | `iam-realm-provisioner` `internal/adapter/outbound/keycloak/admin_users.go` (`CreateTrialUser`, `CreateInvitedUser`); `iam-org-membership` `internal/core/service/invitation_service.go` |
| Trial signup (SB-1…SB-5), first sign-in timing (G-3) | `XPertPMS/BFF/bff-signup` `internal/adapter/inbound/http/dto.go`, LLD `docs/lld/signup-bff-lld.md` v0.7 (§5.4, §5.5, §8.2, §10.4) |
| No-membership denial and its negative cache | `iam-authz-enrichment` `internal/usecase/check.go` (`ErrNotFound` → `DENY_UNRESOLVABLE_SUBJECT`), `internal/config/config.go` (`AE_NEG_TTL`, 5 s) |
| Screen-level frontend questions (FE-Q1…FE-Q18) | `iam-catalog-admin/Claude outputs/frontend-product-screen-spec.md` (draft) |

> **§0 lists where the backend contradicts the original brief.** Where they conflict, this design
> follows the backend, because "contract-compatible" is the requirement.

---

## 0. Corrections to the brief (backend wins)

| # | Brief said | Backend actually does | Design decision |
|---|---|---|---|
| 1 | `domain`, `environment` each match `^[a-z][a-z0-9_-]{0,62}$` | That regex is only the **service** label pattern. `domain` is a **closed vocabulary** (`iam, workflow, billing, tender_management, notifications, documents`); `environment` is closed (`local, dev, test, staging, prod`; `production` is rejected, no aliases). | Validate against the registry vocabulary, generated from `registry.json` (§C5). A multi-domain shell uses a new `portal` value, added by registry PR (§D1). A single-business shell uses that business domain. |
| 2 | `buildVersion` "sanitized" | `version` label pattern `^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$`, `unknown` when unset | Same rule: empty becomes `unknown`, and a non-matching value throws (no silent rewriting). |
| 3 | `validationErrors[{field,message,code}]` | Go `FieldError` and Python `FieldError` are `{field, message}` only | `code?: string` is **optional** and parsed if present. Form mapping must not depend on it. Unknown per-entry members are preserved. |
| 4 | Redact `password\|token\|secret\|authorization\|cookie\|key\|*_key` | Backend list is a superset: exact keys `authorization, cookie, set-cookie, password, secret, token, access_token, refresh_token, id_token, api_key, x-api-key, x-auth-token, credential, private_key, jwt, bearer, session, session_id, cert` + substring `password, secret, token, credential, session, bearer` + `key` / `*_key` | Port the backend rule **exactly** (shared fixture, §C5). One deliberate, stricter difference: `sanitizeString` also strips U+2028/U+2029 (the fixture's `expectedSdk`). |
| 5 | Every log entry carries `sessionId` | The backend sanitizer redacts any key containing `session` | `session_id` is an **SDK envelope field** added *after* redaction. It is a random RUM id, never the IdP `sid`. Redaction applies only to caller-supplied attributes. |
| 6 | Metric names `platform_*` | The backend follows the Enterprise Platform Observability Standard: three tiers (`platform_*`, `<domain>_*`, `<domain>_<service>_*`), registry-only shared names, centrally injected `domain`/`service`/`environment`, `_total`/`_seconds` suffixes, a closed label vocabulary, all enforced by gincommon `metricslint`. No browser metrics exist in `registry.json`, and server HTTP metrics use `status_class` + `error_class`, not `outcome`. | `/metrics` follows the same standard and the same lint (§C1 `/metrics`). Seven Tier 1 `platform_web_*` metrics and four labels go to the registry as **`proposed`**; existing labels keep their one meaning. Remotes get Tier 2/3 meters under their owning domain. Only the Tier 1 binding in `/metrics` waits for governance to approve the Tier 1 entries (§D5); Tier 2/3 and the exporter do not. |
| 7 | `x-session-id` header | No backend reads it | Sent as an untrusted correlation header. The gateway must pass it through and never trust it. Opt-out via config. |
| 8 | Idempotency-Key on POST, retry idempotent methods only | No backend lib implements Idempotency-Key handling | Send `Idempotency-Key` on POST. **Do not auto-retry POST** unless the caller sets `retry: { unsafe: true }` per endpoint (service has confirmed dedup). |
| 9 | Timeout default "> backend RequestTimeout" | gincommon reference `RequestTimeout` = 30 s; server deadline → **503** `platform/service-unavailable`, `errorCode: REQUEST_TIMEOUT` | Client default **35 s** (runtime-config overridable). A server timeout is a `ProblemError`; only the client-side deadline is a `TimeoutError`. |
| 10 | `useHasPermission` "based on user claims" | The JWT carries only `sub` and standard OIDC claims (IAM HLD §4.1). Roles, departments, plan and flags are looked up by AuthZ Enrichment and injected as headers the browser never sees | Roles and flags come from a `SessionContextSource` port the shell implements over an IAM endpoint (D2 item A), never from the token |
| 11 | All backend errors are RFC 9457 | gincommon/fastapicommon are, but gateway (`ext_authz`) denials are a plain-text body `DENY_<REASON>` with 401/403/503 (`response.go`: `Body: string(reason)`). RFC 9457 there was deferred (AE-42 / CD-31) | **Fixed at the source** (§D6 H, AuthZ Enrichment #39, merged): `deniedResponse` sends `application/problem+json` with `errorCode` = the deny reason. `/problem` has **no** plain-text adapter. Denials go through the normal parser, and `gatewayDenyCode()` reads `errorCode` |

**No service is in production yet** (as of 2026-10-30). Where the frontend needs something a backend
does not do yet, this design asks for the backend change (§D6) instead of adding a client-side
workaround. The "backend wins" rule above still applies to contracts that already work.

`COMPATIBILITY.md` §gincommon↔fastapicommon has been updated: its error-shape row now records RFC 9457 on both sides.

---

## C1. Package layout, public API, dependency rules

### Repository layout

```
platform-reactcommon/
  packages/
    frontend-sdk/            @platform/frontend-sdk
      src/<subpath>/index.ts   one folder per subpath; index.ts is the ONLY public surface
      src/internal/            shared private helpers (not exported)
      contracts/               generated, committed: problem-types.json, registry-vocab.json,
                               headers.json, log-fields.json, redaction.json, fixtures/ (header_cases.json,
                               identity_cases.json, redaction_cases.json),
                               gateway-deny-codes.json, metric-registry.json, tenant-resolve-cases.json (resolve endpoint request/response fixtures),
                               session-context-cases.json (P-35 response fixtures)
      api/                     api-extractor reports (public API snapshot, one per subpath)
    webpack-preset/          @platform/webpack-preset  (MF shared config, CSP-safe output)
    eslint-plugin/           @platform/eslint-plugin
  examples/shell, examples/remote-tenders
  scripts/sync-contracts.ts  regenerates contracts/ from ../go + ../python and the IAM repos (contracts/sources.json)
```

Build: `tsup`/`rollup` to ESM + `.d.ts`, `"sideEffects": false`. `exports` map has one entry per
subpath and no root barrel export (`"."` throws a helpful type error), so subpaths stay
tree-shakeable. Peer deps: `react`, `react-dom` (^18 || ^19), `@opentelemetry/api` (^1).
Direct deps: `@opentelemetry/sdk-trace` (OTel JS 3; `sdk-trace-web`/`-base` 2.x are deprecated), `exporter-*-otlp-http`, `sdk-logs`, `sdk-metrics`,
`web-vitals`, `zod`, `dompurify`. Telemetry goes over OTLP/HTTP directly. There is no Faro SDK
(one pipeline). The `/otel` path may point at a Faro receiver or a plain collector.

Added subpaths beyond the brief, each justified: **`/security`** (DOMPurify is ~20 KB, so it gets
its own entry for tree-shaking) and **`/nav`** (navigation is not MFE loading). Consent lives in
`/core` because tracing, logging and metrics all depend on it.

### Dependency rules (enforced by `eslint-plugin-boundaries` + a dependency-cruiser CI check)

```
L0  core        problem       authz                     (no SDK imports; authz is pure)
L1  config ─► core            security ─► core          storage ─► core
L2  tracing, logging, metrics ─► core, config
L3  http  ─► core, config, problem, tracing, logging   (metrics via the internal instrument port in core)
    flags ─► core, config      i18n ─► core, problem, config
L4  auth  ─► core, config, logging, storage (never http: avoids a cycle; http consumes auth via the TokenSource port;
              auth calls IAM APIs only through ports the shell implements: WorkspaceResolver, SessionContextSource)
    mfe   ─► core, config, flags, tracing, logging     (metrics via the internal instrument port in core)
    nav   ─► core, config
L5  react ─► anything above         testing ─► anything (dev only)
```

- **Only `/react` imports React.** Every other subpath is framework-free and testable in Node.
- **Only `/tracing`, `/logging` and `/metrics` import `@opentelemetry/*`** (trace, logs and metrics SDKs
  respectively). Consumers never see OTel types, and no other subpath depends on one of those three for OTel.
- No subpath reads module state of another directly. Cross-module wiring goes through the
  `PlatformRuntime` registry in `/core`, stored at `globalThis[Symbol.for('@platform/frontend-sdk')]`
  with its version. A second copy of the SDK (a remote that bundled it instead of sharing it)
  is detected, and the duplicate logs a one-time `error` and binds to the existing runtime when the major version matches.
- Ports (interfaces) live in the lowest layer that needs them: `TokenSource` in `/http`,
  `IdentityProvider` in `/auth`, `Authorizer` in `/authz`, `FlagProvider` in `/flags`,
  `ConsentProvider` in `/core`.

### Public API per subpath

#### `/core`

```ts
export type ServiceName = string & { readonly __brand: 'ServiceName' };
export type Domain = (typeof DOMAINS)[number];          // generated from registry.json
export type Environment = (typeof ENVIRONMENTS)[number]; // 'local'|'dev'|'test'|'staging'|'prod'
export const DOMAINS: readonly string[];
export const ENVIRONMENTS: readonly string[];

export interface CoreIdentityInput {
  serviceName: string;   // ^[a-z][a-z0-9_-]{0,62}$
  domain: string;        // ∈ DOMAINS
  environment: string;   // trimmed, lower-cased, ∈ ENVIRONMENTS
  buildVersion?: string; // ^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$, default 'unknown'
}
export interface CoreIdentity { readonly serviceName: ServiceName; readonly domain: Domain;
  readonly environment: Environment; readonly buildVersion: string }

export class InvalidIdentityError extends Error { readonly field: keyof CoreIdentityInput }
export class IdentityMismatchError extends Error { readonly existing: CoreIdentity; readonly attempted: CoreIdentity }
export class NotInitializedError extends Error {} // only thrown by shell-only APIs (initialize*), never by consumer APIs

export function initializeCore(input: CoreIdentityInput): CoreIdentity; // idempotent for equal identity
export function getIdentity(): CoreIdentity | undefined;
export function isInitialized(): boolean;

/** Per-MFE scope: every log/span/metric from a remote is tagged with `mfe`. */
export interface MfeScope { readonly mfe: string }

// Correlation
export function getSessionId(): string;          // RUM session id: random v4 UUID, one per browser profile (SDK-reserved
                                                 // localStorage key, shared by tabs, kept across reloads; per-page if
                                                 // storage is unavailable); rotates on logout and the cross-tab idle timeout
export function newRequestId(): string;          // UUIDv4, satisfies ^[a-zA-Z0-9._-]+$ ≤128

// Consent (PDPL / GDPR)
export type ConsentCategory = 'essential' | 'telemetry' | 'analytics';
export interface ConsentProvider {
  has(category: ConsentCategory): boolean;
  subscribe(listener: () => void): () => void;
}
export function setConsentProvider(p: ConsentProvider): void; // default: essential only
export function hasConsent(c: ConsentCategory): boolean;

// Sanitization (parity with gincommon log_sanitizer.go)
export function isSensitiveKey(key: string): boolean;
export function sanitizeString(s: string): string; // strip Unicode Cc + U+2028/2029, truncate 256 B at UTF-8 boundary
                                                   // (the backends strip Cc only: U+2028/2029 is a deliberate, stricter SDK difference)
export function sanitizeFields(f: Record<string, unknown>): Record<string, unknown>; // deep, '[REDACTED]'
```

#### `/config`

```ts
export const RuntimeConfigSchema: z.ZodType<RuntimeConfig>; // .strict(): unknown keys rejected
export interface RuntimeConfig {
  readonly api: { readonly baseUrl: string /* must be same-origin path, e.g. '/api' */;
                  readonly timeoutMs: number /* default 35000 */;
                  readonly propagationAllowlist: readonly string[] /* exact origins */ };
  readonly telemetry: { readonly otlpBaseUrl: string /* '/otel' */; readonly sampleRatio: number /* [0,1], 0.1 */;
                        readonly logLevel: 'debug'|'info'|'warn'|'error'; readonly sendSessionHeader: boolean };
  readonly auth: { readonly idpOrigin: string /* 'https://auth.bcbpsolutions.com' (IAM HLD §8.2.4) */;
                   readonly trialRealm: string /* 'trial' (shared realm) */;
                   readonly paidRealmPrefix: string /* 'tenant-': a resolved paid realm must equal `${prefix}${slug}` (sanity check) */;
                   readonly workspacePathPrefix: string /* '/t/': paid workspace URL = `/t/<slug>/…` */;
                   readonly clientId: string /* 'tender-web' */; readonly scopes: readonly string[];
                   readonly idleTimeoutMs: number; readonly redirectPath: string };
                   // issuer = `${idpOrigin}/realms/${realm}`: one issuer per realm, never a single fixed issuer
  readonly flags: Readonly<Record<string, boolean | string | number>>;
  readonly remotes: { readonly killSwitch: readonly string[]; readonly loadTimeoutMs: number; readonly retries: number;
                      readonly allowedOrigins: readonly string[] /* exact origins besides same-origin; default [] */ };
  readonly i18n: { readonly defaultLocale: string; readonly supportedLocales: readonly string[] };
  readonly appUpdate: { readonly pollIntervalMs: number };
}
export class RuntimeConfigError extends Error { readonly issues: readonly { path: string; message: string }[] }
export function loadRuntimeConfig(opts?: { url?: string /* '/config/runtime.json' */; signal?: AbortSignal }): Promise<RuntimeConfig>; // shell only
export function setRuntimeConfig(c: RuntimeConfig): void;   // shell only, deep-freezes, set-once
export function getConfig(): RuntimeConfig;                 // throws NotInitializedError before shell bootstrap
export function tryGetConfig(): RuntimeConfig | undefined;
```

#### `/tracing`

```ts
export interface TracingOptions { otlpBaseUrl: string; sampleRatio?: number /* 0.1 */;
  propagationAllowlist?: readonly string[]; }
export function initializeTracing(o: TracingOptions): void;  // shell only; requires initializeCore
export function shutdownTracing(): Promise<void>;

export interface Span { setAttribute(k: string, v: string | number | boolean): void;
  recordError(e: unknown): void; end(): void; readonly traceId: string; readonly spanId: string }
export interface Tracer { startSpan(name: string, attrs?: Record<string, string | number | boolean>): Span }
export function getTracer(scope: string): Tracer;          // no-op tracer before init
export function withSpan<T>(name: string, fn: (s: Span) => T | Promise<T>,
  attrs?: Record<string, string | number | boolean>): Promise<T>;
export function currentTraceId(): string | undefined;      // 32 lower-hex, undefined if none/invalid
/** Used by /http only; consumers never set propagation headers themselves. */
export function injectTraceHeaders(url: URL, headers: Headers): void;
```

Resource: `service.name`, `service.version`, `service.namespace=<domain>`,
`deployment.environment.name=<environment>`. **No** `service.instance.id` per browser: it would
explode series cardinality. Sampler: `ParentBased(TraceIdRatioBased(ratio))`, with ratio ≤ 0 →
NeverSample and ≥ 1 → AlwaysSample (same as Go `Sampler()`). Exporter failures are swallowed and counted
in an internal counter; the batch queue is bounded and drops the oldest entries.

#### `/logging`

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown> & { error?: unknown }): void;
  child(scope: Partial<MfeScope> & Record<string, string>): Logger;
}
export function initializeLogging(o: { otlpBaseUrl: string; level?: LogLevel; batchSize?: number; flushMs?: number }): void;
export function getLogger(scope?: Partial<MfeScope>): Logger;  // no-op (console in dev) before init
export function setRouteTemplate(template: string): void;     // called by /react router glue; also adds it to PlatformRuntime.routeTemplates (/metrics)
export function serializeError(e: unknown): { name: string; message: string; stack?: string }; // sanitized
```

Envelope (set by the SDK, after redaction). Field names match gincommon's request logs
(`trace_id`, `request_id`, snake_case; `middleware/logging.go`), so one Loki query joins
frontend and backend lines:
- OTLP log record: body = message, severity = level, timestamp, and the record's native trace and span id fields.
- Attributes: `trace_id`, `span_id`, `request_id`, `session_id`, `mfe`, `page_route`.
- Resource: `service.name`, `service.namespace`, `deployment.environment.name`, `service.version`.

`page_route` is the client router template. It is deliberately not `path`, which on the backend
holds the server route template. CamelCase (`traceId`) is for problem bodies only, never log
fields. Redaction order: `sanitizeFields`, then
`sanitizeString` on every string value, then value scrubbing of JWT- or `Bearer`-shaped substrings, then message
sanitization. Stacks have URL query strings and fragments stripped. Transport: OTLP logs batched,
`fetch(keepalive)`, and `navigator.sendBeacon` on `pagehide`/`visibilitychange=hidden`. Consent:
`error` and essential `warn` are always sent; `debug`/`info` and any other `warn` require `telemetry` consent.
A `warn` is essential when its attributes carry `essential: true`, a reserved flag that is never sent as
an attribute. The SDK's own security warns (CSP violations, a duplicate SDK copy) set it.

#### `/metrics`

Follows the **Enterprise Platform Observability Standard**, the one every backend service follows, as
encoded in gincommon `internal/obsregistry/registry.json` and enforced by `cmd/metricslint`. Browser
metrics are classified, named, labelled and validated exactly like backend metrics. Nothing is
special-cased for the browser.

```ts
export interface Counter { add(v: number, labels?: Record<string, string>): void }
export interface Histogram { record(v: number, labels?: Record<string, string>): void }
export function initializeMetrics(o: { otlpBaseUrl: string; exportIntervalMs?: number }): void; // shell only
export function startWebVitals(): void;                         // shell only

/** Tier 2: only names the registry lists as `tier: "domain"` for the scope's domain, with exactly that
 *  entry's labels. No help text or buckets from the caller: both come from the registry entry. */
export function getDomainMeter(scope?: Partial<MfeScope>): {
  counter(name: string): Counter;
  histogram(name: string): Histogram;
};
/** Tier 3: `<domain>_<service>_<metric>`, prefix built like gincommon `ServicePrefix` (non-alphanumerics → `_`).
 *  Counters must end `_total`; histograms `_seconds` (or `_bytes`); gauges never `_total`. */
export function getServiceMeter(scope?: Partial<MfeScope>): {
  counter(name: string, help: string, labels: readonly string[]): Counter;
  histogram(name: string, help: string, labels: readonly string[], buckets?: readonly number[]): Histogram;
};
export class InvalidMetricError extends Error { readonly rule: 'namespace' | 'suffix' | 'required_labels' |
  'registry' | 'label_vocabulary' | 'prohibited_label' | 'cardinality' }
```

There is no API for Tier 1 names. Only the SDK records `platform_*` metrics (rule 11: services do not
invent platform metrics), through the internal instrument port below.

**Tiers and identity.** The decision tree is applied as written:

| Tier | Who emits | Name | Required labels (injected centrally) |
|---|---|---|---|
| 1 Platform | The SDK only (`/http`, `/mfe`, `/react`, web vitals) | `platform_web_*`, registry-approved only | `domain`, `service`, `environment` = the **page identity** (`initializeCore`: e.g. `portal` / `web-app`) |
| 2 Domain | Shell or remote code via `getDomainMeter` | `<domain>_*`, registry-approved only | `service`, `environment` (plus `domain`, a registry const label) = the **scope identity** |
| 3 Service | Shell or remote code via `getServiceMeter` | `<domain>_<service>_<metric>`, owned by the team | same as Tier 2 |

Scope identity: shell code uses the page identity. A remote (code inside an `MfeScope`) uses its
manifest `ownerDomain` as `domain` and its remote name as `service`. A remote is built, versioned and
owned by one domain team, so it is that team's "service" in the standard's sense. For example,
`tender_management_tenders_editor_draft_saves_total{domain="tender_management", service="tenders-editor"}`.
This is the only place a remote's own domain appears as `domain`: Tier 1 metrics, logs and traces keep
the page identity and use the `mfe` label (§D1). `metricslint` requires a metric namespaced under
domain *d* to carry `domain="d"`, which is why Tier 2 and 3 cannot use the page identity.

**Inputs from other modules.** `/metrics` is layer 2 and never imports `/mfe`, `/logging` or `/react`. It
reads two `PlatformRuntime` fields, the same way `/storage` reads the workspace namespace:
- `remotes`: `{ [mfe]: ownerDomain }`, published by `/mfe`'s `loadManifest`. A scope whose `mfe` is not
  in it (and is not `shell`) cannot get a Tier 2/3 meter (`InvalidMetricError`, rule `namespace`), and
  its `mfe` label value is rejected. Before the manifest loads, only shell scopes work, which is all the
  bootstrap needs.
- `routeTemplates`: the set of page-route templates registered so far, added to by `/logging`'s
  `setRouteTemplate` (called from `/react`'s `useRouteTemplate`). `page_route` values outside it record as `unknown`.

**Central label injection (rule 8).** The meter wrapper adds `domain`, `service` and `environment` to
every data point from `CoreIdentity` or the scope. A caller that passes any of them gets an
`InvalidMetricError`; instrumentation code cannot omit or misspell them. They are data-point
attributes, not only OTLP resource attributes, so they reach Mimir as ordinary labels however the
Collector translates resources.

**Registration checks** (the same rules as `metricslint`, run at registration time and in CI):
- Namespace: `platform_*` comes from the registry only; `<domain>_*` must be a registry domain entry;
  anything else must start with the scope's service prefix. Unclassified names throw.
- Suffix: counters `_total`; histograms `_seconds`, or `_bytes` with `unit: bytes`; gauges never
  `_total`. No other histogram unit exists, so a unitless value cannot be a histogram.
- Labels: shared metrics use exactly the registry label set; values must match the label's
  `values` or `pattern`. Prohibited labels (`user_id`, `email`, `tenant_id`, `request_id`,
  `event_id`, `session_id`, `trace_id`, `url`, `path`, …) and suffixes (`_id`, `_email`, `_ip`,
  `_uuid`, `_token`) throw, on every tier. All of this comes from the generated `contracts/`.
- Cardinality: each label's `max_values` is enforced per page, as platform-events does. A
  `page_route` that is not a registered template, or one past the bound, is recorded as `unknown`
  (the registry's value for unmatched routes). An `mfe` must be in the manifest (or be `shell`), so it
  cannot overflow. Every replacement is counted in the existing
  `platform_telemetry_label_overflow_total{label}` (same meaning: "a label value replaced because it
  exceeded its cardinality bound"). The SDK is added as an emitter of that metric, not given a new one (rule 7).

**Proposed Tier 1 metrics** (registry PR, `"status": "proposed"`, `"owner": "platform-reactcommon"`; §D5).
Every name passed the decision tree: each can be emitted, with identical meaning, by any domain's
web shell. `web` names the runtime, not a service.

| Metric | Type | Labels | Buckets |
|---|---|---|---|
| `platform_web_vitals_seconds` | histogram, `unit: seconds` | `vital` ∈ lcp, inp, ttfb, fcp · `page_route` | new preset `web_vitals` |
| `platform_web_vital_ratings_total` | counter | `vital` ∈ lcp, inp, cls, ttfb, fcp · `rating` ∈ good, needs_improvement, poor · `page_route` | — |
| `platform_web_http_client_duration_seconds` | histogram, `unit: seconds` | `method`, `route`, `status_class`, `error_class`, `mfe` | `request_duration` (same as the server, so client and server latency compare per route) |
| `platform_web_http_client_failures_total` | counter | `route`, `reason` ∈ timeout, network, aborted, `mfe` | — |
| `platform_web_remote_load_seconds` | histogram, `unit: seconds` | `mfe`, `outcome` ∈ success, failure, error | `dependency_request` |
| `platform_web_remote_load_failures_total` | counter | `mfe`, `reason` ∈ disabled, timeout, network, aborted, incompatible | — |
| `platform_web_errors_total` | counter | `source` ∈ unhandled_error, unhandled_rejection, boundary, chunk_load · `mfe` | — |

Semantics (each goes into the entry's `help`):
- **Vitals.** LCP, INP, TTFB and FCP are times and go in the histogram. CLS is a unitless score, so under
  the suffix rule it cannot be a histogram. It is reported only through `platform_web_vital_ratings_total`,
  which counts every vital (CLS included) by the `web-vitals` library rating. "Percent good" is what the
  Core Web Vitals assessment uses, so no information the SLOs need is lost.
- **HTTP client.** One observation per logical `/http` call, after retries. The label set mirrors the
  server's `platform_http_request_duration_seconds` (`method`, `route`, `status_class`, `error_class`,
  same vocabularies), plus `mfe`. A call with no HTTP status maps to `status_class=4xx`/`error_class=client_error`
  (caller abort, like the server's 499) or `5xx`/`server_error` (timeout, network), and is also counted in
  `platform_web_http_client_failures_total` with its `reason`.
- **Remote load.** `outcome`: success; failure = kill switch (`reason=disabled`); error = everything
  else. `incompatible` = `strictVersion` share negotiation or remote module evaluation failed.
- **Errors.** One count per reported error, by capture point (`source`).

Labels: `method`, `route`, `status_class`, `error_class`, `outcome`, `reason` and `source` are existing
registry labels with their existing meanings. `reason` and `source` take the per-metric enums above.
Four labels are new and go into the same PR with name, meaning, allowed values and cardinality:

| Label | Meaning | Allowed values | Cardinality |
|---|---|---|---|
| `page_route` | Client router template of the page; not the API `route`, not a URL | pattern `^(unknown\|/[A-Za-z0-9_./:*~-]*)$` | `max_values` 500, bounded by registered routes |
| `mfe` | Remote (micro-frontend) the measurement belongs to; `shell` for shell code | pattern `^[a-z][a-z0-9_-]{0,62}$` | `max_values` 100, bounded by `/remotes/manifest.json` |
| `vital` | Web vital | lcp, inp, cls, ttfb, fcp (per-metric subset) | fixed |
| `rating` | `web-vitals` rating against Google's thresholds | good, needs_improvement, poor | fixed |

Cardinality expectations: vitals are `page_route` × `vital` × 14 buckets, with no `mfe` (a page
belongs to one route). HTTP client series grow with the routes each remote actually calls, not with
routes × remotes.

Browser export rules (they go in the registry PR as `governance_notes`):
- OTLP metrics use **delta temporality**. The Collector converts them to cumulative (`deltatocumulative`);
  otherwise every tab becomes its own series in Mimir.
- The Collector allowlists label values and drops per-browser resource attributes (`service.instance.id`,
  `browser.*`, `user_agent.*`), because anyone can POST to `/otel`.
- Instrument units are set (`s`, `1`) so the OTLP → Prometheus name translation keeps the registry name
  exactly, with no doubled `_seconds` or `_total`. CI checks the translated names (§C5, drift item 4).

**Decoupling from approval (D5).** `/http` and `/mfe` do not import metric names. They record
through an internal instrument port in `/core`:

```ts
// src/internal/instruments.ts — not exported from any subpath
interface PlatformInstruments {
  httpClient(seconds: number, l: { method: string; route: string; status_class: '2xx' | '4xx' | '5xx';
    error_class: 'success' | 'client_error' | 'server_error'; mfe: string;
    reason?: 'timeout' | 'network' | 'aborted' }): void;   // reason set → also counts a failure
  remoteLoad(seconds: number, l: { mfe: string; outcome: 'success' | 'failure' | 'error';
    reason?: 'disabled' | 'timeout' | 'network' | 'aborted' | 'incompatible' }): void;
  webError(l: { source: 'unhandled_error' | 'unhandled_rejection' | 'boundary' | 'chunk_load'; mfe: string }): void;
}
```

The `PlatformRuntime` default is a no-op. `initializeMetrics` installs the real implementation,
which binds the approved names. Until governance approves them, `/http` and `/mfe` ship and are
tested against a recording fake (from `/testing`), and no metric names are emitted.

**Observability deliverables (implementation requirements).** They ship with `/metrics`, in the same
layout and checks as gincommon:

| Artefact | Location | Content |
|---|---|---|
| Registry entries | gincommon `registry.json` + fastapicommon copy; `make metrics-inventory` | The 7 metrics, 4 labels and the `web_vitals` preset, with help, labels, values, aggregation, cardinality, owner; `platform-reactcommon` added as an emitter of `platform_telemetry_label_overflow_total` |
| Recording rules | `observability/prometheus/rules/platform-web-recording.yml` | p75 per vital and `page_route`; percent-good per vital; browser API error ratio per `route`/`mfe`; remote load success ratio per `mfe` |
| Alert rules | `observability/prometheus/rules/platform-web-alerts.yml` | Remote load error ratio, browser API 5xx ratio, error-rate spike per `mfe`, vitals regression. Routed by `mfe` to the `ownerDomain` team |
| Rule tests | `observability/prometheus/rules/promtool-tests.yml` | `promtool check rules` + `promtool test rules`, as gincommon `make metrics-rules` |
| SLOs | `observability/slo/web.yml` | Core Web Vitals: ≥ 75 % `good` per vital per key `page_route`; remote load success ≥ 99.5 %; browser API success (non-5xx) ≥ 99.5 % |
| Dashboards | `observability/dashboards/platform-web-*.json` | Web vitals, API client (side by side with the server's `platform_http_*` per route), remotes, errors |
| Runbooks | `docs/observability/runbooks.md` | One section per alert |
| Service docs, inventory | `docs/observability/README.md`; the SDK's emitted inventory (§C5) | What each tier means for remote teams; how to add a Tier 2/3 metric |
| HPA references | — | None: the web tier is static files on S3 + CloudFront. The OTel Collector's own scaling is unaffected |

**Backward compatibility.** No browser metric has ever been emitted, so there is nothing to migrate and
no parallel emission period. Every metric starts compliant. Existing frontend dashboards, if any are
created before `/metrics` ships, must use the registry names from the start.

#### `/problem`

```ts
export interface ProblemType { readonly domain: string; readonly name: string; readonly id: `${string}/${string}`;
  readonly title: string; readonly status: number; readonly code: string }
export const PlatformProblemTypes: {   // generated from Go PlatformTypes(), registry order
  readonly BadRequest: ProblemType; readonly ValidationFailed: ProblemType; readonly Unauthorized: ProblemType;
  readonly Forbidden: ProblemType; readonly NotFound: ProblemType; readonly MethodNotAllowed: ProblemType;
  readonly Conflict: ProblemType; readonly PayloadTooLarge: ProblemType; readonly UnsupportedMediaType: ProblemType;
  readonly BusinessRuleViolation: ProblemType; readonly RateLimitExceeded: ProblemType; readonly InternalError: ProblemType;
  readonly NotImplemented: ProblemType; readonly ServiceUnavailable: ProblemType; readonly GatewayTimeout: ProblemType;
};
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const DEFAULT_TYPE_BASE = 'https://errors.company.com';
export function defineProblemType(domain: string, name: string, title: string, status: number, code: string): ProblemType; // same rules as Go NewType
export function typeForStatus(status: number): ProblemType | undefined;

export interface FieldError { readonly field: string; readonly message: string; readonly code?: string;
  readonly [ext: string]: unknown }
export interface ProblemDetails {
  readonly type: string; readonly title: string; readonly status: number;
  readonly detail?: string; readonly instance?: string; readonly traceId?: string; readonly errorCode?: string;
  readonly tenantId?: string; readonly timestamp?: string; readonly validationErrors?: readonly FieldError[];
  readonly extensions: Readonly<Record<string, unknown>>;       // every unrecognised top-level member
}
export class ProblemError extends Error implements ProblemDetails {
  /* ProblemDetails members */ readonly synthetic: boolean;  // true when built from a non-problem response
  readonly requestId?: string;                                 // from X-Request-ID response header
  /** Type id ("platform/not-found"), independent of the configured type base. */
  readonly typeId: string | undefined;
  is(t: ProblemType): boolean;                                 // compares typeId, never title/detail
}
export class TimeoutError extends Error { readonly timeoutMs: number; readonly requestId: string }
export class NetworkError extends Error { readonly offline: boolean; readonly requestId: string }
export class AbortedError extends Error {}                     // caller aborted: never logged as error
export type ApiError = ProblemError | TimeoutError | NetworkError;

/** Gateway (ext_authz) deny codes, sent as the problem's `errorCode` (§D6 H); generated from iam-authz-enrichment (§C5). */
export const GATEWAY_DENY_CODES: readonly ['DENY_UNRESOLVABLE_SUBJECT', 'DENY_TENANT_READ_ONLY', 'DENY_MFA_STALE',
  'DENY_TENDER_ACL_INSUFFICIENT', 'DENY_ROLE_INSUFFICIENT', 'DENY_SERVICE_UNAVAILABLE', 'DENY_MALFORMED_IDENTITY'];
export type GatewayDenyCode = (typeof GATEWAY_DENY_CODES)[number];
export function gatewayDenyCode(p: ProblemError): GatewayDenyCode | undefined; // p.errorCode when it is one of GATEWAY_DENY_CODES
export function parseProblemResponse(res: Response, init?: { requestId?: string }): Promise<ProblemError>;
export function isProblemError(e: unknown): e is ProblemError;
export function toFieldErrorMap(p: ProblemError): Record<string, string[]>; // 'items[0].sku' kept as path
```

Parse rules, mirroring Go `FromResponse`/`UnmarshalJSON`:
- A body whose type includes `application/problem+json` is parsed. If `status` is missing, the response
  status is used. Body reads are capped (same as `MaxClientBodyBytes`). Members are matched
  case-sensitively. A case-insensitive collision with a standard member is **dropped**, not
  treated as an extension, to match `isStandardMember`.
- **Gateway denials** are ordinary problems (§D6 H, AuthZ Enrichment #39, merged): `deniedResponse`
  (iam-authz-enrichment `response.go`) sends `application/problem+json` with the platform type for the
  status (`platform/unauthorized`, `platform/forbidden`, `platform/service-unavailable`) and `errorCode` =
  the deny reason, plus a fixed per-reason `detail`, `instance`, `traceId` and `timestamp` (no `tenantId`:
  the request has no verified tenant). There is no plain-text adapter. The type base is platform-gincommon's
  `DefaultTypeBase` (`https://errors.company.com` today), so the SDK matches the type's path suffix and
  `errorCode`, never the full URI.
  `gatewayDenyCode(p)` returns `p.errorCode` when it is in `GATEWAY_DENY_CODES`. The UI reacts by code: `DENY_MFA_STALE` → step-up re-auth
  (`/auth` `reauthenticate`), `DENY_TENANT_READ_ONLY` → read-only state, `DENY_MALFORMED_IDENTITY` →
  sign in again, `DENY_UNRESOLVABLE_SUBJECT` → "workspace not ready / no access" with a bounded
  retry, never a sign-out (`/auth`, "First sign-in after signup").
- Any other non-2xx gives a synthetic problem built from `typeForStatus(status)`, with `traceId` from
  `X-Trace-ID`, `synthetic: true`, and no detail. The raw body is never surfaced.
- `typeId` is derived by stripping any base: the last two path segments of an absolute `type`.
  `about:blank` gives `undefined`.

#### `/http`

```ts
export interface TokenSource { getAccessToken(): Promise<string | undefined>;
  refresh(): Promise<boolean> /* single-flight */; onUnauthorized(): void }  // implemented by /auth
export interface RequestOptions<B = unknown> {
  params?: Record<string, string | number>;   // fills :name in the template (encoded)
  query?: Record<string, string | number | boolean | undefined>;
  body?: B; headers?: Record<string, string>;
  signal?: AbortSignal; timeoutMs?: number;
  retry?: false | { attempts?: number /* 2 */; unsafe?: boolean };
  idempotencyKey?: string;                   // POST default: auto UUID
  dedupe?: boolean;                          // GET default true
  auth?: boolean;                            // default true
}
export interface ApiResponse<T> { data: T; status: number; headers: Headers; requestId: string; traceId?: string }
export interface ApiClient {
  get<T>(template: RouteTemplate, o?: RequestOptions): Promise<ApiResponse<T>>;
  post<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  put<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  patch<T, B = unknown>(template: RouteTemplate, o?: RequestOptions<B>): Promise<ApiResponse<T>>;
  delete<T>(template: RouteTemplate, o?: RequestOptions): Promise<ApiResponse<T>>;
}
export type RouteTemplate = `/${string}`;   // e.g. '/tenders/:id' — the metric `route` label
export function createApiClient(o?: { baseUrl?: string; mfe?: string }): ApiClient;
export function setTokenSource(t: TokenSource): void;                 // shell only
export function isOnline(): boolean; export function subscribeOnline(l: (online: boolean) => void): () => void;
// gincommon's three identity headers plus the rest of the IAM ingress strip-list (IAM HLD §11.1)
export const FORBIDDEN_REQUEST_HEADERS: readonly ['x-user-id', 'x-tenant-id', 'x-tenant-roles',
  'x-departments', 'x-plan', 'x-feature-flags', 'x-residency-mode'];
```

Request pipeline (fixed order): offline check (short-circuit with `NetworkError{offline:true}`) →
build URL from `baseUrl + template(params)` → strip forbidden headers (throws in dev, drops and
logs in prod) → `x-request-id` (one per logical call, reused across retries) → trace headers (same
origin plus the exact-origin allowlist only) → `x-session-id` → `Authorization: Bearer` (same origin
only) → `Idempotency-Key` (POST) → timeout via `AbortSignal.any([caller, timeout])` → fetch →
on 401: if the token source already holds a newer access token than the one sent, retry once with it; otherwise
join the tab's single in-flight `refresh()` (§C1 `/auth`, never a refresh of its own), retry once, then
`onUnauthorized()` → retry policy → parse/throw `ApiError`.

Retry: only for GET/HEAD/PUT/DELETE/OPTIONS (or POST with `unsafe:true`) on `NetworkError`,
`TimeoutError`, 429, 502, 503, 504. Backoff is `min(cap, base·2^n)` with full jitter, and
`Retry-After` (seconds or HTTP-date, capped) wins. GET dedup: key = `method+url+auth-identity`,
shared promise, and an abort only cancels the shared fetch when every subscriber has aborted.
Metrics: `platform_web_http_client_duration_seconds{method,route,status_class,error_class,mfe}` and, for calls with no
HTTP status, `platform_web_http_client_failures_total{route,reason,mfe}` (via the instrument port; §C1 `/metrics`).

#### `/auth`

```ts
/** From the ID token only: `sub`, profile claims, `auth_time`, and `tenant_id` (trial realm only). No roles: the JWT has none. */
export interface SessionUser { readonly sub: string; readonly name?: string; readonly email?: string;
  readonly tenantId?: string; readonly authTime?: number /* epoch s */ }
/**
 * One login = one tenant (IAM RP-INV-2). A paid workspace has realm `tenant-<slug>`; trial shares `trial`.
 * `slug` is missing only on a pre-login trial result from an invitation email (PUB-1 returns none); such a
 * Workspace is used for that one login and never cached. After sign-in the slug is known (§D6 A) and it is cached.
 */
export interface Workspace { readonly realm: string; readonly trial: boolean; readonly slug?: string;
  readonly tenantIdHint?: string /* trial only, from PUB-1; optional, IAM may remove it (OQ-10). Used only for the
                                    wrong-workspace check after login (see "Choosing the realm") */ }
/** What the gateway knows and the browser cannot see (roles, departments, plan, flags). UI hints only. */
export interface SessionContext {
  readonly tenantId: string; readonly slug: string /* the tenant's workspace slug (§D6 A); trial tokens do not carry it */;
  readonly roles: readonly string[];
  readonly departments: readonly { readonly id: string; readonly level: string }[];
  readonly plan?: string; readonly featureFlags: readonly string[]; readonly readOnly: boolean;
  readonly mfaFreshnessSeconds?: number; readonly locale?: string;
}
/** Ports the shell implements with an /http ApiClient, so /auth never imports /http. */
/** PUB-1: GET /api/v1/public/tenants/resolve?identifier= (slug or pending-invite email). Called on the same origin
 *  (`api.baseUrl`), so CORS does not apply. IAM's route is GET-only with no OPTIONS route: if it is ever called
 *  cross-origin, it must stay a CORS simple request (no custom headers, so no traceparent/x-request-id). */
export interface WorkspaceResolver {
  resolve(identifier: string, signal?: AbortSignal): Promise<Workspace | undefined>; // {found:false} → undefined
}
/** IAM item A (FE-Q4): O&M P-35 `GET /api/v1/me/session-context` (O&M PR #42), snake_case → camelCase.
 *  404 MEMBER_NOT_FOUND = no membership; 403 = suspended member or a trial_expired/suspended tenant. `roles` always
 *  includes `member`; lists are [] and never null. `feature_flags` includes `read_only` when the tenant is read-only,
 *  same as the gateway's x-feature-flags. `slug` is the caller's own workspace slug (§D6 A, O&M #46). */
export interface SessionContextSource { load(signal?: AbortSignal): Promise<SessionContext> }
export type SessionState =
  | { status: 'loading' }
  | { status: 'anonymous'; workspace?: Workspace;
      /** 'signed-out': the signed-out mark is set, so never log in automatically.
       *  'login-required': a prompt=none attempt for `workspace` answered login_required/interaction_required/consent_required.
       *  'none': no session and no hint (first visit, rejected callback, loop guard). */
      reason: 'none' | 'signed-out' | 'login-required' }
  | { status: 'authenticated'; user: SessionUser; workspace: Workspace; expiresAt: number }
  | { status: 'expired'; workspace?: Workspace;
      serverEnded: boolean;   // true: invalid_grant before refresh_expires_in
      idle: boolean };        // true: the SDK idle timeout ended it (signing in again must ask for credentials)
// `expired` happens only during use (a failed refresh or the idle timeout), never from init(): a page load has no tokens.
export interface IdentityProvider {
  /** Callback (?code= or ?error=) → exchange or anonymous; no tokens + cached workspace → one prompt=none redirect per tab
   *  (the promise never settles, the page unloads); otherwise anonymous. See "Restoring a session". Resolves only to
   *  `authenticated` or `anonymous`. */
  init(): Promise<Extract<SessionState, { status: 'authenticated' | 'anonymous' }>>;
  /** `prompt: 'login'` forces credentials even when Keycloak's SSO session is alive (used after the idle timeout). */
  login(o: { workspace: Workspace; returnUrl?: string; loginHint?: string; prompt?: 'login' }): Promise<void>;
  /** Local: drop tokens, clear storage, set the signed-out mark. Global: also ends the Keycloak SSO session
   *  (see "Logout"). */
  logout(o?: { global?: boolean }): Promise<void>;
  getAccessToken(): Promise<string | undefined>;
  refresh(): Promise<boolean>;   // single-flight per tab: concurrent callers share one in-flight refresh
  switchWorkspace(w: Workspace): Promise<void>;  // local logout of the current realm, then login(w)
  /** Step-up: top-level redirect with prompt=login&max_age=<s> (IAM HLD §11.3). */
  reauthenticate(o: { maxAgeSeconds: number; returnUrl?: string }): Promise<void>;
  needsStepUp(maxAgeSeconds: number): boolean;   // now − auth_time > maxAgeSeconds; false when unknown
  subscribe(l: (s: SessionState) => void): () => void;
  /** Runs synchronously before any SDK-started top-level redirect (step-up, lineage restore, login, switch), so
   *  remotes can save drafts to session storage. Listeners must not throw or await; errors are logged and ignored. */
  beforeRedirect(l: (r: { reason: 'step-up' | 'restore' | 'login' | 'switch' }) => void): () => void;
  getState(): SessionState;
}
/** `/t/<slug>/…` → '<slug>'; anything else → undefined. Pure. A slug does NOT say whether the tenant is paid or trial. */
export function slugFromPath(pathname: string, cfg: RuntimeConfig['auth']): string | undefined;
/** Cached Workspace for `slug` (or the most recent one when omitted). Keyed by slug; every cached entry has one. SDK-reserved localStorage key, outside /storage namespaces. */
export function cachedWorkspace(slug?: string): (Workspace & { slug: string }) | undefined;
/** Shell only, after sign-in: caches the signed-in Workspace with its slug (paid: from the realm; trial: SessionContext.slug)
 *  and replaces the URL with `/t/<slug>/…` when it has no slug. */
export function rememberWorkspace(w: Workspace & { slug: string }): void;
/**
 * Realm choice before login (see "Choosing the realm"): slug from path → cached Workspace for it, else resolver.resolve(slug);
 * no slug in path → the most recent cached Workspace. undefined → identifier-first screen.
 */
export function chooseWorkspace(o: { pathname: string; resolver: WorkspaceResolver; cfg: RuntimeConfig['auth'];
  forceResolve?: boolean; signal?: AbortSignal }): Promise<Workspace | undefined>;
/** Wrong-workspace check: true when `w` is a trial Workspace with a `tenantIdHint` and the token's `tenant_id` differs.
 *  False without a hint. The shell must not call rememberWorkspace() when it is true. Pure. */
export function isWrongWorkspace(w: Workspace, user: SessionUser): boolean;
/** Sign in again after `expired` (see "Session expiry during use"): chooseWorkspace with
 *  `forceResolve: state.serverEnded`, falling back to `ask()`, then idp.login() back to the current URL,
 *  with `prompt: 'login'` when `state.idle`. */
export function signInAgain(o: { idp: IdentityProvider; state: Extract<SessionState, { status: 'expired' }>;
  resolver: WorkspaceResolver; cfg: RuntimeConfig['auth']; ask: () => Promise<Workspace> }): Promise<void>;
export function createOidcProvider(cfg: RuntimeConfig['auth'], resolver: WorkspaceResolver): IdentityProvider; // Auth Code + PKCE (S256)
export function initializeAuth(p: IdentityProvider): TokenSource;                 // shell only; wires /http
export function getSession(): SessionState;
```

Rules: tokens are held in a closure only, never in storage or a global. Silent refresh uses the
refresh-token grant at `exp − 60 s ± jitter`. Access tokens live 5 minutes; the client session (refresh
token) lasts 8 h idle / 12 h max, and the SSO session 12 h / 24 h (HLD §11.3, set on `tender-web` by RP #41).
So `idleTimeoutMs` must not exceed 8 h.

Endpoints. Built from Keycloak's fixed paths, with no discovery fetch: issuer `${idpOrigin}/realms/${realm}`,
then `/protocol/openid-connect/auth`, `/token` and `/logout` under it. The realm comes only from a
Workspace, which `chooseWorkspace` has already sanity-checked against `paidRealmPrefix`/`trialRealm`.

Login and callback. Every authorize redirect (login, `prompt=none` restore, step-up, switch) first writes a
**pending-login record** to `sessionStorage` under an SDK-reserved key per `state`:
`{ state, codeVerifier, nonce, workspace, returnUrl, reason, createdAt }`. It holds the full Workspace,
because the callback needs the realm to pick the token endpoint and the hint for the wrong-workspace check.
`state` and `nonce` are 128-bit random values, and the verifier is 32 random bytes (S256). Records expire
after 10 minutes. The callback deletes its record before the token exchange, so the code can be used once,
and also deletes any expired record. On `?code=` or `?error=`, `init()` checks, in order:
1. `state` matches an unexpired record. Otherwise the callback is ignored: the parameters are stripped,
   a `warn` is logged, and the restore path continues as if there were no callback.
2. The `iss` response parameter (RFC 9207) equals the record's issuer. Keycloak sends it by default.
   If it is missing or different, the callback is rejected: a code from one realm is never exchanged at
   another. The state ends `anonymous` (`reason: 'none'`), with an `error` log.
3. Only then is the code exchanged (`grant_type=authorization_code`, `code_verifier`, `redirect_uri`,
   `client_id`) at the record's realm token endpoint.
4. The ID token's claims: `iss` equals the issuer; `aud` contains `clientId`; `azp`, if present, equals
   `clientId`; `nonce` equals the record's; and `exp`/`iat` are valid within 60 s of skew. The signature
   is not checked in the browser, because the token came straight from the token endpoint over TLS (OIDC
   Core §3.1.3.7). The access token is opaque to the SDK and is never parsed.
5. In the trial realm, the ID token must carry a valid `tenant_id`. Without one, the session is still
   `authenticated` (the gateway decides access), but `/storage` stays on `anon` and an `error` is logged.

Any failed check discards the tokens. `returnUrl` passes `isSafeRedirect` before it is used.

Callback location. Keycloak always returns to the fixed `redirectPath`, not to the page the user was on.
Once the callback is handled (code exchanged, `?error=` handled, or callback rejected), `init()` replaces the
URL with the record's `returnUrl` via `history.replaceState`, before it resolves. If there is no record or
the `returnUrl` fails `isSafeRedirect`, it uses `/`. The shell therefore never sees `redirectPath`, and
`chooseWorkspace()` reads the slug of the page the user actually opened.

Refresh across tabs. `tender-web` rotates refresh tokens with max reuse 0, realm-wide (RP #41). Each tab gets
its own token lineage from its own code exchange (login or silent restore), refreshes only that lineage,
and never shares or forwards a token. There is no refresh leader.
**Verified (§D6 L, RP #44):** Keycloak 26 tracks reuse per lineage (one per code exchange), not per
session. IAM's integration test signs one user in to `tender-web` twice in one SSO session, then refreshes
the two lineages alternately for 5 rounds; all 10 refreshes succeed with RP #41's settings unchanged. Two
consequences for the refresh code:
- **Never send a refresh token that has already been replaced.** Keycloak treats it as reuse and revokes the
  whole SSO session, which signs out **every** tab (`invalid_grant`, read as `serverEnded: true`).
- **One refresh at a time per tab (single-flight).** `refresh()` keeps one in-flight promise per tab. The
  timer, `/http`'s 401 handling and any direct caller all await that promise and share its result. A new
  refresh starts only after it settles, and always with the token it returned. A request that got a 401
  using an older access token than the current one retries with the current token and does not refresh.
  Without this, a page firing several calls as the token expires sends the same refresh token several times,
  and everyone is signed out.
- **Do not retry a refresh with the old token** after a failure that may have reached Keycloak (timeout,
  network error after send): the token may already have rotated. The tab drops the lineage and restores it
  with a new silent code exchange (`prompt=none`), which is a full page reload:
  1. While offline, wait for the `online` event; the tab keeps no usable token meanwhile, and `/http` calls
     fail with `NetworkError{offline:true}` as usual.
  2. Run the `beforeRedirect` listeners, so remotes save drafts as they do for step-up.
  3. Redirect, with the current URL as `returnUrl`.

  A refresh that fails **before** sending (offline at the start) keeps its token and is retried normally,
  because the token was never sent.

Reuse detection compares the token's `iat` in whole seconds (RP LLD v1.45 §12.2); this does not affect a
client that follows the rules above.

A `BroadcastChannel('platform-auth')` carries `logout` and `workspace-switched` between tabs, never a token.
The idle timeout uses activity events (debounced) shared across tabs.

Logout. Every logout drops the tokens, runs `clearAllAppStorage()`, rotates the session id, sets the
signed-out mark and broadcasts `logout`. A **global** logout then navigates to the realm's `/logout`
endpoint with `id_token_hint`, `client_id=tender-web` and `post_logout_redirect_uri=<app origin>/`, a URI
RP #41 registers on `tender-web`. Keycloak 26 requires `id_token_hint` or `client_id` when a post-logout
redirect is given. This is the only reason the ID token is kept, in memory, next to the access token.
If no ID token is held, it sends `client_id` alone, and Keycloak shows its logout confirmation page.

Restoring a session. Because tokens are memory-only and the channel never carries one, every full page
load starts with no tokens: an F5, a new tab, `reloadOnceForChunkError`, and `useAppUpdate().reload()`.
(The step-up and login redirects are not affected: they return with `?code=`.) `init()` therefore runs:
1. **Callback:** `?code=&state=` that passes the checks in "Login and callback" → token exchange → `authenticated`. An
   `?error=login_required|interaction_required|consent_required` answering a `prompt=none` attempt →
   `anonymous` with that record's workspace and `reason: 'login-required'`. Both move the URL to the
   record's `returnUrl` (see "Callback location").
2. **Silent restore:** no callback and no tokens. The workspace to restore is:
   - URL has a slug: `cachedWorkspace(slug)`. If there is **no entry for that slug, skip step 2**. Never fall
     back to another cached workspace: opening a `/t/globex` link with `acme` cached would otherwise
     sign the user into `acme` under a `globex` URL. `chooseWorkspace` then resolves the slug (step 3).
   - URL has no slug: the most recent `cachedWorkspace()`.

   With a workspace, `init()` does a top-level redirect to that realm's authorize endpoint with
   `prompt=none` and the current URL as `returnUrl`. Keycloak's SSO cookie on `auth.bcbpsolutions.com` is
   same-site with the app origin, so browsers that block third-party cookies still send it; there is no
   iframe. A valid SSO session signs the user in with no prompt.
3. Otherwise → `anonymous`: `reason: 'signed-out'` when the signed-out mark is set, else `'none'`.

What the shell does with `anonymous` (§C2 step 7):
- `'signed-out'`: shows a "you are signed out" screen with a **Sign in** button. It never calls `login()`
  on its own; otherwise the still-live Keycloak SSO session would undo a local logout at once.
- `'login-required'`: calls `login({ workspace: session.workspace })` (interactive), with no PUB-1 call
  and no cache lookup. That is the workspace the silent attempt was for.
- `'none'`: runs "Choosing the realm" below, then `login()`.

Loop guard: one `prompt=none` attempt per tab, marked in `sessionStorage` before the redirect and
cleared only when `init()` ends `authenticated`. A load that finds the mark and no callback skips step 2.
Explicit logout sets an SDK-reserved signed-out mark (localStorage, shared by tabs) that also skips
step 2 until the next interactive login; without it, a local (non-`global`) logout would be undone by
the next reload, because the Keycloak SSO session outlives it.

Cost: one Keycloak round trip (two redirects plus the token `fetch`) on every full page load or new tab,
roughly the latency of a normal login with an SSO cookie. It does not count against the PUB-1 rate
limit, because a cached workspace is used. The SPA renders no route until `init()` settles, so nothing
flashes before the redirect.

Tenant model (§D2), as IAM implements it:
- The gateway derives the tenant from the validated token, never from a browser header: a paid
  realm's `iss` maps to its tenant, and the trial realm uses the `tenant_id` claim from a protocol
  mapper (HLD §5.4; AuthZ Enrichment rule AE-SEC-1). `SessionUser.tenantId` is the same claim, display only.
- **One login is one tenant.** A trial user has a single `tenant_id` attribute, and a paid tenant's
  users are separate accounts in that tenant's realm (Realm Provisioner rule RP-INV-2). There is no
  cross-realm tenant list and no in-session tenant switch; switching means signing in to another workspace.

Choosing the realm (HLD §8.2.7), before any token exists. `chooseWorkspace()` implements steps 1–3:
1. **Slug:** `slugFromPath(location.pathname)` → step 2. No slug in the path → the most recent
   `cachedWorkspace()`, and stop. Every emailed link lands on `/t/<slug>/` (§D6 F), so a first login
   normally comes through the path.
2. **Slug → Workspace:** `cachedWorkspace(slug)` if present, otherwise `resolver.resolve(slug)` (PUB-1),
   whose result is cached. A slug alone is not enough, because **trial tenants also have `/t/<slug>`
   links** (HLD §8.2.7) and belong to the shared `trial` realm. Building `tenant-<slug>` blindly would
   send a trial user to a realm that does not exist, and Keycloak would show its own 404 page, which the SPA never sees.
   The cache comes first because PUB-1 is rate-limited per IP (20/h starting point, HLD §8.2.7), and
   many users behind one office NAT would exhaust it if every login called it. A resolved paid realm
   must equal `${paidRealmPrefix}${slug}` and a trial one must equal `trialRealm`; otherwise the
   response is rejected and not cached.
3. **No slug:** the shell shows the identifier-first screen (FE spec A2) and calls
   `resolver.resolve(identifier)`. PUB-1 resolves a **company slug** or a **pending invitation's
   email**. An active member's email does not resolve (O&M LLD OQ-11, decided), so returning users
   on a new device need their slug or a bookmarked `/t/<slug>` link. `undefined` shows the generic
   "workspace not found" message, never which input failed. For an email the response has no slug.
   A paid realm must start with `paidRealmPrefix`, and the slug is the rest of the realm name. A trial
   result has no slug, and is used for this one login without being cached.

After sign-in, the shell calls `rememberWorkspace()` with the slug: derived from the realm for a paid
tenant, or taken from `SessionContext.slug` (§D6 A) for a trial tenant. Only then is the workspace cached,
and the URL becomes `/t/<slug>/…`, so the user's next visit or bookmark carries the slug. If the session
context cannot be loaded, nothing is cached, and the next visit shows the identifier-first screen
again. PUB-1 is not asked to return a slug, because returning one for an invitation email would
disclose the company slug to whoever knows that email.

Wrong-workspace check (IAM's answer on the PUB-1 hint): when a trial Workspace carries `tenantIdHint` and
the token's `tenant_id` differs after login (`isWrongWorkspace`), the shell shows "you signed in to a different workspace"
with sign-out and switch-workspace actions, and does not cache it. Without a hint, nothing is checked.
Keycloak needs no hint, because emails are unique in the `trial` realm. The field is optional, so the
check simply stops running if OQ-10 removes it.

`forceResolve: true` skips the cache. The shell passes it only when the session was
**ended by the server early**, not on every expiry:
- **Early end:** a refresh fails with `invalid_grant` before the refresh token's own expiry. The SDK
  records that expiry from each token response's `refresh_expires_in`, so it can tell the two cases
  apart. This is what trial → paid conversion looks like (sessions terminated, RP-3), and also an admin
  revocation. The `expired` state carries `serverEnded: true`.
- **Natural end:** 8 h idle or 12 h absolute (HLD §11.3), or the SDK idle timeout. `serverEnded: false`, and
  the cache is reused. Without this split, every user would call PUB-1 at least once a day, and an
  office behind one NAT would hit its per-IP limit.

Session expiry during use. `expired` is a runtime transition. It comes from a refresh that fails with
`invalid_grant` or reaches the refresh token's own expiry, or from the SDK idle timeout. A page load never
produces it. The ambiguous refresh failure is not `expired`: it restores silently (see "Refresh across
tabs"). On `expired`:
- `/auth` drops the tokens. Pending and later API calls get a 401, and `onUnauthorized()` is a no-op while
  the state is `expired`.
- The shell (subscribed via `idp.subscribe`) shows a blocking "your session has ended" dialog with a
  **Sign in** action. It never redirects on its own: a background tab that redirected by itself would lose
  state the user cannot see, and an idle timeout must not log the user straight back in. For
  `serverEnded: true`, the dialog copy covers trial → paid conversion ("your workspace has moved").
- **Sign in** calls `signInAgain()`: `chooseWorkspace({ forceResolve: serverEnded })`, falling back to the
  identifier screen, then `login()`. `login()` runs the `beforeRedirect` listeners, so drafts are saved.
- After the **idle timeout** (`idle: true`), `signInAgain()` logs in with `prompt=login`. Keycloak's SSO
  session outlives the SDK idle timeout, so a plain login would sign the user straight back in without
  credentials, and the timeout would protect nothing. Every tab shares the activity signal, so every tab
  idles out together.
- Other tabs follow independently: each tab has its own lineage, so a server-ended session reaches each of
  them at its next refresh. A `logout` broadcast ends them at once.

A slug in the URL always takes precedence over the cache (step 1). If PUB-1 is unreachable or
rate-limited, a cached entry is still used. A bare URL never falls back to the trial
realm silently, because a paid user would land in the wrong realm.

Entry links (HLD §8.2.7 "already carries enough context"). Every first login starts from a
`/t/<slug>/` URL. The realm itself still comes from step 2, never from the link. These are backend
changes the SDK relies on (§D6), not cases it works around:
- **Signup owner:** bff-signup's page is on `signup.bcbpsolutions.com` (BFF LLD §10.4), another origin,
  so it cannot write this SDK's cache. It hands off by linking to `app.bcbpsolutions.com/t/<slug>/`,
  which needs the slug in the completed signup response (§D6 G).
- **Verification email:** carries `client_id=tender-web` and `redirect_uri=https://app.bcbpsolutions.com/t/<slug>/` (§D6 F).
- **Invitation email:** sent by Realm Provisioner with the same parameters (§D6 F).

Typing an invitation email on the identifier screen still works while the invitation is pending.
It is a fallback, not the main path.

First sign-in after signup (BFF LLD G-3). Realm Provisioner sends the verification email before
org-membership creates the tenant row, so a fast user can sign in before a membership exists. Every
API call is then denied `403 DENY_UNRESOLVABLE_SUBJECT`, and AuthZ Enrichment caches that answer for
5 s (`AE_NEG_TTL`). The same code also means a removed member, or (since AE-47, AuthZ Enrichment #36) a
suspended one, and the SDK cannot tell these apart. IAM confirmed this handling (no IAM change for G-3).
Rule: the shell (via `useSessionContext`'s load and `/problem`'s `gatewayDenyCode`) shows "your
workspace is being set up" and retries the session-context load at 6 s, 12 s and 24 s (each past the
negative-cache TTL); after that it shows "you do not have access to this workspace" with sign-out and
switch-workspace actions. It never signs the user out or clears the cache on its own, and never
retries the original mutating request.

`switchWorkspace(w)`: local logout of the current realm (`clearAllAppStorage()`, rotate the session
id, broadcast `workspace-switched`), then `login({ workspace: w })`. Old-realm tokens are discarded,
never exchanged.

Trial → paid conversion (HLD §8.10.2): the tenant moves to realm `tenant-<slug>` (from RP #46 on; before that, RP-3 named it `tenant-<tenant_id>`, §D6 N) and trial sessions are
terminated (`shared_sessions_terminated`, RP-3). The next refresh fails with `invalid_grant` before the
refresh token's expiry, so the state becomes `expired` with `serverEnded: true`, and the shell runs the
realm choice again with `forceResolve: true`; resolving the slug now returns
the dedicated realm, which replaces the cached `trial` entry. The
welcome screen (FE spec A5) is the shell's, never an error. The "your workspace has moved" email
(§8.10.2 step 8) is sent by the Notification Service from `TenantConverted` (§D6 M); the SDK does not
depend on it.

Step-up MFA: an approver-gated request outside the tenant's window is denied with
`403 DENY_MFA_STALE` (AuthZ Enrichment §8.4, which compares the token's `auth_time` with
`mfa_freshness_seconds`). Before an approve action the UI checks
`needsStepUp(ctx.mfaFreshnessSeconds)` and calls `reauthenticate()` first. On a `DENY_MFA_STALE`
response it does the same. The request is **never auto-retried** after the redirect: the user confirms again.
The redirect is a full page reload, so in-memory form state is lost. Before redirecting, the remote saves
(from its `useBeforeAuthRedirect` callback, which also runs before a lineage restore) its draft with `storage(appId, { area: 'session' }).set('draft:<form-id>', value)`. That is tab-scoped,
inside the workspace namespace, and refused for token-like keys. After the return it restores the draft
and removes it. `clearAllAppStorage()` on logout or workspace switch drops any draft left behind.
`reauthenticate()` passes a `returnUrl` that brings the user back to the same form.

#### `/authz`

```ts
export interface AuthzSubject { readonly roles: readonly string[]; readonly tenantId?: string }
export interface Authorizer { authorize(user: AuthzSubject | undefined, action: string, resource: string): boolean }
export const denyAll: Authorizer;                                     // default
export function roleMapAuthorizer(map: Record<string /*role*/, readonly `${string}:${string}`[] /*action:resource, '*' allowed*/>): Authorizer;
export function setAuthorizer(a: Authorizer): void;                    // shell only
export function setAuthzSubject(s: AuthzSubject | undefined): void;    // shell only, from SessionContext
export function hasPermission(action: string, resource: string): boolean; // false before init, false on throw
```

The subject's roles come from `SessionContext.roles` (the `SessionContextSource` port), never from
the token, which has none (§0 row 10). Until the session context loads (or if it fails to), the subject
stays `undefined` and every check is denied. Roles are parsed with the backend rule: tokens `^[a-zA-Z0-9_-]+$`, ≤64 B, dedup, ≤64 roles, otherwise fail-closed
to `[]`. This is UI gating only, and the docs say so on every export.

#### `/mfe`

```ts
export interface RemoteManifest { readonly [name: string]: { readonly entry: string /* '/remotes/<name>/<ver>/remoteEntry.js' */;
  readonly version: string; readonly ownerDomain: string; readonly integrity?: string } }
export function loadManifest(url?: string /* '/remotes/manifest.json' */): Promise<RemoteManifest>; // shell only
export function loadRemote<T = unknown>(name: string, module: `./${string}`,
  o?: { timeoutMs?: number; retries?: number; signal?: AbortSignal }): Promise<T>;
export class RemoteDisabledError extends Error { readonly remote: string }   // kill switch
export class RemoteLoadError extends Error { readonly remote: string; readonly cause: unknown }
export function isChunkLoadError(e: unknown): boolean;
export function reloadOnceForChunkError(e: unknown): boolean;   // sessionStorage guard keyed by version.json
export function startVersionPolling(o?: { url?: string; intervalMs?: number }): () => void;
export function subscribeAppUpdate(l: (u: { current: string; available: string }) => void): () => void;
```

`entry` must be same-origin or in `remotes.allowedOrigins`. Otherwise it is rejected before the
`<script>` is created. Load time goes to `platform_web_remote_load_seconds{mfe,outcome}`, and failures to
`platform_web_remote_load_failures_total{mfe,reason}`.
Each manifest entry also carries `ownerDomain` (a registry domain). It is used for alert
routing by `mfe` and is never emitted as a second `domain` label on Tier 1 metrics, logs or traces.
`loadManifest` validates every `ownerDomain` against the registry domains and publishes
`{ [mfe]: ownerDomain }` to `PlatformRuntime.remotes`, which `/metrics` reads for Tier 2/3 identity.

#### `/nav`

```ts
export function registerNavigator(n: (appId: string, path: string, o?: { replace?: boolean }) => void): void; // shell
export function navigate(appId: string, path: string, o?: { replace?: boolean }): void;
export function isSafeRedirect(url: string, base?: string): boolean; // same origin, http(s), no '//' or '\\' tricks, no control chars
```

#### `/i18n`

```ts
export function initializeI18n(o: { defaultLocale: string; supported: readonly string[];
  detect?: () => string | undefined }): Promise<string>;
export function setLocale(locale: string): Promise<void>;  // sets <html lang dir>; 'ar*' → rtl
export function registerNamespace(mfe: string, loader: (locale: string) => Promise<Record<string, string>>): void;
export function t(ns: string, key: string, vars?: Record<string, string | number>): string;
export function formatMoney(v: number, currency?: string /* 'AED' */): string;
export function formatDate(d: Date | number, o?: Intl.DateTimeFormatOptions): string;
export function formatNumber(n: number, o?: Intl.NumberFormatOptions): string;
export function problemMessage(p: ProblemError): string;   // key `problem.<typeId>` → fallback p.title
```

ICU-lite interpolation with no `eval`. Plural rules come from `Intl.PluralRules`.

#### `/flags`

```ts
export type FlagValue = boolean | string | number;
export interface FlagProvider { get(key: string): FlagValue | undefined; subscribe(l: () => void): () => void }
export function runtimeConfigFlagProvider(): FlagProvider;   // default
/** Runtime-config flags, plus the tenant's `featureFlags` (presence = true, as in x-feature-flags) and `read_only`. */
export function sessionContextFlagProvider(ctx: { featureFlags: readonly string[]; readOnly: boolean }): FlagProvider;
export function setFlagProvider(p: FlagProvider): void;      // shell only
export function getFlag<T extends FlagValue>(key: string, fallback: T): T;
export function isRemoteKilled(remote: string): boolean;     // runtime config killSwitch ∪ flag `remote.<name>.disabled`
```

Flag names are opaque strings: IAM accepts both `sso_enabled` and dotted names like
`llm.refiner.query` (HLD §5.4). Platform flags (kill switches, rollout) come from runtime config;
plan and tenant flags come from `SessionContext` (P-35), once it has loaded.

#### `/storage`

```ts
export interface AppStorage { get<T>(key: string): T | undefined; set(key: string, v: unknown): void;
  remove(key: string): void; clear(): void }
export function storage(appId: string, o?: { area?: 'local' | 'session' }): AppStorage; // key = `${ns}:${appId}:${key}`
export class ForbiddenStorageKeyError extends Error {}   // isSensitiveKey(key) → throws
export function clearAllAppStorage(): void;              // called on logout and workspace switch
/** Namespace for a workspace; /auth sets it on the PlatformRuntime at login, /storage only reads it. */
export function workspaceNamespace(w: { realm: string; trial: boolean }, trialTenantId?: string): string;
```

Namespace `ns`, derived from what the browser actually knows. Paid tokens carry no `tenant_id`,
and the session context (IAM item A) may be missing:
- Paid workspace: the realm, e.g. `tenant-acme`. One realm is one tenant.
- Trial workspace: `trial:<tenant_id claim>`. The trial realm is shared, so the realm alone would mix tenants.
- No session yet, or a trial token without a valid `tenant_id`: `anon`. `set` on an `anon` store is a
  no-op that logs a dev warning, so nothing is written that a later tenant could read.

`clearAllAppStorage()` removes every SDK-namespaced key (`<ns>:*`) in both areas. It does not remove the
SDK-reserved workspace cache (`cachedWorkspace`), which holds only slug, realm and the trial flag, and
which the next login needs.

#### `/security`

```ts
export function sanitizeHtml(dirty: string, o?: { allowLinks?: boolean }): TrustedHTML | string;
export function installTrustedTypesPolicy(): void;  // policy name 'platform-sdk'; idempotent
export function isAllowedOrigin(url: string, allowlist: readonly string[]): boolean;
```

#### `/react`

```ts
export function PlatformProvider(p: { children: ReactNode; shell: ShellContextValue }): JSX.Element; // shell only
export interface ShellContextValue { user?: SessionUser; workspace?: Workspace; context?: SessionContext;
  locale: string; switchWorkspace(identifierOrSlug: string): Promise<void> }
export function useSession(): SessionState;
export function useCurrentUser(): SessionUser | undefined;
export function useWorkspace(): Workspace | undefined;
export function useSessionContext(): SessionContext | undefined;   // undefined until loaded (IAM P-35)
export function useBeforeAuthRedirect(save: () => void): void;     // IdentityProvider.beforeRedirect, unsubscribed on unmount
export function useReadOnly(): boolean;                            // SessionContext.readOnly or a DENY_TENANT_READ_ONLY seen
export function useStepUp(): { needed: boolean; reauthenticate(): Promise<void> }; // uses ctx.mfaFreshnessSeconds
export function useLocale(): { locale: string; dir: 'ltr' | 'rtl' };
export function useSwitchWorkspace(): (identifierOrSlug: string) => Promise<void>;
export function useFeatureFlag<T extends FlagValue>(key: string, fallback: T): T;
export function useHasPermission(action: string, resource: string): boolean;
export function Can(p: { action: string; resource: string; children: ReactNode; fallback?: ReactNode }): JSX.Element | null;
export function useApi<T>(fn: (api: ApiClient, signal: AbortSignal) => Promise<T>, deps: unknown[]):
  { data?: T; error?: ApiError; loading: boolean; reload(): void };   // aborts on unmount / deps change
export function useApiClient(): ApiClient;                            // bound to the nearest MFE scope
export function useRouteTemplate(template: RouteTemplate): void;      // registers current page template
export function useOnlineStatus(): boolean;
export function useAppUpdate(): { available: boolean; reload(): void };
export function useT(ns: string): (key: string, vars?: Record<string, string | number>) => string;
export function MFEErrorBoundary(p: { mfe: string; children: ReactNode;
  fallback?: (e: ErrorInfoView) => ReactNode }): JSX.Element;
export function RemoteBoundary(p: { remote: string; module: `./${string}`;
  fallback?: ReactNode; props?: Record<string, unknown> }): JSX.Element; // lazy loadRemote + Suspense + MFEErrorBoundary
export interface ErrorInfoView { traceId?: string; requestId?: string; message: string; retry(): void }
export function installGlobalErrorHandlers(): () => void;              // window error + unhandledrejection + securitypolicyviolation
// securitypolicyviolation → redacted essential `warn` log (violatedDirective, blockedURI origin only), so
// violations after bootstrap reach Loki with trace/session correlation; /csp-report covers pre-bootstrap ones.
```

#### `/testing`

```ts
export function createTestPlatform(o?: Partial<{ identity: CoreIdentityInput; config: Partial<RuntimeConfig>;
  user: SessionUser; workspace: Workspace; context: Partial<SessionContext>;
  permissions: readonly `${string}:${string}`[]; flags: Record<string, FlagValue> }>):
  { Wrapper: ComponentType<{ children: ReactNode }>; logs: LogRecord[]; spans: SpanRecord[]; reset(): void };
export function mockProblem(t: ProblemType, extra?: Partial<ProblemDetails>): Response;
export function mockApi(routes: Record<`${'GET'|'POST'|'PUT'|'PATCH'|'DELETE'} /${string}`, Response | ((req: Request) => Response)>): void;
/** Prometheus text exposition of every instrument registered so far (one sample per label set seen), with the injected
 *  domain/service/environment, for `metricslint check` in a remote's CI. Names are the registry names (§C5 drift item 4). */
export function renderMetricInventory(): string;
```

---

## C2. Shell bootstrap sequence

```
index.html ─► bootstrap.ts (async import boundary required by MF)
 1. installTrustedTypesPolicy()                                       /security
 2. initializeCore({serviceName,domain,environment,buildVersion})     build-time constants; throws → static error page
 3. cfg = await loadRuntimeConfig()                                   GET /config/runtime.json (no-cache) → zod → freeze
    setRuntimeConfig(cfg)                                             failure → static "unavailable" page + console only
 4. setConsentProvider(cmp)                                           before any telemetry export
 5. initializeTracing / initializeLogging / initializeMetrics         exporters to /otel; never throw outward
    installGlobalErrorHandlers(); startWebVitals()
 6. setFlagProvider(runtimeConfigFlagProvider())
 7. idp = createOidcProvider(cfg.auth, workspaceResolver)           workspaceResolver/sessionContextSource: shell-implemented ports
    tokenSource = initializeAuth(idp); setTokenSource(tokenSource)
    state = await idp.init()                                          ?code=/?error= callback, else one prompt=none restore per tab
    anonymous, reason:                                                init() never returns expired (a page load has no tokens)
      'signed-out'     → signed-out screen; login only on the user's click
      'login-required' → idp.login({workspace: state.workspace, returnUrl})   no PUB-1, no cache lookup
      'none'           → workspace = chooseWorkspace() ?? identifier-first screen + resolve(); idp.login({workspace, returnUrl})
    isWrongWorkspace(state.workspace, state.user) → wrong-workspace screen (sign out / switch), stop
    idp.subscribe: expired → "session ended" dialog → signInAgain()   runtime only; forceResolve = serverEnded, prompt=login if idle
 8. ctx = await sessionContextSource.load()                           IAM item A; on failure ctx = undefined (deny-all, no tenant flags)
    setAuthorizer(roleMapAuthorizer(...)); setAuthzSubject(ctx && {roles: ctx.roles, tenantId: ctx.tenantId})
    rememberWorkspace({...workspace, slug: ctx.slug})  (when ctx exists; never for a wrong workspace)   caches it, URL → /t/<slug>/
    setFlagProvider(sessionContextFlagProvider(ctx))  (when ctx exists)
    await initializeI18n(cfg.i18n)                                    sets <html lang dir>
 9. manifest = await loadManifest()                                   GET /remotes/manifest.json
    startVersionPolling()
10. createRoot(...).render(<PlatformProvider shell={...}><Routes/></PlatformProvider>)
    Routes render <RemoteBoundary remote module/> lazily: kill switch → timeout → retry → ChunkLoadError reload-once
```

Failure policy: steps 2–3 are fatal (static fallback, no SDK telemetry possible). Step 5 is
never fatal. Step 7 is fatal only for routes that need auth. Step 9 failure renders the shell with
every remote slot in fallback. A remote run standalone (`npm start` in the remote) skips all of
this: every API returns no-op or anonymous defaults (`denyAll`, empty flags, console logger),
except `getConfig()`, which remotes call through `tryGetConfig()`.

---

## C3. Module Federation and CloudFront

### `@platform/webpack-preset`

```ts
// shared — identical in shell and every remote; generated from the preset's own package.json pins
export const platformShared = {
  react:                     { singleton: true, strictVersion: true, requiredVersion: '^18.3.0' },
  'react-dom':               { singleton: true, strictVersion: true, requiredVersion: '^18.3.0' },
  '@opentelemetry/api':      { singleton: true, strictVersion: true, requiredVersion: '~1.10.0' }, // OTel JS 3 needs >=1.10 <1.11
  '@platform/frontend-sdk':  { singleton: true, strictVersion: true, requiredVersion: '^1.0.0-0' },
  // subpaths share the same instance: MF keys by request, so each used subpath is listed
  ...Object.fromEntries(SUBPATHS.map(s => [`@platform/frontend-sdk/${s}`,
      { singleton: true, strictVersion: true, requiredVersion: '^1.0.0-0' }])),
} as const;
// shell: eager:false for all; remotes: import:false for the SDK (must come from the shell, never bundled)
```

The preset also sets `output.trustedTypes: { policyName: 'platform-webpack' }`,
`output.crossOriginLoading: false` (same origin), devtool `hidden-source-map` (maps uploaded
privately and not served), no `eval` devtools in any mode, `publicPath: 'auto'`, and content hashing.

**Versioning.** The SDK is not started at `0.x`. A caret range on `0.x` pins the minor version
(`^0.3.0` means below `0.4.0`), so with `strictVersion` every minor release would break every remote.
It is published as `1.0.0-alpha.N` while nothing is deployed, and remotes share it with
`^1.0.0-0`, which accepts those pre-releases and every later `1.x`. Breaking changes during the alpha
bump `N` and are listed in the CHANGELOG. `1.0.0` is cut when the first end-to-end environment goes
live, and SemVer is strict from then on.

A remote built against SDK `2.x` fails `strictVersion` at share negotiation. That surfaces as a
`RemoteLoadError` inside its `RemoteBoundary`, not as a broken shell.

### CloudFront behaviors (precedence order)

| Path | Origin | Cache policy | Origin request | Notes |
|---|---|---|---|---|
| `/api/*` | API gateway / ALB | CachingDisabled | AllViewerExceptHostHeader | All methods. WAF. Envoy strips the HLD §11.1 list (`x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`). `/api/v1/public/tenants/resolve` must route without `jwt_authn`/`ext_authz`, with a per-IP rate limit and CAPTCHA (D2 item B) |
| `/otel/*` | OTel Collector (OTLP/HTTP) | CachingDisabled | no cookies, no `Authorization` | POST only. WAF rate-based rule + 1 MB body limit. Unauthenticated by design (pre-login errors), so the collector drops unknown resource attrs and enforces label allowlists |
| `/csp-report` | Lambda function URL (OAC-signed) | CachingDisabled | no cookies | POST only, WAF rate rule, 64 KB limit. The browser posts `application/reports+json`, which the OTel Collector has no receiver for. The Lambda drops query strings from `blocked-uri`/`document-uri`, sanitizes with the shared redaction rules, and forwards to the Collector as OTLP logs (`event.name=csp.violation`) |
| `/config/runtime.json` | S3 | TTL 0, honour origin `Cache-Control: no-cache` + ETag | — | Per-environment object |
| `/version.json` | S3 | same as above | — | Written last by the deploy pipeline |
| `/remotes/manifest.json` | S3 | same as above | — | Written after all remotes upload |
| `/remotes/*` | S3 | CachingOptimized, `max-age=31536000, immutable` | — | Versioned paths `/remotes/<name>/<version>/…`, never overwritten |
| `/assets/*` | S3 | CachingOptimized, immutable | — | Content-hashed |
| `Default (*)` | S3 | `no-cache` | — | A **CloudFront Function** rewrites extension-less paths to `/index.html`. Do **not** use custom 403/404→index.html error responses, because they turn `/api/*` 404s into HTML |

Response headers policy (all behaviors except `/api/*`, which the gateway owns):

```
Content-Security-Policy:
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
  connect-src 'self' https://auth.bcbpsolutions.com;
  manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self';
  frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests;
  require-trusted-types-for 'script'; trusted-types platform-sdk platform-webpack dompurify;
  report-to csp
Reporting-Endpoints: csp="/csp-report"
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Frame-Options: DENY
```

Keycloak is **not** proxied through CloudFront (§D4). It runs on IAM's region-neutral host
`auth.bcbpsolutions.com` (Keycloak shards sit behind it, routed by realm path, so the issuer pattern
does not change), and the app origin is registered in each realm's `tender-web` client. Login,
`prompt=none` and logout are top-level navigations that CSP does not restrict. Only the token and
refresh `fetch`es need `connect-src`. There is no `frame-src`: silent renewal uses the refresh token,
not an iframe.

`style-src 'self'` stays strict (§D3). `@platform/ui` uses zero-runtime CSS (CSS Modules,
vanilla-extract or Linaria, extracted at build time). React `style={{}}` is fine, because it goes
through the CSSOM. Runtime CSS-in-JS (Emotion, styled-components, MUI) is not allowed without a
written exception, and the only exception ever granted is `'unsafe-inline'` on `style-src`, never on `script-src`.

---

## C4. Examples

### Shell bootstrap (`examples/shell/src/bootstrap.tsx`)

```tsx
import { initializeCore, setConsentProvider } from '@platform/frontend-sdk/core';
import { loadRuntimeConfig, setRuntimeConfig } from '@platform/frontend-sdk/config';
import { initializeTracing } from '@platform/frontend-sdk/tracing';
import { initializeLogging, getLogger } from '@platform/frontend-sdk/logging';
import { initializeMetrics, startWebVitals } from '@platform/frontend-sdk/metrics';
import { setFlagProvider, runtimeConfigFlagProvider, sessionContextFlagProvider } from '@platform/frontend-sdk/flags';
import { createOidcProvider, initializeAuth, chooseWorkspace, rememberWorkspace, isWrongWorkspace,
         signInAgain } from '@platform/frontend-sdk/auth';
import { setTokenSource } from '@platform/frontend-sdk/http';
import { setAuthorizer, setAuthzSubject, roleMapAuthorizer } from '@platform/frontend-sdk/authz';
import { initializeI18n } from '@platform/frontend-sdk/i18n';
import { loadManifest, startVersionPolling } from '@platform/frontend-sdk/mfe';
import { installTrustedTypesPolicy } from '@platform/frontend-sdk/security';
import { PlatformProvider, installGlobalErrorHandlers } from '@platform/frontend-sdk/react';
import { createRoot } from 'react-dom/client';
import { cmp } from './consent';
import { permissions } from './permissions';
import { workspaceResolver, sessionContextSource } from './iam';   // PUB-1 and IAM item A over an ApiClient
import { askForWorkspace, showWorkspaceNotFound } from './IdentifierFirst'; // FE spec A2 screen; resolves via workspaceResolver
import { showWrongWorkspace, showSessionEnded, showSignedOut } from './SessionScreens'; // shell-owned screens
import { App } from './App';

export async function bootstrap(): Promise<void> {
  installTrustedTypesPolicy();
  // app.bcbpsolutions.com fronts tenders, IAM administration and the dashboard: a multi-domain shell (§D1).
  initializeCore({ serviceName: 'web-app', domain: 'portal',
                   environment: __ENVIRONMENT__, buildVersion: __BUILD_VERSION__ });

  const cfg = await loadRuntimeConfig();
  setRuntimeConfig(cfg);
  setConsentProvider(cmp);

  const { otlpBaseUrl, sampleRatio, logLevel } = cfg.telemetry;
  initializeTracing({ otlpBaseUrl, sampleRatio, propagationAllowlist: cfg.api.propagationAllowlist });
  initializeLogging({ otlpBaseUrl, level: logLevel });
  initializeMetrics({ otlpBaseUrl });
  installGlobalErrorHandlers();
  startWebVitals();
  setFlagProvider(runtimeConfigFlagProvider());

  const idp = createOidcProvider(cfg.auth, workspaceResolver);
  setTokenSource(initializeAuth(idp));
  const session = await idp.init();   // may redirect once with prompt=none on a reload or new tab (never settles then)
  if (session.status === 'anonymous') {
    // init() has already moved the URL off the callback path to the page the user opened.
    const signIn = async () => {
      // A failed silent attempt names its workspace; otherwise /t/<slug> → cached or resolved Workspace
      // (paid OR trial), else the most recent cached Workspace, else ask.
      const workspace = (session.reason === 'login-required' ? session.workspace : undefined)
        ?? await chooseWorkspace({ pathname: location.pathname, resolver: workspaceResolver, cfg: cfg.auth })
        ?? await askForWorkspace();
      await idp.login({ workspace, returnUrl: location.pathname + location.search });
    };
    // After a logout, wait for the user: an automatic login would ride the live SSO session and undo it.
    if (session.reason === 'signed-out') showSignedOut(signIn); else await signIn();
    return;
  }
  // Trial login through an invitation email that landed in another tenant: never cache it, never render the app.
  if (isWrongWorkspace(session.workspace, session.user)) { showWrongWorkspace(idp); return; }
  // Expiry happens only during use. Never redirect on our own; the user clicks "Sign in" in the dialog.
  // A server-ended session (e.g. trial → paid) re-resolves the workspace; a natural expiry reuses the cache.
  idp.subscribe((s) => {
    if (s.status === 'expired') showSessionEnded(s, () =>
      signInAgain({ idp, state: s, resolver: workspaceResolver, cfg: cfg.auth, ask: askForWorkspace }));
  });

  // Roles, plan and flags are not in the token (§0 row 10). Without them: deny-all, platform flags only.
  const context = await sessionContextSource.load().catch((e) => {
    getLogger().warn('session context unavailable', { error: e }); return undefined; });
  setAuthorizer(roleMapAuthorizer(permissions));
  setAuthzSubject(context && { roles: context.roles, tenantId: context.tenantId });
  if (context) setFlagProvider(sessionContextFlagProvider(context));
  // Cache the workspace with its slug (trial tokens carry none) and move the URL to /t/<slug>/.
  if (context) rememberWorkspace({ ...session.workspace, slug: context.slug });
  await initializeI18n({ defaultLocale: cfg.i18n.defaultLocale, supported: cfg.i18n.supportedLocales });
  await loadManifest().catch((e) => getLogger().error('manifest load failed', { error: e }));
  startVersionPolling();

  createRoot(document.getElementById('root')!).render(
    <PlatformProvider shell={{ user: session.user, workspace: session.workspace, context,
                               locale: document.documentElement.lang,
                               switchWorkspace: async (id) => {
                                 const w = await workspaceResolver.resolve(id);
                                 if (!w) { showWorkspaceNotFound(); return; }  // generic message, never says which input failed
                                 await idp.switchWorkspace(w);
                               } }}>
      <App />
    </PlatformProvider>,
  );
}
```

### Remote component (`examples/remote-tenders/src/EditTender.tsx`)

```tsx
import { useState } from 'react';
import { useApi, useApiClient, useHasPermission, useRouteTemplate, useT,
         MFEErrorBoundary } from '@platform/frontend-sdk/react';
import { isProblemError, PlatformProblemTypes, toFieldErrorMap } from '@platform/frontend-sdk/problem';
import { problemMessage } from '@platform/frontend-sdk/i18n';

interface Tender { id: string; title: string; deadline: string; version: number }

function EditTenderForm({ id }: { id: string }) {
  useRouteTemplate('/tenders/:id/edit');
  const t = useT('tenders');
  const api = useApiClient();
  const canEdit = useHasPermission('update', 'tender');
  const { data, error, loading } = useApi((c, signal) =>
    c.get<Tender>('/tenders/:id', { params: { id }, signal }).then((r) => r.data), [id]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [formError, setFormError] = useState<string>();

  if (loading) return <p>{t('loading')}</p>;
  if (error) throw error;                       // MFEErrorBoundary renders traceId/requestId
  if (!data) return null;

  async function onSubmit(form: FormData) {
    setFieldErrors({}); setFormError(undefined);
    try {
      await api.put('/tenders/:id', { params: { id }, body: Object.fromEntries(form) });
    } catch (e) {
      if (!isProblemError(e)) throw e;          // Timeout/Network → boundary
      if (e.is(PlatformProblemTypes.ValidationFailed)) setFieldErrors(toFieldErrorMap(e));
      else if (e.is(PlatformProblemTypes.Conflict)) setFormError(problemMessage(e));
      else setFormError(problemMessage(e));     // localized by type id, falls back to title
    }
  }

  return (
    <form action={onSubmit}>
      <input name="title" defaultValue={data.title} disabled={!canEdit} aria-invalid={!!fieldErrors.title} />
      {fieldErrors.title?.map((m) => <span key={m} role="alert">{m}</span>)}
      <input name="deadline" type="date" defaultValue={data.deadline} disabled={!canEdit} />
      {fieldErrors.deadline?.map((m) => <span key={m} role="alert">{m}</span>)}
      {formError && <p role="alert">{formError}</p>}
      {canEdit && <button type="submit">{t('save')}</button>}
    </form>
  );
}

export default function EditTender(props: { id: string }) {
  return <MFEErrorBoundary mfe="tenders"><EditTenderForm {...props} /></MFEErrorBoundary>;
}
```

The `/tenders/:id` template is both the URL builder and the `route` metric label, so a raw URL
never reaches a label. `canEdit` is a UI hint, and the PUT is authorised by the backend.

---

## C5. Shared backend contracts and drift testing

### Contract inventory

| # | Contract | Backend source | SDK artefact |
|---|---|---|---|
| 1 | Problem members, order, optionality; `application/problem+json` | `problem.go`, `core.py` | `/problem` parser |
| 2 | Standard-member set (case-insensitive collision rule), extension-name regex `^[A-Za-z][A-Za-z0-9_]{2,}$` | `extensions.go` | parser |
| 3 | Platform type registry (15 types: id, title, status, code, order) | `types.go PlatformTypes()` | `contracts/problem-types.json` → `PlatformProblemTypes` |
| 4 | Type URI shape `{base}/{domain}/{name}`, default base, `about:blank` | `types.go` | `typeId` derivation |
| 5 | `typeForStatus` mapping (400 → bad-request, unknown → about:blank + status text) | `TypeForStatus` | synthetic problems |
| 6 | Timestamp layout `YYYY-MM-DDTHH:MM:SSZ` | `TimestampLayout` | parser (string, validated) |
| 7 | Server timeout = 503 + `REQUEST_TIMEOUT` | `errors.go` | `ProblemError`, not `TimeoutError` |
| 8 | Header names: `x-request-id`, `traceparent`, `tracestate`; response `X-Trace-ID`, `X-Request-ID`; forbidden `x-user-id`, `x-tenant-id`, `x-tenant-roles` + IAM strip-list `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode` | `transport.go`, `propagate.go`; IAM HLD §11.1 | `contracts/headers.json` |
| 9 | Request-id rule `^[a-zA-Z0-9._-]+$`, ≤128 B | `validation.go` | `newRequestId` |
| 10 | Roles parse rule (regex, 64 B, 64 roles, 4096 B, fail-closed) | `validation.go` | `/authz` |
| 11 | Trace id: W3C, 32 lower-hex, not all-zero; no baggage to third parties | OTel / `propagate.go` | `/tracing` |
| 12 | Redaction keys + `SanitizeString` (Cc strip, 256 B at UTF-8 boundary) | `log_sanitizer.go` | `/core` sanitizer |
| 13 | Identity vocab: service regex, domains, environments, version regex | `registry.json` | `contracts/registry-vocab.json` |
| 14 | Resource attrs + sampler semantics | `otel/setup.go` | `/tracing` |
| 15 | Observability standard: tiers, metric entries, label vocabulary, required/const labels, prohibited labels/suffixes, suffix and unit rules, bucket presets | `registry.json`, `metricslint` (`validate.go`, `ServicePrefix`) | `contracts/metric-registry.json` → `/metrics` registration checks; `metricslint check` in CI |
| 16 | Log field names: `trace_id`, `request_id` snake_case (not the problem-body camelCase); `path` = server route template | `middleware/logging.go`, `recovery.go` | `/logging` envelope, `contracts/log-fields.json` |
| 17 | Gateway deny codes, their statuses, and their problem shape (`errorCode` = reason, platform type per status, §D6 H) | `iam-authz-enrichment` `internal/domain/decision.go`, pinned by its `TestDenyCodes_Pinned`; LLD §17 | `contracts/gateway-deny-codes.json` → `GATEWAY_DENY_CODES`; denial bodies in `problem_bodies.json` |
| 18 | PUB-1 request/response shape (`found`, `realm`, `strategy`, trial-only `tenant_id`; no `slug`, by design) and session-context shape (P-35, including `slug`, §D6 A) | `iam-org-membership` LLD §5.4, PUBRES-1…4, P-35 | `contracts/tenant-resolve-cases.json`, `contracts/session-context-cases.json`; contract tests in `/testing`; `/auth` mocks |
| 19 | Realm naming (`trial`, `tenant-<slug>`), workspace URL `/t/<slug>` used by **both** paid and trial tenants | IAM HLD §8.2.7, §8.10.2 | `RuntimeConfig.auth` defaults, `slugFromPath`, realm sanity check in `chooseWorkspace` |

### How drift is caught

1. **Generated, never hand-copied.** `scripts/sync-contracts.ts` writes `contracts/*.json` from the
   backend sources: `registry.json` is read directly, and problem types/headers come from a new
   `go-probe contracts-export` subcommand in `platform-interop-tests`, which can import
   `pkg/problem` because it is public. CI runs the script and fails on `git diff --exit-code`.
   The IAM contracts come from repos outside this workspace (`BCBP-SOLUTIONS-FZC-LLC/iam-authz-enrichment`
   and `iam-org-membership`). `contracts/sources.json` pins each repo to a commit SHA on `main`. CI checks
   them out at those SHAs with a read-only deploy key. Locally, the script reads `IAM_REPOS_DIR`
   (default `../../../XPertPMS/IAM`) and fails if a checkout is not at the pinned SHA.
   - Deny codes and statuses come from the `DenyReason` constants and the `HTTPStatus()` table in
     `internal/domain/decision.go`. The script fails if the extracted set differs from the list in
     `TestDenyCodes_Pinned`, so a parsing slip cannot pass silently.
   - The PUB-1 and P-35 shapes come from org-membership's committed OpenAPI file
     (`docs/swagger/swagger.json`, kept fresh by its `check-swagger-stale.sh`). The case fixtures are
     validated against it.
   - Bumping a pin is a normal PR that reruns the contract tests (item 6).
   TS constants are generated from `contracts/` at build time.
2. **Shared golden fixtures** in `platform-interop-tests/fixtures/`, copied into `contracts/fixtures/`.
   `header_cases.json` (existing), `identity_cases.json` (run by `go-probe identity-check` and the
   `/core` tests) and new `problem_bodies.json` (real Go- and Python-emitted bodies: validation-failed, conflict with
   extensions, 5xx, about:blank, timeout 503) are run as table tests in the TS suite *and* by
   the existing Go/Python probes. One fixture, three languages.
   `redaction_cases.json` (verified against fastapicommon's sanitizer and a copy of gincommon's)
   also runs in Go once gincommon exports its sanitizer (§D6 I):
   `pkg/logger.Sanitize`/`SanitizeString`, wrapping `internal/core/service/log_sanitizer.go`, which
   Go module privacy keeps the harness from importing today. Until then it runs in TS and Python only.
   There is no synced copy of the fixture inside gincommon.
3. **Live interop (pair 4 in `platform-interop-tests`).** A `ts-probe` (Node 20 + undici, same
   `/http` + `/problem` code) runs against both `http-serve` servers:
   - `problem-decode`: trigger 400/401/404/409/500/503-timeout on Go and Python, parse with the SDK,
     then `compare.py` checks that the normalised `ProblemDetails` match field for field, including extensions.
   - `propagation`: SDK request → server reports the received `traceparent` trace id and
     `x-request-id`. Assert equality, assert no identity headers arrived, and assert the `X-Trace-ID` echo equals the SDK span's trace id.
   - `cross-origin`: request to a non-allowlisted origin carries no `traceparent`/`x-request-id`/`Authorization`.
4. **Metric lint, same tool as the backends.** Three CI checks, all with gincommon `cmd/metricslint`:
   - **Emitted names:** a test exports every SDK instrument through a real OTel Collector (`deltatocumulative`
     plus the Prometheus exporter, the production translation). The scrape goes to
     `metricslint check -strict -allow-proposed-owner platform-reactcommon`. That covers namespace
     classification, naming, suffixes, required labels, registry compliance, label vocabulary and
     cardinality, and proves the OTLP → Prometheus translation keeps the registry names.
     `-allow-proposed-owner` is removed once governance ratifies the entries.
   - **References:** `metricslint refs -deny-deprecated observability/ docs/` over dashboards, rules, SLOs
     and runbooks.
   - **Rules:** `promtool check rules` and `promtool test rules` on `observability/prometheus/rules/`.
   Remote repos run the same `check` on their Tier 2/3 instruments, piping `/testing`'s `renderMetricInventory()`.
5. **Public API snapshot.** api-extractor reports per subpath are committed. Any change needs
   a changeset with the matching SemVer bump.
6. **Renovate pin on the backends.** A gincommon or fastapicommon release, or a new commit on `main` of a
   pinned IAM repo (`contracts/sources.json`), opens a PR that
   reruns 1–3. Merging needs a green interop job.

---

## D. Decisions (formerly open questions)

| # | Topic | Status | Blocks |
|---|---|---|---|
| D1 | Domain for frontend services | Decided: `portal`. Needs registry PR | `/core` vocabulary |
| D2 | Tenant model, workspace switching | Decided by IAM (HLD v1.58, LLDs, code). Backend work is tracked in §D6 | First end-to-end environment (§D6). Implementation is not blocked |
| D3 | CSS-in-JS vs strict `style-src` | Decided | `@platform/ui`, CSP |
| D4 | IdP proxy vs CSP allowlist | Decided by IAM: `auth.bcbpsolutions.com` | — |
| D5 | Registry ratification | Decided. Needs governance approval | `/metrics` Tier 1 binding only |
| D6 | Backend changes the SDK relies on | Requested (nothing is in production, so each is fixed at the source) | See §D6 |

### D1. Domain for frontend services

One identity per page, set by the shell. Remotes run in the shell's page, so they cannot have
their own `domain`. That is what the `mfe` label is for.
- A shell that fronts several business domains uses a new **`portal`** domain value. It is added
  by registry PR to gincommon `internal/obsregistry/registry.json` and to the copy at
  `fastapicommon/src/fastapicommon/metrics/registry.json`, then `make metrics-inventory` is run.
- A shell dedicated to one business uses that business domain.
- `app.bcbpsolutions.com` fronts tenders, workflow design, IAM administration and the dashboard
  (FE spec §4), so it is the multi-domain case and needs `portal`.
- Each remote's owning domain is recorded as `ownerDomain` in `/remotes/manifest.json`. Alerts
  route by `mfe` to the owning team. It is never emitted as a second `domain` label on Tier 1 metrics,
  logs or traces. The one exception is the remote's own Tier 2/3 metrics, which the standard and
  `metricslint` require to carry the domain they are namespaced under: there `domain` = `ownerDomain`
  and `service` = the remote name (§C1 `/metrics`, "Tiers and identity").

### D2. Tenant model and workspace switching (owner: IAM)

Checked against the IAM HLD v1.58, the service LLDs (`docs/lld/` in each repo under
`XPertPMS/IAM`) and their code. The `/auth` section describes the resulting SDK behaviour.

**Settled by IAM:**
- Realm per paid tenant (`tenant-<slug>`), one shared `trial` realm (HLD §4.1). `iam-keycloakclient`
  is an admin client and issues no user tokens; a token from one realm is never exchanged for another.
- The gateway derives the tenant from the token (`iss`, or the trial `tenant_id` claim) and strips
  client-sent identity headers (HLD §5.4, §11.1; AuthZ Enrichment rule AE-SEC-1). An unknown `iss`
  gives `401 DENY_MALFORMED_IDENTITY`.
- **One login is one tenant** (Realm Provisioner rule RP-INV-2). No cross-realm membership API and
  no active-tenant endpoint are needed; the earlier proposals for both are withdrawn. "Switch tenant"
  is "sign in to another workspace".
- Choosing the realm before login: `/t/<slug>` in the URL, otherwise the public resolve endpoint
  PUB-1 (HLD §8.2.7), **implemented** in `iam-org-membership` (`router.go`, LLD rev 2.14). It resolves
  a slug or a pending invitation's email. It does not resolve an active member's email (LLD OQ-11, decided).
- Step-up MFA for approvers: `403 DENY_MFA_STALE` when `auth_time` is outside the tenant's
  `mfa_freshness_seconds`. The client re-authenticates with `prompt=login&max_age` (AuthZ Enrichment
  LLD §8.4, §17). The browser reads the window from session context (item A) or `GET /tenants/:id`.
- Keycloak shards are routed by realm path behind `auth.bcbpsolutions.com` (HLD §14.5), so the SDK is unaffected.

**IAM's reply (2026-10-30, `XPertPMS/IAM/Claude outputs/iam-reply-to-frontend-sdk-open-items.md`).** Every item
below is fixed and **merged** (RP #41, O&M #42/#43, AuthZ Enrichment #36/#38; round 2: O&M #46, AuthZ Enrichment #39, RP #44), and the HLD fix (item E) is merged too (`iam-hld-docs` #1, v1.58 on `main`). IAM's own v1.59 audit then found that converted trials got realm `tenant-<tenant_id>`. That is fixed and merged (RP #46, §D6 N). Each row below records
the finding and its fix; IAM's reply has the detail. §D6 is the single list of every backend change still needed:

| # | Item | IAM fix (PR, state) | Left for the SDK's first environment |
|---|---|---|---|
| A | Session-context endpoint (FE-Q4) | O&M P-35 `GET /api/v1/me/session-context` in O&M **#42** (merged). Field list confirmed unchanged; same values as the gateway headers, checked by an e2e test; `404` no membership, `403` suspended member or inactive tenant. AE-47 (AuthZ Enrichment **#36**/**#38**, merged) also denies non-active members at the gateway | — (`slug` added in round 2, O&M **#46**, merged; §D6 A) |
| B | PUB-1 at the edge | O&M **#42** (merged): GET-only route without JWT/`ext_authz`, 20/h per client IP (IPv4 and IPv6), off by default (`ingress.publicResolve.enabled`) | Platform: Envoy Gateway global rate-limit service plus a ClientTrafficPolicy that trusts `X-Forwarded-For`; WAF challenge; OQ-10; enable per environment (§D6 B) |
| C | `tender-web` client hardening | RP **#41** (merged): public, standard flow, PKCE S256, exact redirect URIs and web origins from config, rotation (max reuse 0, realm-wide), §11.3 lifetimes, admin-only `tenant_id` | Multi-tab rotation verified (§D6 L, RP **#44**, merged). Dev realms must be recreated after the merge |
| D | Shared `trial` realm | RP **#41** (merged): `EnsureSharedRealm` at startup, with the `tenant_id` mapper, hardened `tender-web` and the `requires-mfa` role. The PUB-1 `tenant_id` hint is optional and only for a wrong-workspace check | — |
| E | HLD §7.2 (realm from `iss`, not Host) | `iam-hld-docs` **#1** (v1.58, merged) | — |
| F | Emails | RP **#41** and O&M **#42** (merged): invitation email sent (7 days, `/t/<slug>/`, a send failure fails RP-5 with 502; `tenant_slug` required); verification email links to `/t/<slug>/` (best-effort). RP-2 sends no creation-time email (RP-D19) | `WEB_APP_BASE_URL` / `WEB_APP_EXTRA_BASE_URLS` once the dev/staging web-app hosts exist (§D6 F). Deploy RP #41 before or with O&M #42 |
| G | bff-signup returns `slug` (not IAM) | — | §D6 G |

Answered questions: the trial → paid conversion email belongs to the **Notification Service**
(`TenantConverted`, §D6 M). The PUB-1 `tenant_id` hint is optional, and the SDK uses it only for the
wrong-workspace check (§C1 `/auth`).

Also relevant from the FE screen spec (a draft under `iam-catalog-admin/Claude outputs/`): FE-Q5
(error format; RFC 9457 everywhere, gateway denials included since §D6 H), FE-Q12 (Arabic/RTL, covered by
`/i18n`) and FE-Q15 (Module Federation, §C3).

### D3. CSS-in-JS vs strict `style-src`

Keep `style-src 'self'`. `@platform/ui` uses zero-runtime CSS (CSS Modules, vanilla-extract, or
Linaria, all extracted at build time).
- Runtime CSS-in-JS (Emotion, styled-components, MUI via Emotion) injects `<style>` tags at runtime,
  which needs a nonce or `'unsafe-inline'`.
- Nonces aren't practical on S3 + CloudFront. They would need Lambda@Edge to rewrite HTML on every request, which defeats caching.
- React `style={{}}` sets styles through the CSSOM, which CSP does not block.
- A third-party library that forces Emotion gets a **written exception**: `'unsafe-inline'` on
  `style-src` only, never on `script-src`.

### D4. IdP: same-site subdomain, not a proxy (decided by IAM)

IAM already serves Keycloak at `auth.bcbpsolutions.com/realms/<realm>`, the single region-neutral
host every IdP integration is checked against (HLD §8.2.4, §11.6). Do not proxy it under `/idp/*`.
Add that origin to `connect-src`, and register the app origin in every realm's `tender-web` client
(item C tightens that client).
- Proxying changes the token issuer (`iss`). Keycloak's hostname config and every backend token
  validator would then have to agree on the proxied URL, which is harder with one realm per tenant.
- The login redirect is a top-level navigation that CSP does not restrict. Only the token and refresh fetches need `connect-src`.
- Credentials never pass through CloudFront, so a cache misconfiguration cannot leak them.

### D5. Registry ratification of browser metrics

`/metrics` applies the Enterprise Platform Observability Standard that every backend follows (§C1
`/metrics`). Applying it changed the first proposal:
- **Labels reuse the registry first** (rule 7, label governance). `error_kind` and `error_source` are
  dropped: failure detail uses the existing `reason`, and capture point uses the existing `source`, each
  with a per-metric enum. `remote` is merged into `mfe`. Only four labels are new: `page_route`, `mfe`,
  `vital`, `rating`.
- **HTTP client labels mirror the server.** `method`, `route`, `status_class`, `error_class`, as on
  `platform_http_request_duration_seconds`, instead of `outcome`, so cross-service aggregation and
  client/server comparison per route stay valid. Calls with no HTTP status also go to a `reason` counter.
- **No unit exception.** `metricslint` accepts histograms in `_seconds` or `_bytes` only, so the unitless
  CLS histogram is dropped. CLS is reported through `platform_web_vital_ratings_total{vital,rating}`.
- **Tiers 2 and 3 are available to remotes** under their owning domain (`ownerDomain`, remote name as
  `service`), because the lint requires `domain` to match the namespace.
- **Overflow** uses the existing `platform_telemetry_label_overflow_total`; no new metric.

The registry PR (gincommon `registry.json`, fastapicommon copy, `make metrics-inventory`) carries, for
each metric, the fields every entry has: `tier`, `type`, `unit`, `buckets`, `status: proposed`, `help`
(semantic definition), `labels`, allowed values, `aggregation`, `cardinality`, `owner:
platform-reactcommon` and `governance_notes`. It adds the `web_vitals` bucket preset
(`0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.8, 2.5, 3, 4, 6, 10, 20`, covering the good/poor thresholds of every
timed vital) and the four labels with meaning, values and cardinality. The notes state the
browser-specific risks: `/otel` accepts unauthenticated POSTs, so the Collector allowlists label values
and drops per-browser attributes; browsers export **delta** temporality, which the Collector converts.

Process: add the entries as `"status": "proposed"` and get governance approval, **then**
bind the Tier 1 instruments in `/metrics` (rules 11–12). The rest of `/metrics` (exporter, Tier 2/3 meters,
checks) does not add shared names and ships before approval. No other module imports the metric names: `/http` and `/mfe` record
through the internal instrument port (see `/metrics`), which is a no-op until `/metrics` binds it.
Remote teams' Tier 2 names need their own domain-registry approval; Tier 3 names need none.

### D6. Backend changes the SDK relies on

Nothing is in production, so where the SDK needs a backend to behave differently, the backend is
changed instead of the SDK working around it. This is the single list; each row says what the SDK
does until the change lands.

| # | Owner | Change | State (2026-10-30) | SDK until it lands |
|---|---|---|---|---|
| A | IAM (org-membership) | P-35 `GET /api/v1/me/session-context`, **with `slug` added** (§D2 A) | **Done**: P-35 (O&M #42) and `slug` (O&M #46), both merged | — |
| B | IAM, then platform and WAF | PUB-1 at the edge, with no `jwt_authn`/`ext_authz` and a per-IP limit sized for office NAT. The platform team enables Envoy Gateway's global rate-limit service (Redis) and trusts `X-Forwarded-For`. The WAF adds a CAPTCHA/challenge. IAM closes OQ-10 (§D2 B) | IAM part merged (O&M #42, off by default); platform, WAF and OQ-10 open | Mocked in tests; logins without a cached workspace fail in deployed environments |
| C | IAM (realm-provisioner) | `tender-web` client: exact redirect URIs, PKCE `S256` enforced, refresh-token rotation, HLD §11.3 lifetimes (§D2 C) | Done (RP #41, merged) | The SDK already uses S256; it works with the defaults, but the client is unsafe for real users |
| D | IAM (realm-provisioner) | Provision the shared `trial` realm, its `tenant_id` mapper (admin-only attribute) and its `tender-web` client (§D2 D) | Done (RP #41, merged) | No trial login |
| E | IAM (docs) | Correct HLD §7.2 (realm from `iss`, not Host) (§D2 E) | Done (`iam-hld-docs` #1, merged: v1.58 §7.2 Layer 1) | — |
| F | IAM (realm-provisioner, O&M), then ops | Verification and invitation emails link to `/t/<slug>/` through `tender-web`; the invitation email is sent. Set `WEB_APP_BASE_URL` / `WEB_APP_EXTRA_BASE_URLS` for dev and staging once those hosts exist (§D2 F) | Done (RP #41, O&M #42, merged); per-environment base URLs open (prod URL is the fallback) | First login needs the identifier screen; invitees cannot accept |
| G | bff-signup | Return `slug` in the completed signup response (§D2 G) | Unchanged | The signup page cannot always link to the workspace |
| H | IAM (authz-enrichment) | **AE-42 / CD-31 now:** `deniedResponse` sends `application/problem+json` with the platform type for the status (`platform/unauthorized`, `platform/forbidden`, `platform/service-unavailable`) and `errorCode` = the deny reason. Keep `TestDenyCodes_Pinned`, and add a test for the body shape | **Done** (AuthZ Enrichment #39, merged; LLD 1.48, AE-42 resolved) | — |
| I | Platform (gincommon) | Export the log sanitizer as `pkg/logger.Sanitize` / `SanitizeString`, so the interop harness runs `redaction_cases.json` in Go (§C5) | Not started | The redaction fixture runs in TS and Python only |
| J | Platform (registry) | Add the `portal` domain to `registry.json` in gincommon and fastapicommon, then `make metrics-inventory` (§D1) | Not started | `initializeCore({domain:'portal'})` throws, so the shell cannot start against real contracts |
| K | Observability governance | Ratify the seven `platform_web_*` metrics, the four labels, the `web_vitals` preset and the SDK as an emitter of `platform_telemetry_label_overflow_total` (§D5) | Not started | Tier 1 instruments stay no-ops; Tier 2/3 meters and the exporter work |
| L | IAM (realm-provisioner) | **Keycloak 26 integration test for multi-tab rotation:** in one SSO session, do two code exchanges for `tender-web` (two tabs), then refresh each lineage alternately for several rounds. Every refresh must succeed. If the test fails, IAM fixes it in the client configuration (§C1 `/auth`, "Refresh across tabs") | **Done** (RP #44, merged): passes with RP #41's settings, no change needed | — (follow the refresh rules in §C1 `/auth`) |
| N | IAM (realm-provisioner) | A trial converted through RP-3 gets realm `tenant-<slug>`, like a direct-paid tenant (HLD v1.59 gap G-1: it got `tenant-<tenant_id>`, which broke the paid-realm check in §D2 step 2) | **Done** (RP #46, merged; RP LLD v1.46, RP-D20). HLD v1.59 marks it fixed (`iam-hld-docs` #3, open) | — (dev: re-create the `provisioner` DB and pre-#46 trial tenants) |
| M | Notification Service | Trial → paid "your workspace has moved to `/t/<slug>`" email from `TenantConverted` (HLD §8.10.2 step 8) | Owner confirmed by IAM; timing is the Notification team's | Nothing: the SDK re-resolves on the server-ended session |

Not requested, by design: a `slug` on PUB-1. Returning one for an invitation email would disclose
the company slug to anyone who knows that email, and items A and F make it unnecessary.
