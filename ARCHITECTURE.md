# Architecture

This document describes the internal structure, dependency rules, and runtime flows of `platform-reactcommon`.

`platform-reactcommon` is a **private pnpm monorepo** of three packages, released together under one version (changesets `fixed`, `1.0.0-alpha.N` until the first environment):

- **`@platform/frontend-sdk`**: the shared TypeScript SDK every React micro-frontend (shell and remotes) uses. Its 17 subpaths are `/core` … `/react`, `/testing`, and there is no root barrel. It is **contract-compatible with platform-gincommon and platform-fastapicommon**:
  - the same identity vocabulary and metric registry (Enterprise Platform Observability Standard);
  - RFC 9457 Problem Details;
  - the header names, the redaction rules, and the Go trace sampler.

  It is the browser's side of IAM: Keycloak sign-in (Authorization Code + PKCE, tokens in memory only), workspace (realm) choice, session restore, idle timeout, step-up.
- **`@platform/webpack-preset`**: the Module Federation shared map (strict singletons, the SDK provided only by the shell) and CSP-safe output (Trusted Types, no `eval`, hidden source maps).
- **`@platform/eslint-plugin`**: seven rules that enforce in consumer code what the design requires:
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
        preset["@platform/webpack-preset<br/>platformShared · sharedFor · containerName<br/>platformWebpackConfig (Trusted Types, no eval, hidden maps)"]
        eslint["@platform/eslint-plugin<br/>7 rules + configs.recommended"]
    end

    subgraph sdk["@platform/frontend-sdk  —  17 subpaths, no root barrel ('.' throws)"]
        L5["L5  /react (hooks, boundaries, PlatformProvider)  ·  /testing (dev only)"]
        L4["L4  /auth (Keycloak OIDC, PKCE)  ·  /mfe (manifest, loadRemote, app updates)  ·  /nav"]
        L3["L3  /http (ApiClient)  ·  /flags  ·  /i18n"]
        L2["L2  /tracing  ·  /logging  ·  /metrics  (the only OpenTelemetry users)"]
        L1["L1  /config (runtime.json, zod)  ·  /security (DOMPurify, Trusted Types)  ·  /storage"]
        L0["L0  /core (identity, consent, session id, sanitize)  ·  /problem (RFC 9457)  ·  /authz (pure)"]
        internal["src/internal  —  PlatformRuntime registry · runtime events · instrument port<br/>batcher · online · redirect · locale · generated contracts (not exported)"]
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

The `PlatformRuntime` lives on `globalThis[Symbol.for('@platform/frontend-sdk')]`, so every copy of the SDK on a page finds the same object. That's how a remote sees the shell's identity, consent, session, flags, permissions and token source, even though the remote never imports the shell. Change notification goes through the runtime too. `/i18n`, `/flags`, `/authz` and `/http` emit the topics `i18n`, `flags`, `authz` and `read-only`, and `/react` re-renders on them.

A second copy is a remote that bundled the SDK instead of taking it from the shell. It logs one error. If the major version matches, it binds to the existing runtime; otherwise it keeps its own.

> Source: [`docs/architecture/mermaid/runtime-registry.mmd`](docs/architecture/mermaid/runtime-registry.mmd)

```mermaid
graph LR
    subgraph rt["PlatformRuntime  —  globalThis[Symbol.for('@platform/frontend-sdk')]"]
        ident["identity · consent · memorySessionId"]
        cfg["config (deep-frozen runtime.json)"]
        tel["tracing · logging · metrics · instruments (port)"]
        page["pageRoute · routeTemplates"]
        authf["identityProvider · tokenSource · storageNamespace"]
        az["authorizer · authzSubject · flagProvider"]
        mf["manifest · remotes (mfe → ownerDomain) · appUpdate"]
        ui["i18n · navigator · trustedTypesPolicy · readOnlyDenied"]
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

    dup["second SDK copy<br/>(a remote that bundled it)"] -.->|"same major: binds to the existing runtime<br/>other major: own runtime + one error log"| rt
```

---

## Shell bootstrap

The shell (never a remote) runs the bootstrap once (design doc §C2). Steps 2–3 are fatal: they fall back to a static page, and no SDK telemetry is possible yet. Step 5 is never fatal. Step 7 is fatal only for routes that need auth. If step 9 fails, every remote slot shows its fallback. `examples/shell/src/bootstrap.tsx` is the §C4 code verbatim.

> Source: [`docs/architecture/mermaid/shell-bootstrap.mmd`](docs/architecture/mermaid/shell-bootstrap.mmd)

```mermaid
flowchart TD
    html["index.html (external scripts only)"] --> idx["index.ts: import('./bootstrap')<br/>(the async boundary Module Federation needs)"]
    idx --> tt["1. installTrustedTypesPolicy()  —  /security"]
    tt --> core["2. initializeCore({ serviceName, domain: 'portal', environment, buildVersion })<br/>build-time constants, validated against the registry vocabulary"]
    core -->|throws| fatal["static 'unavailable' page, console only"]
    core --> cfg["3. loadRuntimeConfig() → GET /config/runtime.json (no-cache) → zod (strict) → freeze<br/>setRuntimeConfig(cfg)"]
    cfg -->|fails| fatal
    cfg --> consent["4. setConsentProvider(cmp)  —  before any export"]
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
    ctx --> manifest["9. loadManifest() → GET /remotes/manifest.json · startVersionPolling()<br/>(failure: every remote slot shows its fallback)"]
    manifest --> render["10. createRoot().render(&lt;PlatformProvider shell&gt;&lt;App/&gt;)<br/>routes render &lt;RemoteBoundary&gt; lazily"]
    render --> expired["idp.subscribe: 'expired' → session-ended dialog → signInAgain()"]
```

A remote run on its own skips all of this. Every API then returns a no-op or an anonymous default (`denyAll`, empty flags, the console logger), and remotes read the config only through `tryGetConfig()`.

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
    loop attempts (GET/PUT/DELETE, or retry.unsafe): 1 + 2 retries by default
        X->>A: attempt(token)
        Note over A: offline → NetworkError(offline) at once<br/>drop FORBIDDEN identity headers (dev: throw)<br/>x-request-id · x-session-id: same origin or allowlist<br/>traceparent: same origin or allowlist<br/>Authorization: same origin only<br/>deadline 35 s (api.timeoutMs)
        A->>F: fetch(url, headers, signal = caller ∪ timeout)
        F-->>A: Response / error
        A-->>X: Response, or TimeoutError / NetworkError / AbortedError
        alt 401 and not yet refreshed
            X->>T: newer token? else refresh() (single-flight per tab)
            T-->>X: new token → retry once (not counted as a retry)<br/>none → onUnauthorized()
        else 429 / 502 / 503 / 504 or transient error, retryable
            X->>X: sleep Retry-After (≤ 30 s) or full-jitter backoff min(5 s, 250 ms·2ⁿ)
        end
    end
    alt 2xx
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
        idle_timer --> refreshing: timer at exp − 60 s ± 10 s · getAccessToken near expiry · 401
        refreshing --> idle_timer: 200 → rotate tokens (never reuse a replaced refresh token)
        refreshing --> waiting_online: offline before sending → keep the token
        waiting_online --> refreshing: online event
    }

    authenticated --> expired_server: invalid_grant before refresh_expires_in<br/>(serverEnded: true, e.g. trial → paid)
    authenticated --> expired_natural: invalid_grant / refresh token past its expiry<br/>(serverEnded: false)
    authenticated --> expired_idle: no activity in any tab for idleTimeoutMs<br/>(idle: true; session id rotated)
    authenticated --> restoring: sent but outcome unknown (timeout, network after send,<br/>non-invalid_grant error, bad ID token) → drop the lineage
    restoring --> [*]: wait online → beforeRedirect('restore') → prompt=none redirect
    authenticated --> anonymous: logout (this tab or a 'logout' broadcast)
    authenticated --> expired_natural: 'workspace-switched' broadcast from another tab

    expired_server --> [*]: shell dialog → signInAgain(forceResolve: true)
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

The shell loads `/remotes/manifest.json` once. Routes render `<RemoteBoundary remote module>`, which lazily calls `loadRemote` inside `Suspense` and an `MFEErrorBoundary`. Container globals follow one rule shared by `loadRemote` and `@platform/webpack-preset`'s `containerName`: the remote's name, with `-` replaced by `_`.

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

    SH->>M: GET /remotes/manifest.json (no-cache)
    Note over M: per remote: name ^[a-z][a-z0-9_-]{0,62}$ (not 'shell'),<br/>entry same origin or remotes.allowedOrigins, version, ownerDomain ∈ registry,<br/>integrity sha256/384/512 — an invalid remote is dropped with an error log
    M-->>SH: manifest → runtime.manifest + remotes (mfe → ownerDomain)
    RB->>L: lazy(loadRemote(remote, './Module')) inside Suspense
    alt killSwitch lists it, or flag remote.{name}.disabled
        L-->>RB: RemoteDisabledError (failure: disabled)
    else
        loop attempt ≤ 1 + retries (default 2), timeout per attempt (default 10 s)
            L->>L: entry still allowed? (checked again before the script)
            L->>DOM: {script src} via Trusted Types createScriptURL · integrity + crossorigin when SRI is set
            DOM-->>C: remoteEntry.js defines window[name with '-' → '_']
            L->>C: init(share scope) — strictVersion clash → incompatible (no retry)
            L->>C: get('./Module') → factory()
        end
        L-->>RB: module (default export = component)
    end
    Note over L: span "remote load", platform_web_remote_load_* through the instrument port,<br/>one container per remote per page (a failed load is forgotten so it can retry)
    RB->>EB: any failure → MFEErrorBoundary with mfe = remote
    EB->>EB: chunk-load error → reload once per version (sessionStorage guard)<br/>else log + platform_web_errors_total{source=boundary}, fallback with Try again (new lazy)
    SH->>SH: startVersionPolling: /version.json every 5 min and on visible → useAppUpdate().available
```

Sharing: the shell provides React, react-dom, `@opentelemetry/api` (`~1.10.0`) and every SDK subpath except `/testing` as strict singletons (`platformShared`). Remotes take the SDK with `import: false`, so they never bundle it. A remote built against an incompatible SDK major fails share negotiation, which shows as a `RemoteLoadError` in its own boundary, not as a broken shell.

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

## Telemetry pipeline

Logs, traces and metrics leave the page over OTLP/HTTP to the same-origin `/otel` path. CloudFront forwards it to the OTel Collector; there is no Faro SDK and no second pipeline. Everything is redacted with the same rules as gincommon's log sanitizer, gated on consent, and queued with fixed bounds, so a slow or unreachable collector costs a fixed amount of memory. See [docs/observability](docs/observability/README.md).

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
        checks["registration checks = metricslint rules<br/>Tier 3 label values ≤ 100 → __other__"]
    end

    subgraph queues["Bounded queues (drop oldest, ≤ 2 sends in flight)"]
        lq["logs: batch 50 · 5 s · queue 1000<br/>page hide → sendBeacon (≤ 60 KiB)"]
        tq["spans: batch 512 · 5 s · queue 2048<br/>page hide → flush"]
        mq["metrics: delta temporality · every 60 s"]
    end

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
    otel --> coll["Collector: deltatocumulative · label allowlists ·<br/>drops per-browser resource attributes"]
```

Identity on every signal is the **page** identity (`initializeCore`: `domain` / `service` / `environment`, e.g. `portal` / `web-app`). Remotes are told apart by the `mfe` attribute or label, never by a second `domain`. The one exception is a remote's own Tier 2/3 metrics, which carry its manifest `ownerDomain` (design doc §D1).

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
        vt["Validate / Test<br/>all tests · coverage ≥ 94% of packages/*/src"]
        vq["Validate / Quality<br/>hygiene · action pins · lockfile · exports · lint · types ·<br/>build · API reports · depcruise · examples CSP · docs · audit"]
        vc["Validate / Contracts<br/>contracts:check · metrics:parity"]
        pk["Package tarballs<br/>build + pnpm pack ×3"]
        tv["Trivy scan<br/>fs: deps · secrets · config → SARIF + SBOM"]
        sm["Smoke tests<br/>tarballs in an empty consumer"]
        io["Cross-language compatibility<br/>interop.yml (pair 4 at this ref)"]
        ps["PR summary comment"]
        vt --> tv
        pk --> tv
        vt --> sm
        pk --> sm
        vt --> io
        vt & vq & vc & pk & tv & sm & io --> ps
    end

    subgraph rel["release.yml  —  tag vX.Y.Z (one version, changesets fixed)"]
        vf["verify: tag on main · versions = tag · CHANGELOG sections"]
        gates["same gates as ci.yml, at the tag"]
        pub["publish: GitHub Release<br/>tarballs · SBOM · checksums.txt + Cosign bundle"]
        vf --> gates --> pub
    end

    cs["changeset-check.yml<br/>published package changed → .changeset/*.md"]
    rpr["release PR: pnpm changeset version"] --> tag["tag the merge commit"] --> vf
```

---

## Concurrency model

The browser is single-threaded; concurrency here means overlapping promises and several tabs.

| Concern | Mechanism |
|---|---|
| Concurrent identical GETs | One in-flight call per key (URL + token + headers); the shared fetch is aborted only when every subscriber has aborted |
| Token refresh | One in-flight `refresh()` per tab; the timer, `/http`'s 401 path and direct callers await the same promise; a new refresh starts only after it settles, with the token it returned |
| Tabs | One refresh lineage per tab, never shared; `BroadcastChannel('platform-auth')` carries only `logout` and `workspace-switched`; idle activity and the signed-out mark are shared through localStorage |
| Remote containers | One container per remote per page; concurrent `loadRemote` calls share it; a failed load is forgotten so a retry starts fresh |
| i18n catalogs | One in-flight load per namespace and locale |
| Telemetry export | At most two sends in flight per signal; beyond the queue bound the oldest items are dropped and counted |
| Runtime listeners | Snapshot before notify; a throwing listener never stops the others |

## Failure domains

| Failure | Effect | What still works |
|---|---|---|
| `runtime.json` unreachable or invalid | Fatal at bootstrap (static page) | — |
| `/otel` down or slow | Queues fill, oldest dropped, failures counted | Everything else; no retries into a struggling page |
| Keycloak unreachable during refresh | Ambiguous outcome → lineage dropped → silent restore after `online` | Calls fail with 401/`NetworkError` meanwhile; no sign-out |
| Session ended by the server (`invalid_grant`) | `expired { serverEnded: true }` → dialog → re-resolve the workspace | Drafts saved by `beforeRedirect` listeners |
| P-35 session context fails | Deny-all permissions, platform flags only, workspace not cached | Signed-in shell |
| Manifest fails | Every remote slot shows its fallback | Shell routes |
| A remote fails to load or render | That remote's boundary fallback with `traceId` / Try again | Shell and other remotes |
| Old chunks gone after a deploy | One reload per version (sessionStorage guard) | — |
| Consent not granted | Only `error` logs and essential `warn` logs leave the page | All functionality |
| localStorage / sessionStorage blocked | Session id per page; storage kept in memory; **sign-in impossible** (no pending-login record), stated, never silent | Anonymous pages |

## Key invariants

| Invariant | Where enforced |
|---|---|
| Tokens are never in storage, a global, a log or the channel | `/auth` closure; `/storage` refuses token-like keys; redaction of JWT/Bearer patterns; auth tests scan storage |
| The browser never sends identity headers | `/http` drops `FORBIDDEN_REQUEST_HEADERS` (generated from gincommon + AuthZ Enrichment); `@platform/eslint-plugin` `no-identity-headers`; interop pair 4 |
| The access token goes to the page's own origin only | `/http` `isSameOrigin` check before `Authorization` |
| A replaced refresh token is never sent | single-flight `refresh()`; ambiguous failures drop the lineage instead of retrying |
| Metric `route` labels are templates, never raw URLs | `ApiClient` takes templates; `api-route-template` lint rule |
| Metric names, labels and units follow the registry | `/metrics` registration checks = gincommon `metricslint` rules (`metrics:parity` in CI) |
| One page identity; remotes never set `domain` | `/core` `initializeCore` once; `IdentityMismatchError` on a different second call |
| Nothing leaves the page without consent (except errors) | consent gates in the log, span and metric pipelines |
| No `eval`, no inline script (CSP `script-src 'self'`) | preset (no eval devtools, `environment.globalThis`); Zod jitless; `examples:check`; `no-eval` lint |
| Untrusted HTML only through DOMPurify + Trusted Types | `/security` `sanitizeHtml`; `no-unsafe-html` lint |
| A remote never bundles the SDK | `sharedFor('remote')` `import: false`; `examples:check` |
| Contracts are generated, never edited | `contracts:check`, `docs:check` in CI |

## Release and distribution

All three packages share one version (`fixed`). The release flow:
1. A release PR runs `pnpm changeset version`.
2. The merge commit is tagged `vX.Y.Z`.
3. `release.yml` verifies the tag and versions, reruns every gate at the tag, and publishes a **GitHub Release** with the tarballs, a CycloneDX SBOM and Cosign-signed checksums. There's no npm registry yet.

During the alpha, versions are `1.0.0-alpha.N` and remotes share the SDK under `^1.0.0-0`. `1.0.0` is cut with the first environment, and SemVer is strict from then on (design doc §C3 "Versioning").

## Testing strategy

| Layer | How |
|---|---|
| Unit | Vitest per subpath (`packages/frontend-sdk/test/<subpath>`). Node by default; `happy-dom` for React; `jsdom` for DOMPurify. Coverage gate ≥ 94 % statements of `packages/*/src` |
| Contract | Shared fixtures from platform-interop-tests (headers, identity, redaction, problem bodies) and the PUB-1 / P-35 cases, run by the SDK and by the example shell's ports |
| Fake backends | A Keycloak fake at the HTTP level (PKCE, rotation, reuse revokes the session); `mockApi` / `mockProblem` |
| Parity | `metrics:parity`: SDK registration checks vs gincommon `metricslint`, inventory passes `-strict` |
| Cross-language | interop-tests pair 4: the SDK's `/http` + `/problem` against the live Go and Python servers |
| Build output | `examples:check` (CSP, container global, no SDK in remotes); real webpack builds in the preset's tests |
| Package | Smoke tests of the packed tarballs in an empty consumer project |

## Consumer conformance checklist

A shell or remote conforms when:

- It imports SDK subpaths only (`@platform/eslint-plugin` `configs.recommended` passes).
- It builds with `platformWebpackConfig({ role, name, exposes })` and adds no other shared config for React, OTel or the SDK.
- **Shell:**
  - it runs the bootstrap in order, implements `WorkspaceResolver` and `SessionContextSource` as ports, and passes the PUB-1/P-35 contract cases;
  - it shows its own signed-out, session-ended and wrong-workspace screens, and never signs in automatically after a logout.
- **Remote:**
  - it wraps its root in `MFEErrorBoundary` (or is loaded through `RemoteBoundary`);
  - it uses `useApi` / `useApiClient` with route templates;
  - it registers its page templates (`useRouteTemplate`) and keeps drafts in `storage(appId, { area: 'session' })` from `useBeforeAuthRedirect`.
- Its own metrics use `getServiceMeter()` (Tier 3), and its CI runs `metricslint check` on `renderMetricInventory()`.
- It serves the CloudFront response headers of `examples/cloudfront` (CSP with the three Trusted Types policies).

## Threat model

| Threat | Mitigation |
|---|---|
| XSS steals tokens | Tokens only in a closure (never storage); strict CSP (`script-src 'self'`, `require-trusted-types-for 'script'`); DOMPurify for any HTML |
| A forged identity header from the browser | Never sent by the SDK, lint-checked, and stripped by Envoy regardless |
| An authorization code reused or injected | PKCE S256; one-time pending record per `state`; RFC 9207 `iss` check; ID-token `nonce`/`aud`/`azp`/`iss`/time checks |
| A code from one realm exchanged at another | The `iss` check against the record's realm before any exchange |
| An open redirect after login | `returnUrl` must pass `isSafeRedirect` (same origin; no protocol-relative, backslash or control-character tricks) |
| Tenant data seen by another tenant on a shared browser | `/storage` namespaced by realm or `trial:<tenant_id>`; `clearAllAppStorage` on logout and switch; `anon` writes are no-ops |
| A malicious remote entry | Manifest entries limited to same origin or exact allowed origins, checked again before the script; SRI when given; kill switch |
| Telemetry leaking secrets or PII | Redaction (sensitive keys, JWT/Bearer, URL query), bounded stack size, consent; the Collector drops per-browser attributes |
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
        cs["CHANGELOG.md per package (changesets)"]
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
