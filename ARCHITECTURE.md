# Architecture

This document describes the internal structure, dependency rules, and runtime flows of `platform-reactcommon`.

`platform-reactcommon` is a **private pnpm monorepo** of three packages, released together under one version (changesets `fixed`, `1.0.0-alpha.N` until the first environment):

- **`@bcbp-solutions-fzc-llc/frontend-sdk`**: the shared TypeScript SDK every React micro-frontend (shell and remotes) uses. Its 17 subpaths are `/core` … `/react`, `/testing`, and there is no root barrel. It is **contract-compatible with platform-gincommon and platform-fastapicommon**:
  - the same identity vocabulary and metric registry (Enterprise Platform Observability Standard);
  - RFC 9457 Problem Details;
  - the header names, the redaction rules, and the Go trace sampler.

  It is the browser's side of IAM: Keycloak sign-in (Authorization Code + PKCE, tokens in memory only), workspace (realm) choice, session restore, idle timeout, step-up.
- **`@bcbp-solutions-fzc-llc/webpack-preset`**: the Module Federation shared map (strict singletons, the SDK provided only by the shell), chunk integrity and CSP-safe output (Trusted Types, no `eval`, hidden source maps), for webpack 5 and, through its `/rspack` and `/rsbuild` entry points, Rspack and Rsbuild (the same v1 federation protocol, so the bundlers can be mixed).
- **`@bcbp-solutions-fzc-llc/eslint-plugin`**: seven rules that enforce in consumer code what the design requires:
  - SDK subpaths only;
  - no identity headers;
  - storage and HTML only through the SDK;
  - no runtime CSS-in-JS;
  - route templates for API paths.

`examples/` holds a reference shell, the tenders remote and the CloudFront/CSP snippets. None of it is deployed from here. The decisions behind all of this are in [`docs/design/frontend-sdk-design.md`](docs/design/frontend-sdk-design.md) (the decision record). This document and the [LLD](docs/lld/platform-reactcommon-lld.md) describe the implementation as built.

**Does not own:**
- **Authentication and authorization decisions:** the API gateway (Envoy + IAM AuthZ Enrichment) validates the token and injects identity; the browser never sends identity headers, and `/authz` is a UI hint only.
- **Keycloak realms and clients:** IAM's realm provisioner.
- **IAM APIs:** PUB-1 tenant resolve and P-35 session context. The shell implements them as ports over the SDK's `ApiClient`.
- **The OTel Collector, Loki, Tempo, Mimir and Grafana.**
- **Ratifying the proposed `platform_web_*` metrics:** observability governance (design doc §D5).
- **CloudFront, S3 and the deploy pipeline:** `examples/cloudfront` documents what they must do.
- **Any UI component library.**

---

## Layer model

Six layers, enforced twice: `eslint-plugin-boundaries` (lint) and dependency-cruiser (CI), both generated from `packages/frontend-sdk/subpaths.json`. A subpath imports another only through its `index.ts`. **Only `/react` and `/testing` import React; only `/tracing`, `/logging` and `/metrics` import OpenTelemetry.** Subpaths never read each other's module state: they share state through the `PlatformRuntime` in `src/internal`, which may itself import only `/core`.

> Source: [`docs/architecture/mermaid/layer-model.mmd`](docs/architecture/mermaid/layer-model.mmd)

```mermaid
graph TD
    subgraph apps["Consumers  —  not in this repo's packages"]
        shell["Shell (app.bcbpsolutions.com)<br/>bootstrap: core → config → telemetry → auth → context → i18n → manifest<br/>PlatformProvider · RemoteBoundary · its own screens and IAM ports<br/>(examples/shell)"]
        remote["Remotes (Module Federation)<br/>import SDK subpaths, never bundle them (import: false)<br/>MFEErrorBoundary · useApi · useT · getServiceMeter<br/>(examples/remote-tenders)"]
    end

    subgraph tooling["Build-time packages"]
        preset["@bcbp-solutions-fzc-llc/webpack-preset<br/>platformShared · sharedFor · containerName (__platform_mfe_name)<br/>platformWebpackConfig (Trusted Types, no eval, hidden maps)<br/>SdkVersionPlugin · ChunkIntegrityPlugin (JS + CSS SRI)"]
        eslint["@bcbp-solutions-fzc-llc/eslint-plugin<br/>7 rules + configs.recommended"]
    end

    subgraph sdk["@bcbp-solutions-fzc-llc/frontend-sdk  —  17 subpaths, no root barrel ('.' throws)"]
        L5["L5  /react (hooks, boundaries, PlatformProvider)  ·  /testing (dev only)"]
        L4["L4  /auth (Keycloak OIDC, PKCE)  ·  /mfe (manifest, loadRemote, app updates)  ·  /nav"]
        L3["L3  /http (ApiClient)  ·  /flags  ·  /i18n"]
        L2["L2  /tracing  ·  /logging  ·  /metrics  (the only OpenTelemetry users)"]
        L1["L1  /config (runtime.json, zod)  ·  /security (DOMPurify, Trusted Types)  ·  /storage"]
        L0["L0  /core (identity, consent, session id, sanitize)  ·  /problem (RFC 9457)  ·  /authz (pure)"]
        internal["src/internal  —  PlatformRuntime registry · runtime events · instrument port<br/>batcher · unload · reload · online · redirect · retry-after · urls · locale · generated contracts (not exported)"]
    end

    subgraph contracts["Generated contracts  —  packages/frontend-sdk/contracts/"]
        gen["registry vocabulary · metric registry · problem types · headers · redaction<br/>gateway deny codes · PUB-1 / P-35 cases · shared fixtures<br/>from pinned gincommon, fastapicommon, interop-tests and IAM commits"]
    end

    shell --> L5
    remote --> L5
    remote --> L3
    shell -. build .-> preset
    remote -. build .-> preset
    shell -. lint .-> eslint
    remote -. lint .-> eslint
    L5 --> L4 --> L3 --> L2 --> L1 --> L0
    L0 --> internal
    L1 --> internal
    L2 --> internal
    L3 --> internal
    L4 --> internal
    L5 --> internal
    internal --> gen
    preset -. generated SDK facts .-> sdk
    eslint -. generated SDK facts + forbidden headers .-> gen
```

| Layer | Subpaths | Responsibility |
|---|---|---|
| 0 | `/core`, `/problem`, `/authz` | Page identity (registry vocabulary), consent, RUM session id, sanitizing; RFC 9457 model and parsing; the pure UI authorizer |
| 1 | `/config`, `/security`, `/storage` | `runtime.json` (zod, strict, frozen); DOMPurify + the `platform-sdk` Trusted Types policy; per-workspace storage that refuses token-like keys |
| 2 | `/tracing`, `/logging`, `/metrics` | OTLP/HTTP export to `/otel`, consent-gated, bounded queues; registry-checked Tier 2/3 meters |
| 3 | `/http`, `/flags`, `/i18n` | `ApiClient` (templates, correlation, retries, 401 refresh, problems); platform and tenant flags; ICU-lite messages, locale, `dir` |
| 4 | `/auth`, `/mfe`, `/nav` | Keycloak OIDC provider and workspace choice; remote manifest, `loadRemote`, app updates; safe navigation |
| 5 | `/react`, `/testing` | Hooks, `PlatformProvider`, `MFEErrorBoundary`, `RemoteBoundary`, global handlers; the test platform |

---

## Package dependency graph

Allowed imports between subpaths (an arrow means "may import"), and which subpaths may use the restricted third-party packages. **Generated** from `subpaths.json`, the same file that generates the exports map, the lint rules, dependency-cruiser's rules and the webpack preset's shared list.

> Source: [`docs/architecture/mermaid/package-dependencies.mmd`](docs/architecture/mermaid/package-dependencies.mmd)

```mermaid
%% Generated from packages/frontend-sdk/subpaths.json by `pnpm docs:sync`. Do not edit.
graph BT
    subgraph L0["Layer 0"]
        sp_core["/core"]
        sp_problem["/problem"]
        sp_authz["/authz"]
    end
    subgraph L1["Layer 1"]
        sp_config["/config"]
        sp_security["/security"]
        sp_storage["/storage"]
    end
    subgraph L2["Layer 2"]
        sp_tracing["/tracing"]
        sp_logging["/logging"]
        sp_metrics["/metrics"]
    end
    subgraph L3["Layer 3"]
        sp_http["/http"]
        sp_flags["/flags"]
        sp_i18n["/i18n"]
    end
    subgraph L4["Layer 4"]
        sp_auth["/auth"]
        sp_mfe["/mfe"]
        sp_nav["/nav"]
    end
    subgraph L5["Layer 5"]
        sp_react["/react"]
        sp_testing["/testing"]
    end
    internal["src/internal<br/>(runtime registry · events · generated contracts)"]
    sp_config --> sp_core
    sp_security --> sp_core
    sp_storage --> sp_core
    sp_tracing --> sp_core
    sp_tracing --> sp_config
    sp_logging --> sp_core
    sp_logging --> sp_config
    sp_metrics --> sp_core
    sp_metrics --> sp_config
    sp_http --> sp_core
    sp_http --> sp_config
    sp_http --> sp_problem
    sp_http --> sp_tracing
    sp_http --> sp_logging
    sp_flags --> sp_core
    sp_flags --> sp_config
    sp_i18n --> sp_core
    sp_i18n --> sp_problem
    sp_i18n --> sp_config
    sp_auth --> sp_core
    sp_auth --> sp_config
    sp_auth --> sp_logging
    sp_auth --> sp_storage
    sp_mfe --> sp_core
    sp_mfe --> sp_config
    sp_mfe --> sp_flags
    sp_mfe --> sp_tracing
    sp_mfe --> sp_logging
    sp_nav --> sp_core
    sp_nav --> sp_config
    sp_react --> sp_core
    sp_react --> sp_config
    sp_react --> sp_tracing
    sp_react --> sp_logging
    sp_react --> sp_metrics
    sp_react --> sp_problem
    sp_react --> sp_http
    sp_react --> sp_flags
    sp_react --> sp_i18n
    sp_react --> sp_auth
    sp_react --> sp_authz
    sp_react --> sp_mfe
    sp_react --> sp_nav
    sp_react --> sp_storage
    sp_react --> sp_security
    sp_testing -.->|"any subpath (dev only)"| sp_react
    pkg_react(["react"])
    sp_react -.-> pkg_react
    sp_testing -.-> pkg_react
    pkg_react_dom(["react-dom"])
    sp_react -.-> pkg_react_dom
    sp_testing -.-> pkg_react_dom
    pkg__opentelemetry_(["@opentelemetry/*"])
    sp_tracing -.-> pkg__opentelemetry_
    sp_logging -.-> pkg__opentelemetry_
    sp_metrics -.-> pkg__opentelemetry_
    sp_testing -.-> pkg__opentelemetry_
    classDef pkg fill:#eef,stroke:#88a
    class pkg_react,pkg_react_dom,pkg__opentelemetry_ pkg
```

---

## Runtime registry

The `PlatformRuntime` lives on `globalThis[Symbol.for('@bcbp-solutions-fzc-llc/frontend-sdk')]`, so every copy of the SDK on a page finds the same object. That's how a remote sees the shell's identity, consent, session, flags, permissions and token source, even though the remote never imports the shell. Change notification goes through the runtime too. `/i18n`, `/flags`, `/authz` and `/http` emit the topics `i18n`, `flags`, `authz` and `read-only`, and `/react` re-renders on them.

A second copy is a remote that bundled the SDK instead of taking it from the shell. It logs one error. If its version is compatible (the same major, or for a pre-release the same version: `1.0.0-alpha.3` and `alpha.4` each keep their own), it binds to the existing runtime; otherwise it keeps its own. State a newer copy adds (the remote container cache, the flag subscription, the before-reload listeners) is created on first use, so an older copy's runtime still works.

> Source: [`docs/architecture/mermaid/runtime-registry.mmd`](docs/architecture/mermaid/runtime-registry.mmd)

```mermaid
graph LR
    subgraph rt["PlatformRuntime  —  globalThis[Symbol.for('@bcbp-solutions-fzc-llc/frontend-sdk')]"]
        ident["identity · consent · memorySessionId"]
        cfg["config (deep-frozen runtime.json)"]
        tel["tracing · logging · metrics · instruments (port)"]
        page["pageRoute · routeTemplates"]
        authf["identityProvider · tokenSource · storageNamespace"]
        az["authorizer · authzSubject · flagProvider"]
        mf["manifest · remotes (mfe → ownerDomain) · appUpdate<br/>remoteContainers (one per remote per page)"]
        ui["i18n · navigator · trustedTypesPolicy · readOnlyDenied<br/>beforeReload (listeners run before an SDK reload)"]
        ev["events: i18n · flags · authz · read-only"]
    end

    core["/core"] -->|writes| ident
    config["/config"] -->|writes| cfg
    tracing["/tracing · /logging · /metrics"] -->|writes| tel
    logging["/logging setRouteTemplate"] -->|writes| page
    auth["/auth initializeAuth, login"] -->|writes| authf
    http["/http"] -->|reads token source| authf
    http -->|"sets readOnlyDenied, emits read-only"| ui
    storage["/storage"] -->|reads namespace| authf
    authz["/authz · /flags"] -->|writes, emits| az
    mfe["/mfe loadManifest"] -->|writes| mf
    metrics["/metrics"] -->|reads remotes| mf
    i18n["/i18n"] -->|writes, emits| ui
    react["/react hooks"] -->|subscribe| ev
    react -->|read| az
    react -->|read| authf

    dup["second SDK copy<br/>(a remote that bundled it)"] -.->|"one error log · compatible version (same major;<br/>for a pre-release the same version): binds to the existing runtime<br/>otherwise: its own runtime"| rt
```

---

## Shell bootstrap

The shell runs the bootstrap once (a remote's code inside a shell never does) (design doc §C2). Steps 2–3 are fatal: they fall back to a static page, and no SDK telemetry is possible yet. Step 5 is never fatal. Step 7 is fatal only for routes that need auth. If step 9 fails, every remote slot shows its fallback. `examples/shell/src/bootstrap.tsx` follows the §C4 code; when step 8 failed transiently, the shell renders deny-all and retries P-35 in the background (`examples/shell/src/session-context.ts`). A sign-out in any tab during the steps stops the bootstrap before the app is mounted.

> Source: [`docs/architecture/mermaid/shell-bootstrap.mmd`](docs/architecture/mermaid/shell-bootstrap.mmd)

```mermaid
flowchart TD
    html["index.html (external scripts only)"] --> idx["index.ts: import('./bootstrap')<br/>(the async boundary Module Federation needs)"]
    idx --> tt["1. installTrustedTypesPolicy()  —  /security"]
    tt --> cfg["2. cfg = loadRuntimeConfig() → GET /config/runtime.json (no-cache, 10 s timeout) → zod (strict)<br/>checked against its own environment (one build for every environment)"]
    cfg -->|fails| fatal["static 'unavailable' page, console only"]
    cfg --> core["3. initializeCore({ serviceName, domain: 'portal', environment: cfg.environment, buildVersion })<br/>validated against the registry vocabulary · setRuntimeConfig(cfg) → freeze"]
    core -->|throws| fatal
    core --> consent["4. setConsentProvider(cmp)  —  before any export"]
    consent --> tel["5. initializeTracing · initializeLogging · initializeMetrics → /otel<br/>installGlobalErrorHandlers() · startWebVitals()  (never fatal)"]
    tel --> flags["6. setFlagProvider(runtimeConfigFlagProvider())"]
    flags --> auth["7. idp = createOidcProvider(cfg.auth, workspaceResolver)<br/>setTokenSource(initializeAuth(idp)) · state = await idp.init()"]
    auth -->|"no tokens + cached workspace"| restore["one prompt=none redirect per tab<br/>(init never settles; the page unloads)"]
    auth -->|"anonymous 'signed-out'"| signedout["signed-out screen; login only on click"]
    auth -->|"anonymous 'login-required'"| login1["idp.login({ workspace: state.workspace })"]
    auth -->|"anonymous 'none'"| choose["chooseWorkspace() ?? identifier-first screen → idp.login()"]
    auth -->|"authenticated"| wrong{"isWrongWorkspace?"}
    wrong -->|yes| wrongscreen["wrong-workspace screen (sign out / switch); stop"]
    wrong -->|no| ctx["8. sessionContextSource.load()  (IAM P-35; failure → undefined: deny-all, no tenant flags)<br/>setAuthorizer(roleMapAuthorizer) · setAuthzSubject · rememberWorkspace (URL → /t/&lt;slug&gt;/)<br/>setFlagProvider(sessionContextFlagProvider) · await initializeI18n()"]
    ctx -->|"a sign-out meanwhile (any tab)"| stop["stop: the app is never mounted"]
    ctx --> manifest["9. loadManifest() → GET /remotes/manifest.json · startVersionPolling()<br/>(failure: every remote slot shows its fallback)"]
    manifest --> render["10. createRoot().render(&lt;PlatformProvider shell&gt;&lt;App/&gt;)<br/>routes render &lt;RemoteBoundary&gt; lazily"]
    render --> expired["idp.subscribe: 'expired' → session-ended dialog → signInAgain()<br/>'signed-out' → unmount the app, signed-out screen"]
    render -->|"P-35 failed transiently (network, timeout, 429, 5xx)"| ctxretry["retry P-35 3 times (after 1 s, 2 s, 4 s); on success:<br/>setAuthzSubject · session flags · rememberWorkspace · re-render<br/>(a sign-out stops the retries)"]
```

Remote code that also runs inside a shell skips all of this and reads the config only through `tryGetConfig()`. A remote's own standalone page (no shell) is its host page: it may run steps 2–3 itself (`initializeCore`, `loadRuntimeConfig`, `setRuntimeConfig`) and read `auth.signInUrl` to send a signed-out user to the shell. Without them every API returns a no-op or an anonymous default (`denyAll`, empty flags, the console logger).

---

## Request flow

`createApiClient({ mfe })` (or `useApiClient()`, bound to the nearest MFE scope) produces calls built from **route templates** (`'/tenders/:id'` + `params`), so the template is both the URL builder and the metric's `route` label. One logical call is one span and one metric observation, after retries.

> Source: [`docs/architecture/mermaid/request-flow.mmd`](docs/architecture/mermaid/request-flow.mmd)

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller (useApi / ApiClient)
    participant D as GET dedupe
    participant X as execute()
    participant A as attempt()
    participant T as TokenSource (/auth)
    participant F as fetch
    participant P as parseProblemResponse (/problem)
    participant O as span + instrument port

    C->>D: get('/tenders/:id', { params })
    Note over D: key = URL + token + headers,<br/>concurrent identical GETs share one call<br/>(aborts only when every subscriber aborts)
    D->>X: startCall: URL from baseUrl + template,<br/>x-request-id, Idempotency-Key (POST), span "HTTP GET"
    X->>T: getAccessToken() — same origin only
    loop attempts (GET/PUT/DELETE, or retry.unsafe): 1 + 2 retries by default (at most 5)
        X->>A: attempt(token)
        Note over A: offline → NetworkError(offline) at once<br/>drop FORBIDDEN identity headers (dev: throw)<br/>x-request-id · x-session-id: same origin or allowlist<br/>traceparent: same origin or allowlist<br/>Authorization: same origin only<br/>deadline 35 s (api.timeoutMs)
        A->>F: fetch(url, headers, signal = caller ∪ timeout,<br/>redirect: 'manual' when it carries the token or correlation headers)
        F-->>A: Response / error
        A-->>X: Response, or TimeoutError / NetworkError / AbortedError
        alt 401 and not yet refreshed
            X->>T: newer token? else refresh() (single-flight per tab)
            T-->>X: new token → retry once (not counted as a retry)<br/>none → onUnauthorized()
        else 429 / 502 / 503 / 504 or transient error, retryable
            X->>X: sleep Retry-After (≤ 30 s) or full-jitter backoff min(5 s, 250 ms·2ⁿ)
        end
    end
    alt redirect, or a 2xx body that is not the JSON it claims
        X-->>C: throw synthetic 502 ProblemError (the redirect is not followed)
    else 2xx
        X->>O: record(status) · http.response.status_code
        X-->>C: { data, status, headers, requestId, traceId (X-Trace-ID) }
    else non-2xx
        X->>P: parse RFC 9457 body (≤ 1 MiB) or synthesize from status
        P-->>X: ProblemError
        X->>O: record(status) · recordError if 5xx<br/>DENY_TENANT_READ_ONLY → runtime.readOnlyDenied
        X-->>C: throw ProblemError
    end
    Note over O: one platform_web_http_client_* observation per logical call<br/>(through the instrument port, a no-op until Tier 1 is bound)
```

| Header | Sent to |
|---|---|
| `Authorization: Bearer` | the page's own origin only |
| `x-request-id`, `x-session-id`, `traceparent` / `tracestate` | the page's origin and the exact origins in `api.propagationAllowlist` / tracing's allowlist |
| `Idempotency-Key` | every `POST` (an automatic UUID unless given) |
| `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode` | **never**: dropped with a warn log, and a `TypeError` in local/dev |

---

## Workspace resolution before sign-in (PUB-1)

Every paid tenant has its own Keycloak realm (`tenant-<slug>`), and trial tenants share one (`trial`). The authorize URL names the realm, so the SDK must know the workspace **before** the redirect. `chooseWorkspace` decides it from the URL, the workspace cache and PUB-1. PUB-1 is called through the shell's `WorkspaceResolver` port over an `ApiClient`, without a token. A resolved realm is accepted only if it fits the slug, so a wrong or hostile answer can't send the user to another tenant's login page.

> Source: [`docs/architecture/mermaid/workspace-resolution.mmd`](docs/architecture/mermaid/workspace-resolution.mmd)

```mermaid
flowchart TD
    start(["Sign in needed: anonymous, no session to restore"]) --> lr{"session.reason = login-required<br/>(a silent restore named its workspace)?"}
    lr -- yes --> use["Use that workspace"]
    lr -- no --> force{"forceResolve?<br/>(the server ended the session)"}
    force -- yes --> pub1
    force -- no --> slug{"URL /t/&lt;slug&gt;/…<br/>(auth.workspacePathPrefix)?"}
    slug -- no --> recent{"Workspace cache<br/>(localStorage, ≤ 20 entries, newest first)"}
    recent -- "an entry" --> use
    recent -- empty --> ask
    slug -- yes --> cached{"Cached entry for this slug?"}
    cached -- yes --> use
    cached -- no --> pub1["PUB-1 resolve(slug)<br/>shell port WorkspaceResolver over ApiClient<br/>GET /api/v1/public/tenants/resolve, no token"]
    pub1 -- "found" --> fits{"realm fits the slug?<br/>paid: paidRealmPrefix + slug · trial: trialRealm"}
    fits -- yes --> cache["Cache { slug, realm, trial }"] --> use
    fits -- no --> ask
    pub1 -- "not found" --> ask["undefined → the shell's identifier-first screen<br/>(a different cached workspace is never used)"]
    pub1 -- "unreachable / 429" --> fallback{"Cached entry for this slug?"}
    fallback -- yes --> use
    fallback -- no --> ask
    ask -- "user types an identifier" --> pub1
    use --> login["idp.login({ workspace, returnUrl })<br/>→ Keycloak /realms/&lt;realm&gt;/…/auth (PKCE S256)"]
    login --> after["After sign-in: rememberWorkspace({ ...workspace, slug })<br/>trial slug from P-35 · an invitation's trial result has no slug and is not cached"]
```

| Situation | Workspace used |
|---|---|
| A silent restore failed with `login_required` | The workspace it tried |
| The server ended the session (`forceResolve`) | PUB-1 again, skipping the cache |
| `/t/<slug>/…`, cached | The cached entry |
| `/t/<slug>/…`, not cached | PUB-1; cached when the realm fits |
| PUB-1 unreachable or rate-limited | The cached entry for that slug, else the identifier-first screen |
| PUB-1 says "not found" | The identifier-first screen; never another cached workspace |
| No slug in the URL | The most recent cached workspace, else the identifier-first screen |

After sign-in the shell calls `rememberWorkspace`, with the trial slug taken from P-35. A trial workspace reached from an invitation email has no slug and is never cached. LLD §8.2.

---

## Authentication: login and callback

Keycloak runs on `auth.bcbpsolutions.com` (not proxied, design doc §D4), with one realm per paid tenant (`tenant-<slug>`) and the shared `trial` realm. Endpoints are built from Keycloak's fixed paths, with no discovery fetch. The realm comes only from a `Workspace` that `chooseWorkspace` checked against `paidRealmPrefix` or `trialRealm`.

> Source: [`docs/architecture/mermaid/auth-login-callback.mmd`](docs/architecture/mermaid/auth-login-callback.mmd)

```mermaid
sequenceDiagram
    autonumber
    participant S as Shell
    participant P as OIDC provider (/auth)
    participant SS as sessionStorage
    participant KC as Keycloak (auth.bcbpsolutions.com)
    participant R as PlatformRuntime

    S->>P: login({ workspace, returnUrl })
    P->>P: realm checked (^[a-z0-9][a-z0-9-]{0,62}$)<br/>state, nonce: 128 bit · code_verifier: 32 bytes · challenge S256
    P->>SS: pending-login record per state:<br/>{ state, codeVerifier, nonce, workspace, returnUrl (safe or '/'), reason, createdAt }
    P->>S: beforeRedirect listeners (reason: login · switch · step-up · restore)
    P->>KC: top-level redirect: /realms/{realm}/protocol/openid-connect/auth<br/>response_type=code · client_id · redirect_uri · scope · S256 · prompt? · max_age? · login_hint?
    KC-->>S: redirect_uri ?code&state&iss (or ?error)
    S->>P: init() on the callback path
    P->>SS: take the record for state (deleted before the exchange, 10-minute expiry)
    alt unknown or expired state
        P->>S: URL → '/', warn, continue as a normal load (silent restore)
    else iss ≠ record's issuer (RFC 9207)
        P-->>S: anonymous 'none' (error log), the code is never exchanged
    else ?error=login_required | interaction_required | consent_required on a restore
        P-->>S: anonymous 'login-required' + the record's workspace
    else ?code
        P->>KC: POST /token grant_type=authorization_code · code_verifier · redirect_uri · client_id (15 s)
        KC-->>P: access_token · id_token · refresh_token · expires_in · refresh_expires_in
        P->>P: ID token: iss · aud ∋ client_id · azp · nonce · exp/iat ±60 s<br/>(no signature check: it came straight from the token endpoint over TLS)
        P->>R: storageNamespace = realm, or trial:{tenant_id} (trial realm, else 'anon' + error log)
        P->>SS: clear the loop guard · localStorage: clear the signed-out mark
        P-->>S: authenticated { user, workspace, expiresAt }, URL → record's returnUrl
    end
    Note over P: tokens live only in this closure: never in storage, a global or the BroadcastChannel
```

The callback always lands on the fixed `redirectPath`. `init()` replaces the URL with the record's `returnUrl` (it must pass `isSafeRedirect`, else `/`) before it resolves, so the shell never sees the callback path.

---

## Session lifecycle

Every full page load starts with no tokens: they live only in memory, and the cross-tab channel never carries one. So `init()` restores with one silent `prompt=none` round trip to the cached workspace. `tender-web` rotates refresh tokens with max reuse 0, and Keycloak tracks reuse per lineage (verified, design doc §D6 L). So every tab has its own lineage and **never sends a refresh token that has already been replaced**. Doing so would revoke the SSO session for every tab.

> Source: [`docs/architecture/mermaid/auth-refresh-restore.mmd`](docs/architecture/mermaid/auth-refresh-restore.mmd)

```mermaid
stateDiagram-v2
    [*] --> loading
    loading --> authenticated: callback exchanged
    loading --> anonymous: no session · signed-out mark · loop guard · rejected callback
    loading --> redirecting: no tokens + cached workspace<br/>(one prompt=none per tab, loop guard set)
    redirecting --> [*]: page unloads to Keycloak

    state authenticated {
        [*] --> idle_timer
        idle_timer --> refreshing: timer at exp − min(60 s, life/3) ± jitter · getAccessToken near expiry · 401
        refreshing --> idle_timer: 200 → rotate tokens (never reuse a replaced refresh token)
        refreshing --> waiting_online: offline before sending → keep the token
        waiting_online --> refreshing: online event
        refreshing --> backing_off: 429, or 503 with Retry-After (refused unprocessed)<br/>keep the tokens · getAccessToken and 401s join this refresh
        backing_off --> refreshing: 2 s doubling to 30 s (jitter) or Retry-After,<br/>when the wait ends over 5 s before the access token expires
    }

    authenticated --> expired_server: invalid_grant before refresh_expires_in<br/>(serverEnded = true, e.g. trial → paid)
    authenticated --> expired_natural: invalid_grant / refresh token past its expiry<br/>(serverEnded = false)
    authenticated --> expired_idle: no activity in any tab for idleTimeoutMs<br/>(idle = true, session id rotated)
    authenticated --> restoring: sent but outcome unknown (timeout, network after send,<br/>500 · 502 · 504 · bare 503, other errors, bad ID token) → drop the lineage<br/>· or a backoff that would outlast the access token
    restoring --> [*]: wait online → beforeRedirect('restore') → prompt=none redirect
    authenticated --> anonymous: logout (this tab or a 'logout' broadcast)<br/>forget the user (authz subject, flags, read-only) · global = form POST to end-session
    expired_natural --> anonymous: 'logout' broadcast (expired and loading tabs follow it too)
    authenticated --> expired_natural: 'workspace-switched' broadcast from another tab

    expired_server --> [*]: shell dialog → signInAgain(forceResolve)
    expired_natural --> [*]: shell dialog → signInAgain()
    expired_idle --> [*]: shell dialog → signInAgain(prompt=login)
```

| Mark | Storage | Set | Cleared |
|---|---|---|---|
| Pending-login record (per `state`) | sessionStorage | before every authorize redirect | at the callback (before the exchange); expired after 10 min |
| Loop guard (one `prompt=none` per tab) | sessionStorage | before a silent redirect | when `init()` ends `authenticated` |
| Signed-out mark | localStorage (all tabs) | `logout()` | the next successful callback |
| Last activity (idle timeout) | localStorage (all tabs) | activity events, debounced to 5 s | — |
| Workspace cache (slug → realm, trial) | localStorage | `chooseWorkspace` (resolved slug) · `rememberWorkspace` | never by `clearAllAppStorage` |

---

## Remote loading

The shell loads `/remotes/manifest.json` once. Routes render `<RemoteBoundary remote module>`, which lazily calls `loadRemote` inside `Suspense` and an `MFEErrorBoundary`. Container globals follow one rule shared by `loadRemote` and `@bcbp-solutions-fzc-llc/webpack-preset`'s `containerName`: `__platform_mfe_` plus the remote's name, with `-` replaced by `_` (never the bare name: an element `id` or a browser global of that name would shadow it). `loadRemote` adds the entry script unless that global already holds a container.

> Source: [`docs/architecture/mermaid/remote-loading.mmd`](docs/architecture/mermaid/remote-loading.mmd)

```mermaid
sequenceDiagram
    autonumber
    participant SH as Shell bootstrap
    participant M as /mfe loadManifest
    participant RB as RemoteBoundary (/react)
    participant L as loadRemote (/mfe)
    participant DOM as document / script
    participant C as window.{container}
    participant EB as error boundary

    SH->>M: GET /remotes/manifest.json (no-cache, timeout remotes.loadTimeoutMs)
    Note over M: per remote: name ^[a-z][a-z0-9_-]{0,62}$ (not 'shell'),<br/>entry same origin or remotes.allowedOrigins, version, ownerDomain ∈ registry,<br/>integrity sha256/384/512 — an invalid remote is dropped with an error log
    M-->>SH: manifest → runtime.manifest + remotes (mfe → ownerDomain)
    RB->>L: lazy(loadRemote(remote, './Module')) inside Suspense
    alt killSwitch lists it, or flag remote.{name}.disabled
        L-->>RB: RemoteDisabledError (failure: disabled)
    else
        loop attempt ≤ 1 + retries (default 2), one timeout per attempt (default 10 s) over the entry, init and get
            L->>L: entry still allowed? (checked again before the script)
            L->>DOM: unless the global already holds a container: {script src} via Trusted Types<br/>createScriptURL · integrity + crossorigin when SRI is set
            DOM-->>C: remoteEntry.js defines window.__platform_mfe_<name, '-' → '_'>
            L->>C: init(share scope) — strictVersion clash → incompatible (no retry)
            L->>C: get('./Module') → factory()
        end
        L-->>RB: module (default export = component)
    end
    Note over L: span "remote load", platform_web_remote_load_* through the instrument port,<br/>one container per remote per page (a failed load is forgotten so it can retry)
    RB->>EB: any failure → MFEErrorBoundary with mfe = remote
    EB->>EB: chunk-load error → useBeforeAuthRedirect listeners → reload once per version (sessionStorage guard)<br/>else log + platform_web_errors_total{source=boundary}, fallback with Try again (new lazy)
    SH->>SH: startVersionPolling: /version.json every 5 min (pollIntervalMs, 10 s fetch timeout) and on visible → useAppUpdate().available
```

Sharing: the shell provides React, react-dom, `@opentelemetry/api` (`~1.10.0`) and every SDK subpath except `/testing` as strict singletons (`platformShared`). Remotes take the SDK with `import: false`, so they never bundle it. A remote that requires an SDK version the shell does not provide (`^<the version it was built against>`) fails share negotiation, which shows as a `RemoteLoadError` in its own boundary, not as a broken shell.

---

## Error handling (RFC 9457)

Every non-2xx answer becomes a `ProblemError`. Platform services send `application/problem+json`; anything else is synthesized from the status, and its body is never surfaced. The SDK matches types by `typeId` (`{domain}/{error}`), never by the full URI, title or detail. See [docs/problem-details](docs/problem-details/README.md).

> Source: [`docs/architecture/mermaid/error-handling.mmd`](docs/architecture/mermaid/error-handling.mmd)

```mermaid
flowchart TD
    resp["non-2xx Response"] --> parse{"application/problem+json<br/>and ≤ 1 MiB?"}
    parse -->|yes| pd["ProblemDetails: type · title · status · detail · instance · traceId ·<br/>errorCode · tenantId · timestamp · validationErrors · extensions<br/>typeId = last two path segments of type"]
    parse -->|no| syn["synthetic problem from typeForStatus(status)<br/>traceId from X-Trace-ID · synthetic: true · raw body never surfaced"]
    pd --> pe["ProblemError (requestId attached)"]
    syn --> pe
    net["fetch failed"] --> ne["NetworkError { offline, requestId }"]
    to["deadline"] --> te["TimeoutError { timeoutMs, requestId }"]
    ab["caller aborted"] --> ae["AbortedError (never reported)"]

    pe --> deny{"gatewayDenyCode(e)"}
    deny -->|DENY_MFA_STALE| stepup["useStepUp → reauthenticate (prompt=login, max_age)"]
    deny -->|DENY_TENANT_READ_ONLY| ro["runtime.readOnlyDenied → useReadOnly() = true"]
    deny -->|DENY_MALFORMED_IDENTITY| again["sign in again"]
    deny -->|DENY_UNRESOLVABLE_SUBJECT| setup["'workspace being set up' → retry 6 s / 12 s / 24 s, never sign out"]
    deny -->|none| ui

    pe --> ui["useApi → { error } · e.is(PlatformProblemTypes.X)<br/>toFieldErrorMap(e) · problemMessage(e): platform problem.&lt;typeId&gt;[.&lt;errorCode&gt;], else title"]
    ne --> ui
    te --> ui
    ui -->|"rethrown / render error"| mb["MFEErrorBoundary { mfe }<br/>fallback shows traceId / requestId + Try again<br/>API error → warn log · render bug → error log"]
    other["uncaught error · unhandled rejection"] --> gh["installGlobalErrorHandlers → error log<br/>chunk-load → reload once"]
```

---

## Integration touchpoints

Everything the SDK calls outside the page, and what happens when it fails. All of it is same-origin through CloudFront except Keycloak. Only a missing `runtime.json` stops the page; every other failure degrades a part of it.

> Source: [`docs/architecture/mermaid/integration-touchpoints.mmd`](docs/architecture/mermaid/integration-touchpoints.mmd)

```mermaid
flowchart LR
    subgraph page["Browser page (shell + remotes, one SDK runtime)"]
        cfg["/config"]
        auth["/auth"]
        http["/http ApiClient"]
        mfe["/mfe"]
        tel["/tracing · /logging · /metrics"]
        ports["Shell ports:<br/>WorkspaceResolver · SessionContextSource"]
    end

    subgraph cf["Same origin: CloudFront"]
        rj["/config/runtime.json<br/>no-cache · 10 s"]
        man["/remotes/manifest.json<br/>no-cache · remotes.loadTimeoutMs"]
        re["/remotes/&lt;name&gt;/&lt;version&gt;/…<br/>immutable · SRI"]
        ver["/version.json<br/>no-cache · appUpdate.pollIntervalMs"]
        api["/api/* → Envoy → IAM AuthZ Enrichment → services"]
        otel["/otel/v1/{traces,logs,metrics}<br/>→ OTel Collector gateway"]
    end

    kc["Keycloak (auth.idpOrigin)<br/>/realms/&lt;realm&gt;/protocol/openid-connect/…"]

    cfg -->|"fatal on failure"| rj
    mfe -->|"slots show fallbacks"| man
    mfe -->|"that remote's boundary"| re
    mfe -->|"ignored; next poll"| ver
    ports -->|"PUB-1 (no token) · P-35"| http
    http -->|"token, request id, traceparent"| api
    tel -->|"dropped and counted"| otel
    auth -->|"auth: top-level redirect"| kc
    auth -->|"token: fetch, 15 s"| kc
    auth -->|"logout: form POST"| kc
```

| Call | Made by | When | Bound | On failure |
|---|---|---|---|---|
| `GET /config/runtime.json` | `loadRuntimeConfig` | Bootstrap step 2 | 10 s | Fatal: the static "unavailable" page |
| Keycloak `…/auth` | `login`, silent restore (`prompt=none`), step-up, switch | Top-level redirect | — | `?error=` on the callback → `anonymous` |
| Keycloak `…/token` | Code exchange, refresh | `fetch` | 15 s | Exchange: `anonymous`. Refresh: 429 or 503 with `Retry-After` → backoff with tokens kept; anything ambiguous → lineage dropped, silent restore |
| Keycloak `…/logout` | `logout()` (global by default) | Hidden form POST | — | The local sign-out has already happened |
| PUB-1 `GET /api/v1/public/tenants/resolve` | Shell `WorkspaceResolver` | Before sign-in | `api.timeoutMs` | Cached entry for the slug, else the identifier-first screen |
| P-35 `GET /api/v1/me/session-context` | Shell `SessionContextSource` | After sign-in | `api.timeoutMs` | Deny-all permissions, platform flags only; the example shell retries a transient failure 3 times |
| `/api/*` | `ApiClient` | App calls | `api.timeoutMs` (35 s) per attempt | Idempotent calls retried (default 2, at most 5); RFC 9457 `ProblemError` |
| `GET /remotes/manifest.json` | `loadManifest` | Bootstrap step 9 | `remotes.loadTimeoutMs` | Every remote slot shows its fallback |
| `remoteEntry.js` and chunks | `loadRemote` | A slot's first render | `remotes.loadTimeoutMs` per attempt, `remotes.retries` | That remote's boundary fallback |
| `GET /version.json` | `startVersionPolling` | Every `appUpdate.pollIntervalMs` | — | Ignored until the next poll |
| `POST /otel/v1/{traces,logs,metrics}` | The exporters | Batches, page hide, `pagehide` | Bounded queues, 60 KiB keepalive budget | Dropped and counted |

---
## Cache strategy

The SDK never caches an API response: identical GETs in flight share one request, and nothing outlives the response. What it keeps is what a page or the next sign-in needs, each with a bound. Tokens are memory-only on purpose, so every page load restores the session with one silent round trip instead of reading a stored token.

> Source: [`docs/architecture/mermaid/cache-strategy.mmd`](docs/architecture/mermaid/cache-strategy.mmd)

```mermaid
flowchart TD
    subgraph memory["Memory only (one page, gone on reload)"]
        m1["Tokens: access · refresh · ID<br/>/auth closure; never storage, channel, log or span"]
        m2["In-flight GETs: one per URL + token + headers<br/>dedupe until the response; no response cache"]
        m3["Remote containers: one per remote per page<br/>a failed or timed-out load is forgotten"]
        m4["i18n catalogs per namespace + locale<br/>load ≤ 10 s; failed: retried 2, 4, 8 s while shown"]
        m5["Intl formatters: ≤ 200 per kind, then cleared<br/>key = locale + options"]
        m6["Manifest · runtime config · flags · authz subject<br/>on the PlatformRuntime, frozen"]
    end

    subgraph local["localStorage (shared by tabs, outlives the page)"]
        l1["Workspace cache: ≤ 20 { slug, realm, trial }<br/>kept by clearAllAppStorage: the next sign-in needs it"]
        l2["RUM session id: 24 h, rotated on logout, switch, idle"]
        l3["auth: signed-out mark · last activity · last user (SHA-256)"]
        l4["/storage values: storage:&lt;namespace&gt;:&lt;appId&gt;:&lt;key&gt;<br/>cleared on logout, switch, another user"]
    end

    subgraph session["sessionStorage (one tab)"]
        s1["Pending login per state: 10 min"]
        s2["Restore loop guard · chunk-reload guard (per version)"]
        s3["/storage area 'session' (drafts)"]
    end

    subgraph http["HTTP caches (CloudFront + browser)"]
        h1["no-cache + ETag: runtime.json · manifest.json · version.json · index.html"]
        h2["immutable, 1 year: /assets/* (content-hashed) · /remotes/&lt;name&gt;/&lt;version&gt;/*"]
        h3["CachingDisabled: /api/* · /otel/* · /csp-report"]
    end
```

| Cache | Where | Bound | Cleared or refreshed by |
|---|---|---|---|
| Tokens | `/auth` closure | Access token lifetime; refreshed 60 s before expiry (at most a third of the lifetime), ± up to 10 s | Logout, switch, expiry, page unload |
| In-flight GETs | `/http` | Until the response | Each subscriber's abort; the fetch aborts when all have |
| Remote containers | `PlatformRuntime` | One per remote per page | A failed or timed-out load is forgotten |
| i18n catalogs | `/i18n` | One per namespace and locale | `setLocale`; a failed load retried 2, 4 and 8 s later while shown |
| Intl formatters | `/i18n` | 200 per kind, then cleared | — |
| Workspace cache | localStorage | 20 entries, newest first | Kept on logout: the next sign-in needs it |
| RUM session id | localStorage | 24 h | Logout, workspace switch, idle timeout |
| `/storage` values | local or session | Per workspace namespace | Logout, switch, a different user signing in |
| Pending login | sessionStorage | 10 min per `state` | The callback deletes it before the exchange |
| `runtime.json`, manifest, `version.json`, `index.html` | HTTP | `no-cache` + ETag | Every load revalidates |
| `/assets/*`, `/remotes/<name>/<version>/*` | HTTP | Immutable, 1 year | A new build has new names |

---
## Data model

The SDK has no server-side data. Its state is in three places, all on the user's device: the `PlatformRuntime` object (memory, one per page, shared by every SDK copy), `localStorage` (shared by the tabs of one origin) and `sessionStorage` (one tab). Two files configure it: `runtime.json` and the remote manifest. Their schemas are strict, and the full key lists are LLD §12.1 (`runtime.json`) and §12.3 (storage keys).

> Source: [`docs/architecture/mermaid/data-model.mmd`](docs/architecture/mermaid/data-model.mmd)

```mermaid
erDiagram
    RUNTIME_JSON ||--|| PLATFORM_RUNTIME : "loaded, validated, frozen into config"
    REMOTE_MANIFEST ||--o{ MANIFEST_ENTRY : "one per remote"
    PLATFORM_RUNTIME ||--|| REMOTE_MANIFEST : "manifest"
    PLATFORM_RUNTIME ||--o{ STORAGE_KEY : "storageNamespace scopes /storage keys"
    PLATFORM_RUNTIME ||--o| TOKENS : "tokenSource reads; never stored"
    WORKSPACE_CACHE ||--o{ WORKSPACE : "≤ 20, newest first"

    RUNTIME_JSON {
        enum environment "optional: local, dev, test, staging, prod"
        object api "baseUrl, timeoutMs, propagationAllowlist"
        object telemetry "enabled, otlpBaseUrl, sampleRatio, logLevel, sendSessionHeader"
        object auth "idpOrigin, trialRealm, paidRealmPrefix, workspacePathPrefix, clientId, scopes, idleTimeoutMs, redirectPath, signInUrl"
        object flags "name to boolean, string or number"
        object remotes "killSwitch, loadTimeoutMs, retries, allowedOrigins"
        object i18n "defaultLocale, supportedLocales"
        object appUpdate "pollIntervalMs"
    }
    PLATFORM_RUNTIME {
        string sdkVersion "duplicate-copy detection"
        object identity "serviceName, domain, environment, buildVersion"
        object config "RUNTIME_JSON, deep-frozen"
        string storageNamespace "realm, trial:tenant_id, or anon"
        object authzSubject "roles, departments from P-35"
        object flagProvider "runtime config, then session context"
        object manifest "REMOTE_MANIFEST, frozen"
        object tracing_logging_metrics "exporters, queues, stats"
        object unload "keepalive ledger, senders"
    }
    MANIFEST_ENTRY {
        string entry "remoteEntry.js URL"
        string version "immutable path segment"
        string ownerDomain "registry domain"
        string integrity "sha384, required outside local, dev, test"
    }
    STORAGE_KEY {
        string key "frontend-sdk:storage:namespace:appId:key"
        enum area "local or session"
    }
    WORKSPACE {
        string slug "kebab, at most 63"
        string realm "tenant-slug or trial"
        boolean trial "shared trial realm"
    }
    WORKSPACE_CACHE {
        string key "frontend-sdk:workspaces (localStorage)"
    }
    TOKENS {
        string access "memory only"
        string refresh "memory only, rotated, max reuse 0"
        string id "memory only, id_token_hint in the logout POST body"
    }
```

- **Reserved keys** are under `@bcbp-solutions-fzc-llc/frontend-sdk:`. App code reaches storage only through `storage(appId)`, which adds the workspace namespace (lint rule `no-raw-storage`).
- **Tokens are not in the model.** They exist only inside the `/auth` closure; `/storage` refuses token-like keys, and tests scan storage and the channel for them.
- **`runtime.json` is validated strictly:** an unknown key, a wrong type or an http origin outside local, dev and test fails the load with every offending path named.

---
## Cross-tab and in-page events

Two event paths, neither carrying data a later reader could misuse. Between tabs, `BroadcastChannel('platform-auth')` carries two message types, `logout` and `workspace-switched`, and `localStorage` shares the signed-out mark and the last activity time. Inside a page, the `PlatformRuntime` publishes five topics that the `/react` hooks subscribe to, so a change made by the shell (or by another tab's sign-out) re-renders every remote without them importing the shell.

> Source: [`docs/architecture/mermaid/cross-tab-events.mmd`](docs/architecture/mermaid/cross-tab-events.mmd)

```mermaid
sequenceDiagram
    participant A as Tab A (/auth)
    participant LS as localStorage (shared)
    participant BC as BroadcastChannel('platform-auth')
    participant B as Tab B (/auth)
    participant RT as Tab B PlatformRuntime events
    participant UI as Tab B React (/react hooks)

    Note over A,B: Each tab keeps its own tokens and refresh lineage, and nothing on the channel or in storage is a token.
    A->>LS: user activity → auth:last-activity (at most every 5 s)
    B->>LS: idle check every ≤ 15 s reads the shared last activity
    A->>A: logout(): drop tokens, clearAllAppStorage(), rotate session id
    A->>LS: auth:signed-out = true
    A->>BC: { type: 'logout' }
    BC-->>B: logout
    B->>B: drop tokens, forgetUser() (namespace 'anon', authz subject, flags, read-only)
    B->>RT: emit 'flags' · 'authz' · 'read-only' · 'session'
    RT-->>UI: useFeatureFlag · useHasPermission · useReadOnly · useSession re-render
    UI->>UI: shell unmounts the app, shows "You are signed out"
    A->>A: switchWorkspace(w): drop tokens, clear storage, rotate session id
    A->>BC: { type: 'workspace-switched' }
    BC-->>B: workspace-switched
    B->>B: expire({ serverEnded: false }) → session-ended dialog
    Note over B: A sign-in this tab was finishing does not undo a logout from another tab (signedOutElsewhere).
```

| Signal | Path | Effect |
|---|---|---|
| `logout` | Channel | The receiving tab drops its tokens and forgets the user, then shows "You are signed out" |
| `workspace-switched` | Channel | The receiving tab expires its session (`serverEnded: false`): the session-ended dialog |
| `auth:signed-out` | localStorage | The next sign-in in any tab uses `prompt=login`, never the live SSO session |
| `auth:last-activity` | localStorage | Idle timeout counts activity in every tab (written at most every 5 s, checked every ≤ 15 s) |
| `session` | Runtime topic | `useSession`, `useCurrentUser`, `useWorkspace` |
| `flags` | Runtime topic | `useFeatureFlag` |
| `authz` | Runtime topic | `useHasPermission`, `<Can>` |
| `read-only` | Runtime topic | `useReadOnly` |
| `i18n` | Runtime topic | `useT`, `useLocale` |

Listeners are snapshotted before they are notified, and a throwing listener never stops the others. Without `BroadcastChannel`, other tabs learn of a sign-out at their next refresh.

---

## Telemetry pipeline

Logs, traces and metrics leave the page over OTLP/HTTP to the same-origin `/otel` path. CloudFront forwards it to the OTel Collector; there is no Faro SDK and no second pipeline. When the page is hidden or closing, the three signals share one 60 KiB keepalive budget in a fixed order (metrics' share, logs, spans), and every request that must outlive the tab starts inside the listener (`src/internal/unload`, LLD §7.5). The reference Collector configuration is two-tier (`examples/collector`, LLD §7.6): a gateway that scrubs, allowlists and routes each metric stream to one aggregator, which converts delta to cumulative. Everything is redacted with the same rules as gincommon's log sanitizer, gated on consent, and queued with fixed bounds, so a slow or unreachable collector costs a fixed amount of memory. Nothing is printed to the console outside local and dev while logging runs; before it starts, with telemetry off, or on a remote's standalone page (no collector), `warn` and `error` go to the console, redacted (LLD §7.2). See [docs/observability](docs/observability/README.md).

> Source: [`docs/architecture/mermaid/telemetry-pipeline.mmd`](docs/architecture/mermaid/telemetry-pipeline.mmd)

```mermaid
graph LR
    subgraph sources["Signals (shell and remotes)"]
        logs["getLogger({ mfe }).info/warn/error<br/>+ envelope: trace_id · span_id · request_id ·<br/>session_id · mfe · page_route"]
        spans["getTracer().startSpan · withSpan<br/>/http and /mfe spans"]
        meters["getDomainMeter · getServiceMeter (Tier 2/3)<br/>instrument port → platform_web_* (Tier 1, pending)"]
    end

    subgraph guard["Before anything leaves the page"]
        redact["redaction: sensitive keys → [REDACTED] · JWT / Bearer patterns<br/>URL query + fragment dropped · stack ≤ 4 KiB<br/>sanitizeString: control chars, U+2028/2029"]
        consent{"consent"}
        sample["ParentBased + Go's TraceIDRatioBased<br/>(sampleRatio, default 0.1)"]
        checks["registration checks = metricslint rules<br/>Tier 3: ≤ 8 labels · label values ≤ 100 → __other__"]
    end

    subgraph queues["Bounded queues (drop oldest, ≤ 2 sends in flight)"]
        lq["logs: batch 50 · 5 s · queue 1000"]
        tq["spans: batch 512 · 5 s · queue 2048"]
        mq["metrics: delta temporality · every 60 s"]
    end

    unload["hide / pagehide: one 60 KiB keepalive budget (src/internal/unload)<br/>metrics share reserved → logs by sendBeacon → newest spans<br/>started inside the listener · ledger of what is in flight"]

    otel["/otel/v1/{logs,traces,metrics}<br/>(same origin; CloudFront → OTel Collector)"]

    logs --> redact --> consent
    spans --> sample --> consent
    meters --> checks --> consent
    consent -->|"error always · warn if essential or telemetry granted ·<br/>info/debug only with telemetry"| lq
    consent -->|"telemetry granted"| tq
    consent -->|"telemetry granted (interval discarded otherwise)"| mq
    lq --> otel
    tq --> otel
    mq --> otel
    lq & tq & mq -.-> unload -.-> otel
    otel --> gw["Collector gateway (examples/collector/gateway.yaml)<br/>drops per-browser attributes (metrics: every resource attribute)<br/>name + label-key + label-value allowlists (Tier 3 ≤ 8 keys)<br/>routes each metric stream to one aggregator"]
    gw -->|"metrics"| agg["Collector aggregator (aggregator.yaml)<br/>arrival-time stamp · delta → cumulative → Mimir"]
    gw -->|"traces · logs"| backends["Tempo · Loki"]
```

Identity on every signal is the **page** identity (`initializeCore`: `domain` / `service` / `environment`, e.g. `portal` / `web-app`). Remotes are told apart by the `mfe` attribute or label, never by a second `domain`. The one exception is a remote's own Tier 2/3 metrics, which carry its manifest `ownerDomain` (design doc §D1).

---

## Workspace isolation in the browser

The browser counterpart of the services' row-level security. One device can be used by several people and several workspaces, so everything the SDK stores for an app is scoped to the signed-in workspace and removed when that person leaves. The gateway enforces the real tenant isolation; this keeps one tenant's leftovers out of the next session on the same device.

> Source: [`docs/architecture/mermaid/workspace-isolation.mmd`](docs/architecture/mermaid/workspace-isolation.mmd)

```mermaid
flowchart TD
    signin["Signed in to a workspace"] --> ns{"Namespace"}
    ns -- "paid realm" --> nsp["tenant-acme"]
    ns -- "trial realm" --> nst["trial:&lt;tenant_id&gt;<br/>(the realm alone would mix tenants)"]
    ns -- "not signed in" --> anon["anon: set() is a no-op with a dev warning<br/>nothing is written a later tenant could read"]
    nsp & nst --> keys["storage(appId).set(k, v)<br/>→ frontend-sdk:storage:&lt;namespace&gt;:&lt;appId&gt;:&lt;k&gt;<br/>token-like keys refused (ForbiddenStorageKeyError)"]

    subgraph clear["What clears it (clearAllAppStorage + forgetUser)"]
        c1["logout(): every /storage key, both areas; session id rotated; signed-out mark"]
        c2["switchWorkspace(): same, then a new sign-in"]
        c3["Sign-in by another user: SHA-256(realm + sub) differs from auth:last-user"]
        c4["Another tab's logout or switch: forgetUser() in this tab"]
    end
    keys --> clear
    clear --> kept["Kept: workspace cache, RUM session id (rotated), keys other code wrote"]
```

| Rule | Mechanism |
|---|---|
| Keys are per workspace | Namespace = paid realm, or `trial:<tenant_id>` in the shared trial realm, or `anon` before sign-in |
| Nothing is written before sign-in | `set()` in `anon` is a no-op with a dev warning |
| A sign-out removes everything | `clearAllAppStorage()` (both areas, every workspace and app, keys from `alpha.3` and earlier too), session id rotated, signed-out mark set, other tabs told |
| A different person clears the previous one's data | SHA-256 of realm + `sub` compared with `auth:last-user` at sign-in |
| Another tab's sign-out reaches this tab | `forgetUser()`: namespace `anon`, authz subject, flags and read-only cleared |
| No credentials in storage | Token-like keys refused (`ForbiddenStorageKeyError`) |

---

## Contracts and drift control

Nothing backend-shaped is written by hand. Constants, vocabularies, rules and fixtures are generated from backend commits pinned in `contracts/sources.json`, and CI fails when they drift. Moving a pin is a reviewed change: `pnpm contracts:sync --update-pins`, then review the generated diff.

> Source: [`docs/architecture/mermaid/contracts-drift.mmd`](docs/architecture/mermaid/contracts-drift.mmd)

```mermaid
graph LR
    subgraph pinned["Backend sources at pinned commits (contracts/sources.json)"]
        gin["platform-gincommon<br/>registry.json · transport/validation · log sanitizer ·<br/>problem rules · logging fields"]
        fast["platform-fastapicommon<br/>vendored registry (drift warning)"]
        probe["platform-interop-tests<br/>go-probe contracts-export · shared fixtures"]
        evpg["platform-events · platform-pgcommon<br/>(to build go-probe)"]
        az["iam-authz-enrichment<br/>deny reasons · injected headers"]
        om["iam-org-membership<br/>swagger: PUB-1 · P-35"]
    end

    sync["scripts/sync-contracts.ts<br/>(pure transforms in scripts/lib/contracts.ts)"]
    gin --> sync
    fast --> sync
    probe --> sync
    evpg --> sync
    az --> sync
    om --> sync

    subgraph out["Generated, committed"]
        json["contracts/*.json + fixtures/"]
        ts["src/internal/generated/*.ts<br/>(one module per contract)"]
        tool["eslint-plugin forbidden-headers.ts"]
        docsgen["docs: metric-registry.md · problem-details/registry.md"]
    end
    sync --> json
    sync --> ts
    sync --> tool
    json -->|pnpm docs:sync| docsgen

    subgraph ci["CI gates"]
        cc["Validate / Contracts: contracts:check (stale = fail)"]
        mp["metrics:parity: SDK checks vs metricslint · inventory passes -strict"]
        ip["interop pair 4: SDK /http + /problem vs live Go and Python servers"]
        dc["Validate / Quality: docs:check · exports:check (SDK facts in preset + eslint-plugin)"]
    end
    json --> cc
    ts --> mp
    ts --> ip
    docsgen --> dc
```

---

## CI and release

`.github/` mirrors platform-gincommon's pipeline: the same job names and gates. gincommon's image jobs (build, Trivy, smoke) map to this repo's three npm packages: pack them, scan the files and lockfile, smoke-test the tarballs.

> Source: [`docs/architecture/mermaid/ci-pipeline.mmd`](docs/architecture/mermaid/ci-pipeline.mmd)

```mermaid
graph LR
    subgraph ci["ci.yml  —  every PR (any base) and push to main"]
        vt["Validate / Test<br/>all tests · coverage ≥ 98% of packages/*/src"]
        vq["Validate / Quality<br/>hygiene · action pins · lockfile · exports · lint · types ·<br/>build · API reports · depcruise · examples CSP · docs · audit"]
        vc["Validate / Contracts<br/>contracts:check · metrics:parity"]
        pk["Package tarballs<br/>build + pnpm pack ×3"]
        tv["Trivy scan<br/>fs: deps · secrets · config → SARIF + SBOM"]
        sm["Smoke tests<br/>tarballs in an empty consumer"]
        io["Cross-language compatibility<br/>interop.yml (pair 4 at this ref)"]
        br["Browser tests<br/>Playwright: Chromium · Firefox · WebKit"]
        rf["React floor (19.0.0)<br/>types · unit tests · build"]
        e9["ESLint 9<br/>eslint-plugin tests on ESLint 9"]
        co["Collector config<br/>examples/collector in the Collector image"]
        ps["PR summary comment"]
        vt --> tv
        pk --> tv
        vt --> sm
        pk --> sm
        vt --> io
        vt --> br & rf & e9 & co
        vt & vq & vc & pk & tv & sm & io & br & rf & e9 & co --> ps
    end

    subgraph rel["release.yml  —  tag vX.Y.Z (one version, changesets fixed)"]
        vf["verify: tag on main · versions = tag · CHANGELOG.md section"]
        gates["ci.yml gates at the tag<br/>(not browser, collector)"]
        np["npm-publish: GitHub Packages (dist-tag alpha/rc/latest)<br/>publish gate: env limited to release tags + tag ruleset<br/>provenance attestation per tarball"]
        pub["publish: GitHub Release<br/>tarballs · SBOM · checksums.txt + Cosign bundle"]
        vf --> gates --> np --> pub
    end

    nightly["stack-nightly.yml — 01:30 UTC and on dispatch<br/>the integrated stack (test/stack) against pinned backends<br/>a failing scheduled run opens an issue"]

    cs["changelog-check.yml<br/>published package changed → .changeset/*.md + CHANGELOG.md<br/>(release PR: changesets consumed, incl. moved to .changeset/pre/)"]
    rpr["release PR: pnpm changeset version"] --> tag["tag the merge commit"] --> vf
```

---

## Concurrency model

The browser is single-threaded; concurrency here means overlapping promises and several tabs.

| Concern | Mechanism |
|---|---|
| Concurrent identical GETs | One in-flight call per key (URL + token + headers); the shared fetch is aborted only when every subscriber has aborted |
| Token refresh | One in-flight `refresh()` per tab; the timer, `/http`'s 401 path and direct callers await the same promise, including its backoff after a 429 or a 503 with `Retry-After`; a new refresh starts only after it settles, with the token it returned |
| Tabs | One refresh lineage per tab, never shared; `BroadcastChannel('platform-auth')` carries only `logout` and `workspace-switched`; idle activity and the signed-out mark are shared through localStorage |
| Remote containers | One container per remote per page, cached on the runtime (shared by SDK copies); concurrent `loadRemote` calls share it; a failed or timed-out load is forgotten so a retry starts fresh |
| i18n catalogs | One in-flight load per namespace and locale |
| Telemetry export | At most two sends in flight per signal; beyond the queue bound the oldest items are dropped and counted |
| Runtime listeners | Snapshot before notify; a throwing listener never stops the others |

## Failure domains

| Failure | Effect | What still works |
|---|---|---|
| `runtime.json` unreachable, invalid or slower than 10 s | Fatal at bootstrap (static page) | — |
| `/otel` down or slow | Queues fill, oldest dropped, failures counted | Everything else; no retries into a struggling page |
| Keycloak unreachable during refresh | Ambiguous outcome (network error, 500, 502, 504, bare 503) → lineage dropped → silent restore after `online` | Calls fail with 401/`NetworkError` meanwhile; no sign-out |
| Keycloak shedding load (429, or 503 with `Retry-After`) | Tokens kept; the refresh retried with backoff while the access token stays valid, then a silent restore | Calls wait for the refresh, then carry the token |
| Session ended by the server (`invalid_grant`) | `expired { serverEnded: true }` → dialog → re-resolve the workspace | Drafts saved by `beforeRedirect` listeners |
| P-35 session context fails | Deny-all permissions, platform flags only, workspace not cached; the example shell retries a transient failure 3 times (1 s, 2 s, 4 s) | Signed-in shell |
| Manifest fails or times out | Every remote slot shows its fallback | Shell routes |
| A remote fails to load or render | That remote's boundary fallback with `traceId` / Try again | Shell and other remotes |
| Old chunks gone after a deploy | One reload per version (sessionStorage guard), after the `useBeforeAuthRedirect` listeners | Drafts those listeners saved |
| Consent not granted | Only `error` logs and essential `warn` logs leave the page | All functionality |
| localStorage / sessionStorage blocked | Session id per page; storage kept in memory; **sign-in impossible** (no pending-login record), stated, never silent | Anonymous pages |

## Key invariants

| Invariant | Where enforced |
|---|---|
| Tokens are never in storage, a global, a log or the channel | `/auth` closure; `/storage` refuses token-like keys; redaction of JWT/Bearer patterns; auth tests scan storage |
| The browser never sends identity headers | `/http` drops `FORBIDDEN_REQUEST_HEADERS` (generated from gincommon + AuthZ Enrichment); `@bcbp-solutions-fzc-llc/eslint-plugin` `no-identity-headers`; interop pair 4 |
| The access token goes to the page's own origin only | `/http` `isSameOrigin` check before `Authorization` |
| A replaced refresh token is never sent | single-flight `refresh()`; ambiguous failures drop the lineage instead of retrying; only an answer that says it was not processed (429, 503 with `Retry-After`) is retried with the same token |
| Metric `route` labels are templates, never raw URLs | `ApiClient` takes templates; `api-route-template` lint rule |
| Metric names, labels and units follow the registry | `/metrics` registration checks = gincommon `metricslint` rules (`metrics:parity` in CI) |
| One page identity; remotes never set `domain` | `/core` `initializeCore` once; `IdentityMismatchError` on a different second call |
| Nothing leaves the page without consent (except errors) | consent gates in the log, span and metric pipelines |
| No `eval`, no inline script (CSP `script-src 'self'`) | preset (no eval devtools, `environment.globalThis`); Zod jitless; `examples:check`; `no-eval` lint |
| Untrusted HTML only through DOMPurify + Trusted Types | `/security` `sanitizeHtml`; `no-unsafe-html` lint |
| A remote never bundles the SDK | `sharedFor('remote')` `import: false`; `examples:check` |
| A build uses the SDK its preset was made for | `SdkVersionPlugin` in every preset |
| The ID token never lands in a URL | Global sign-out is a form POST (`id_token_hint` in the body); CSP `form-action` allows the IdP origin |
| Contracts are generated, never edited | `contracts:check`, `docs:check` in CI |

## Deployment

Nothing in this repository is deployed. It publishes three packages (see *Release and distribution*), and each app built with them is deployed by its own pipeline to S3 behind CloudFront. `examples/cloudfront` holds what that infrastructure must do, tested here: the response headers (`csp.mjs`), the SPA rewrite, the `/csp-report` Lambda and the behaviors table.

> Source: [`docs/architecture/mermaid/deployment.mmd`](docs/architecture/mermaid/deployment.mmd)

```mermaid
flowchart LR
    subgraph build["Build once (CI of each app)"]
        shell["Shell build<br/>index.html + /assets/* (content-hashed, SRI-pinned)<br/>no environment inside"]
        remote["Remote build<br/>remoteEntry.js + chunks (sha384 in the entry)"]
    end

    subgraph s3["S3 (per environment)"]
        o1["/remotes/&lt;name&gt;/&lt;version&gt;/… (never overwritten)"]
        o2["/remotes/manifest.json { entry, version, ownerDomain, integrity }"]
        o3["/assets/* · index.html"]
        o4["/config/runtime.json (names its own environment)"]
        o5["/version.json (written last)"]
    end

    remote -->|"1. upload"| o1
    o1 -->|"2. manifest after every remote"| o2
    shell -->|"3. hashed files, index.html last"| o3
    o4 -.->|"per environment, from the deploy pipeline"| o4
    o3 -->|"4. version.json: open tabs see an update"| o5

    subgraph cdn["CloudFront (one distribution per environment)"]
        b1["Default (*): spa-rewrite.js → index.html, no-cache"]
        b2["/assets/*, /remotes/*: immutable"]
        b3["runtime.json, manifest.json, version.json: no-cache + ETag"]
        b4["/api/* → gateway · /otel/* → Collector · /csp-report → Lambda"]
        hdr["Response headers: CSP (Trusted Types, form-action IdP), HSTS, …<br/>examples/cloudfront/csp.mjs"]
    end
    s3 --> cdn
    cdn --> browser["Browser: one shell build in every environment"]
```

- **Build once.** The shell build carries no environment: `runtime.json` names it, so one build is promoted through every environment. Each environment's deploy writes its own `runtime.json`, and its pipeline should check `environment` equals the target (LLD §15).
- **Deploy order.** Remotes under a new `/remotes/<name>/<version>/` (never overwritten), then the manifest with each entry's `integrity`, then the shell (hashed files first, `index.html` last), then `/version.json`, which tells open tabs to update.
- **Chain of trust.** The manifest's sha384 pins `remoteEntry.js`, which pins each of its chunks (`ChunkIntegrityPlugin`). `index.html` pins the shell's scripts and stylesheets.
- **Headers.** The CSP allows scripts from `'self'` only, requires Trusted Types (policies `platform-sdk`, `platform-webpack`, `dompurify`) and lets `form-action` reach the IdP origin for the sign-out POST.

---

## Release and distribution

All three packages share one version (`fixed`). The release flow:
1. A release PR runs `pnpm changeset version`.
2. The merge commit is tagged `vX.Y.Z`.
3. `release.yml` verifies the tag and versions and reruns the `ci.yml` gates at the tag (all but `browser` and `collector`).
4. `npm-publish` publishes the three packages to **GitHub Packages** (`@bcbp-solutions-fzc-llc/*`), with a build-provenance attestation each, only if publishing is gated: required reviewers, or (this private repository on GitHub Team) an `npm` environment limited to release tags plus a tag ruleset over who may push them (`check-npm-environment.sh`).
5. A **GitHub Release** carries the tarballs, a CycloneDX SBOM and Cosign-signed checksums.

The first release is `v1.0.0-alpha.1` (2026-11-03); `v1.0.0-alpha.4` (2026-11-05)'s breaking changes (the container global, the `/storage` key prefix, the CSP `form-action` for the sign-out POST, at most 8 Tier 3 labels, stricter lint rules) mean the shell and every remote upgrade together. `v1.0.0-alpha.5` (2026-11-05) added the optional `auth.signInUrl`. The latest is `v1.0.0-alpha.6` (2026-11-05, not breaking, the shell upgrades first): `runtime.json` names the `environment`, so one shell build serves every environment; `formatDate` takes calendar dates; `warn` and `error` reach the console while logging is not running.

During the alpha, versions are `1.0.0-alpha.N`. The shell shares the SDK under `^1.0.0-0`; each remote requires `^<the SDK version it was built against>`, so a shell with an older SDK refuses it at share negotiation. `1.0.0` is cut with the first environment, and SemVer is strict from then on (design doc §C3 "Versioning").

## Testing strategy

| Layer | How |
|---|---|
| Unit | Vitest per subpath (`test/unit/<subpath>`). Node by default; `happy-dom` for React; `jsdom` for DOMPurify. Coverage gate ≥ 98 % statements of `packages/*/src` (`pnpm test`: 1530 tests in 61 files, 98.7 %) |
| Integration / E2E | `test/integration`: subpaths wired together; `test/e2e`: the reference shell and remote booted end to end (both in-process, jsdom) |
| Browser | `test/browser`: Playwright in Chromium, Firefox and WebKit under the production CSP: the keepalive budget on hide and tab close, page-lifecycle event order, SRI on lazy JS and CSS chunks (webpack and Rspack builds of the example remote and of `styled-remote/`), `AbortSignal.any` native and absent, Trusted Types (CI job `browser`); engine limits in `engine-notes.ts` |
| Collector | `test/collector`: the reference two-tier Collector (`examples/collector`) in the Collector image, two gateways and two aggregators: per-stream routing, totals across device clocks, allowlists (`pnpm test-collector`, CI job `collector`); `examples/collector/test` keeps the allowlists equal to the registry |
| Integrated | `test/stack`: the example shell in three engines against Keycloak, Envoy with the real IAM services, the distribution on floci and the two-tier Collector (`docker-compose.yml`); nightly in CI (`stack-nightly.yml`); findings in `docs/e2e/integrated-deployment-report.md` |
| React floor | The typecheck, unit suite, build and example checks on React 19.0.0 (CI job `react-floor`) |
| ESLint floor | The eslint-plugin's tests on ESLint 9, the lower major of its peer range (CI job `eslint-9`, `.github/scripts/eslint-9.sh`) |
| Smoke | `test/smoke`: the example builds served with the CloudFront headers and rewrite, or a deployed shell (`SMOKE_BASE_URL`) |
| Contract | Shared fixtures from platform-interop-tests (headers, identity, redaction, problem bodies) and the PUB-1 / P-35 cases, run by the SDK and by the example shell's ports |
| Fake backends | A Keycloak fake at the HTTP level (PKCE, rotation, reuse revokes the session); `mockApi` / `mockProblem` |
| Parity | `metrics:parity`: SDK registration checks vs gincommon `metricslint`, inventory passes `-strict` |
| Cross-language | interop-tests pair 4: the SDK's `/http` + `/problem` against the live Go and Python servers |
| Build output | `examples:check` (CSP, container global, no SDK in remotes); real webpack, Rspack and Rsbuild builds in the preset's tests, including webpack and Rspack shells and remotes mixed; the browser SRI suite runs on a webpack-built and an Rspack-built remote |
| Package | Smoke tests of the packed tarballs in an empty consumer project |

## Consumer conformance checklist

A shell or remote conforms when:

- It imports SDK subpaths only (`@bcbp-solutions-fzc-llc/eslint-plugin` `configs.recommended` passes).
- It builds with `platformWebpackConfig({ role, name, exposes })`, `platformRspackConfig(…)` or Rsbuild's `pluginPlatform(…)`, and adds no other shared config for React, OTel or the SDK (with Rsbuild: no `moduleFederation` option).
- **Shell:**
  - it runs the bootstrap in order, implements `WorkspaceResolver` and `SessionContextSource` as ports, and passes the PUB-1/P-35 contract cases;
  - it shows its own signed-out, session-ended and wrong-workspace screens, and never signs in automatically after a logout;
  - it is built once for every environment: it loads `runtime.json` before `initializeCore` and takes `environment` from it, and each environment's deployed `runtime.json` sets its own `environment` (the deploy pipeline checks it matches the target).
- **Remote:**
  - it wraps its root in `MFEErrorBoundary` (or is loaded through `RemoteBoundary`);
  - it uses `useApi` / `useApiClient` with route templates;
  - it registers its page templates (`useRouteTemplate`) and keeps drafts in `storage(appId, { area: 'session' })` from `useBeforeAuthRedirect`.
- Its own metrics use `getServiceMeter()` (Tier 3), and its CI runs `metricslint check` on `renderMetricInventory()`.
- It serves the CloudFront response headers of `examples/cloudfront` (CSP with the three Trusted Types policies, and `form-action` allowing the IdP origin).
- Its SDK and preset are the same version (`SdkVersionPlugin`); the shell and its remotes upgrade together across a breaking alpha.

## Schema lifecycle

Two kinds of schema. Backend-shaped data (registry vocabulary, log fields, redaction rules, problem types, header names, gateway deny codes, the PUB-1 and P-35 cases) is **generated** from pinned commits of the platform and IAM repositories (`contracts/sources.json`) and never edited by hand. The browser-facing schemas, `runtime.json`, the manifest and the public API, are owned here and change under versioning rules.

> Source: [`docs/architecture/mermaid/schema-lifecycle.mmd`](docs/architecture/mermaid/schema-lifecycle.mmd)

```mermaid
flowchart TD
    subgraph backend["Backend sources (pinned commits, contracts/sources.json)"]
        g["platform: gincommon, fastapicommon, events, pgcommon, interop-tests<br/>registry vocab, log fields, redaction, problem types, headers, metric registry"]
        i["IAM: authz-enrichment, org-membership<br/>gateway headers and deny codes, PUB-1 / P-35 cases"]
    end
    g & i -->|"pnpm contracts:sync"| gen["packages/frontend-sdk/contracts/*.json<br/>src/internal/generated/*.ts (never edited)"]
    gen -->|"contracts:check in CI"| ci1["Drift fails Validate / Contracts"]

    subgraph runtime["Browser-facing schemas the SDK owns"]
        rj["runtime.json: RuntimeConfigSchema<br/>strict: unknown keys fail"]
        mf["remotes/manifest.json: entry, version, ownerDomain, integrity"]
        apir["Public API: api/*.api.md (api-extractor, LF)"]
    end

    rj --> add["A new key: optional, no default that changes behaviour → minor changeset<br/>deploy order: pages run the new SDK first, then the files set the key<br/>(an older SDK refuses the unknown key)"]
    rj --> brk["A stricter or removed key → breaking: alpha bumps N; from 1.0.0 a major"]
    apir --> ver["api:check in CI · changeset + CHANGELOG for every report diff"]
    mf --> mfr["Invalid entries dropped with an error log; integrity required outside local, dev, test"]
```

| Schema | Owner | Changes by | Check |
|---|---|---|---|
| `contracts/*.json`, `src/internal/generated/*` | Backend repos (pinned) | `pnpm contracts:sync` after moving a pin | `contracts:check` (Validate / Contracts) |
| `runtime.json` (`RuntimeConfigSchema`) | This repo | A new optional key is minor; a stricter or removed key is breaking | Unit tests; API report |
| `remotes/manifest.json` | This repo | As above | `loadManifest` drops an invalid entry with an error log |
| Public API (`api/*.api.md`) | This repo | Changeset + CHANGELOG for every diff | `api:check` |

A new `runtime.json` key reaches pages in two steps: the pages upgrade to the SDK that knows it, then the deployed files set it. An older SDK refuses the unknown key and stops at the "unavailable" page.

---

## Threat model

| Threat | Mitigation |
|---|---|
| XSS steals tokens | Tokens only in a closure (never storage); strict CSP (`script-src 'self'`, `require-trusted-types-for 'script'`); DOMPurify for any HTML |
| A forged identity header from the browser | Never sent by the SDK, lint-checked, and stripped by Envoy regardless |
| An authorization code reused or injected | PKCE S256; one-time pending record per `state`; RFC 9207 `iss` check; ID-token `nonce`/`aud`/`azp`/`iss`/time checks |
| A code from one realm exchanged at another | The `iss` check against the record's realm before any exchange |
| An open redirect after login | `returnUrl` must pass `isSafeRedirect` (same origin; no protocol-relative, backslash or control-character tricks) |
| Tenant data seen by another tenant on a shared browser | `/storage` namespaced by realm or `trial:<tenant_id>` under the SDK's key prefix; `clearAllAppStorage` on logout and switch, with the UI permissions, flags and read-only mark; other tabs follow, expired and loading ones included; `anon` writes are no-ops |
| A malicious remote entry | Manifest entries limited to same origin or exact allowed origins, checked again before the script; SRI on the entry when given and on every lazy JS and CSS chunk; kill switch |
| Telemetry leaking secrets or PII | Redaction (sensitive keys, JWT/Bearer, URL queries in every string and span attribute), bounded stack and attribute size, consent (withdrawing it drops what is queued); the Collector gateway drops per-browser attributes |
| The ID token (name, email) in the browser history or an access log | Global sign-out POSTs it in a form body, never a URL query |
| Forged telemetry flooding the metrics backend (`/otel` is public) | The gateway allowlists metric names, label keys (Tier 3: snake_case, not prohibited, at most 8) and label values from the registry, cuts values at 128 characters, records a `page_route` over 64 as `unknown` and keeps no resource attribute on metrics; Mimir per-tenant series limits; WAF rate rules on `/otel` (`examples/cloudfront`) |
| A reload loop after a bad deploy or failed restore | Reload once per version; one `prompt=none` per tab |

## Developer tools

| Command | Purpose |
|---|---|
| `pnpm verify` | Everything CI's quality and test gates run, locally |
| `pnpm contracts:sync` / `contracts:check` | Regenerate / check `contracts/` from the pinned sources |
| `pnpm docs:sync` / `docs:check` | Regenerate / check the generated docs and the diagram blocks here |
| `pnpm api` / `api:check` | api-extractor reports per subpath |
| `pnpm exports:sync` | Exports map and the SDK facts in the tooling packages |
| `pnpm metrics:parity` | SDK checks vs gincommon `metricslint` |
| `pnpm examples:check` | CSP and sharing checks of the example builds |
| `pnpm changeset` | Record a change to a published package |

## Implementation decisions

Judgment calls made while implementing, where the design doc was silent or the integrated run showed it was wrong. Each is also recorded at its point in the code and in the CHANGELOG.

1. **The environment comes from `runtime.json`.** A build-time environment meant one shell build per environment. The host page loads the config first and passes `cfg.environment` to `initializeCore`. Only `loadRuntimeConfig`, which stores nothing, trusts the file's own environment; `setRuntimeConfig` before `initializeCore` does not, and `initializeCore` refuses another environment than a config already set. Otherwise a config could vouch for itself.
2. **A remote's standalone page is its own host page.** With no shell, it may call `initializeCore`, `loadRuntimeConfig` and `setRuntimeConfig`. Code that also runs inside a shell only reads (`tryGetConfig`). `auth.signInUrl` tells such a page where to send a signed-out user.
3. **Sign-out is global and a form POST.** A local sign-out left the Keycloak session alive, so the next person on a shared device was signed in as the previous one (integrated report Issue 10). A POST keeps the ID token, which carries the user's name and email, out of URLs and logs; it needs the IdP origin in CSP `form-action`.
4. **A refresh is retried only on 429, or 503 with `Retry-After`.** Those say the request was not processed. Retrying after a 502, a 504 or a bare 503 could reuse a refresh token Keycloak had already rotated, which revokes the whole session.
5. **The remote container global is `__platform_mfe_<name>`.** A bare name could be shadowed by an element id or a browser global.
6. **Pre-release SDK copies share the runtime only at the same version.** `alpha.N` may break `alpha.N-1`; sharing across them would mix incompatible state.
7. **`warn` and `error` reach the console while logging is not running.** A standalone page has no collector; before, its warnings were lost in test, staging and prod.
8. **`formatDate('YYYY-MM-DD')` formats in UTC.** A calendar date is a day, not an instant; `new Date('2026-10-25')` showed Oct 24 west of UTC.
9. **API reports use LF.** api-extractor's CRLF default left the reports with mixed endings that flipped on regeneration.

---

## Documentation assets

Architecture diagrams live as standalone Mermaid files under `docs/architecture/mermaid/` and are embedded into this document verbatim, each under a `> Source:` link back to its `.mmd` file, so a diagram only has to be correct in one place. `pnpm docs:sync` writes the blocks; `pnpm docs:check` fails CI when they drift.

> Source: [`docs/architecture/mermaid/documentation-assets.mmd`](docs/architecture/mermaid/documentation-assets.mmd)

```mermaid
graph LR
    subgraph sources["Documentation sources"]
        design["docs/design/frontend-sdk-design.md<br/>decision record (HLD): what and why"]
        mmd["docs/architecture/mermaid/<br/>.mmd source diagrams (package-dependencies generated)"]
        arch["ARCHITECTURE.md<br/>embeds every .mmd verbatim + prose"]
        lld["docs/lld/platform-reactcommon-lld.md<br/>implementation as built"]
        obs["docs/observability/<br/>standard · metric-registry.md (generated) · migration · runbooks"]
        pd["docs/problem-details/<br/>RFC 9457 in the SDK · registry.md (generated)"]
        readme["README.md · package READMEs · contracts/README.md"]
        api["packages/frontend-sdk/api/*.api.md<br/>(api-extractor, per subpath)"]
        cs["CHANGELOG.md (one history, Keep a Changelog)"]
    end

    subgraph checks["Kept in sync by"]
        dsync["pnpm docs:sync / docs:check<br/>(Validate / Quality)"]
        apic["pnpm api:check"]
        csync["pnpm contracts:sync"]
    end

    subgraph rendered["Rendered / consumed by"]
        gh["GitHub — Markdown + Mermaid"]
        ide["IDE Mermaid preview · mermaid.live"]
        rel["GitHub Release notes"]
    end

    csync --> obs
    csync --> pd
    mmd --> dsync --> arch
    obs --> dsync
    pd --> dsync
    api --> apic
    arch --> gh
    design --> gh
    lld --> gh
    readme --> gh
    mmd --> ide
    cs --> rel
```

| Document | Description |
|---|---|
| [README.md](README.md) | Workspace layout, commands, CI and releases |
| [`docs/design/frontend-sdk-design.md`](docs/design/frontend-sdk-design.md) | The design and its decisions (HLD): public API per subpath, contracts, backend changes it relies on |
| [`docs/lld/platform-reactcommon-lld.md`](docs/lld/platform-reactcommon-lld.md) | Low-level design: the implementation as built, limits, algorithms, state, failure handling |
| [`docs/architecture/README.md`](docs/architecture/README.md) | Index of the `.mmd` diagrams embedded above |
| [`docs/observability/README.md`](docs/observability/README.md) | The observability standard as the SDK implements it |
| [`docs/observability/metric-registry.md`](docs/observability/metric-registry.md) | Generated: the registry the SDK validates against |
| [`docs/observability/migration.md`](docs/observability/migration.md) | Moving an existing app onto the SDK |
| [`docs/observability/runbooks.md`](docs/observability/runbooks.md) | Runbooks for frontend symptoms and the proposed web alerts |
| [`docs/problem-details/README.md`](docs/problem-details/README.md) | RFC 9457 in the browser |
| [`docs/problem-details/registry.md`](docs/problem-details/registry.md) | Generated: platform problem types and gateway deny codes |
| [`packages/frontend-sdk/api/`](packages/frontend-sdk/api/) | Public API per subpath (api-extractor) |
| [`packages/frontend-sdk/contracts/README.md`](packages/frontend-sdk/contracts/README.md) | What each generated contract is and where it comes from |
| [`examples/cloudfront/README.md`](examples/cloudfront/README.md) | CloudFront behaviors, deploy order, CSP |

Render a diagram locally in a Mermaid-aware IDE (VS Code + Mermaid Preview, IntelliJ + Mermaid plugin), or paste it into [mermaid.live](https://mermaid.live).
