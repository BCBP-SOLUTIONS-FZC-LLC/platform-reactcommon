# Changelog

All notable changes to this project are documented in this file. The three packages (`@bcbp-solutions-fzc-llc/frontend-sdk`, `@bcbp-solutions-fzc-llc/webpack-preset`, `@bcbp-solutions-fzc-llc/eslint-plugin`) share one version and this one history.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html); see [VERSIONING.md](VERSIONING.md) (pre-release `1.0.0-alpha.N` until the first environment).

## [Unreleased]

### Added

- `/auth`: `IdentityProvider.dispose()` (optional) stops a provider without signing out: closes the cross-tab channel, clears timers and listeners, forgets the tokens. For hot module replacement and tests.
- `@bcbp-solutions-fzc-llc/webpack-preset`: `SdkVersionPlugin`, in every preset (webpack, `/rspack`, `/rsbuild`). A build fails when the SDK installed for the app is not the preset's own version: the preset's shared map and a remote's required range (`^<version>`) come from that SDK, so a mismatch declared one SDK and called another's exports. An app without the SDK installed is not checked.
- `/react`: `MFEErrorBoundary` takes `resetKeys`. The boundary clears its error when `mfe` or any reset key changes (say the route's id), as retry does; `RemoteBoundary` does so when `remote` or `module` changes. Before, a boundary that stayed mounted kept showing the previous tender's error after navigating to another.
- All three packages: `engines.node` `>=22` (the Node the build and the preset need), and a `README.md` in each tarball pointing to the repository's documentation. `publish:check` and `pack-packages.sh` refuse a tarball without either.

### Changed

- **Breaking:** `/metrics`: a Tier 3 metric (`getServiceMeter`) declares at most 8 labels besides `domain`, `service` and `environment` (`InvalidMetricError`, rule `label_vocabulary`). The reference gateway keeps that many per point; a point with more lost an arbitrary label there, merging series. **Upgrade:** split a metric with more labels, or drop the ones you do not query by; no opt-out.
- **Breaking:** `@bcbp-solutions-fzc-llc/eslint-plugin` `no-raw-storage` reports bare `localStorage` / `sessionStorage` when the project configures browser globals (`languageOptions.globals: globals.browser`, as nearly every browser project does); before, those references were resolved and passed. `no-unsafe-html` reports an unsanitized `parseFromString` of any type, XML included: under Trusted Types (`require-trusted-types-for 'script'`) every type needs TrustedHTML, and XML-parsed XHTML or SVG keeps its event handlers when adopted. **Opt-out:** none; use `storage()` and `sanitizeHtml`.
- **Breaking (deployment):** `/auth`'s global sign-out POSTs to the realm's end-session endpoint (a hidden form, removed once the page leaves) instead of navigating to it with the ID token in the query string, so the token (with the user's name and email) never lands in the browser history or an access log. **The shell's CSP `form-action` must allow the IdP origin**, or the browser blocks the POST and the SSO session stays alive (a `content security policy violation` warn is logged). `examples/cloudfront/csp.mjs` (`buildCsp({ idpOrigin })`), `response-headers-policy.json` and the design doc's header do. **Upgrade:** add the IdP origin to `form-action` before deploying the shell; there is no opt-out.
- **Breaking:** a remote's container global is `__platform_mfe_<name>` (`-` as `_`), not the bare name. Browsers expose every element `id` as a `window` property, and `loadRemote` skipped the entry script whenever the global existed, so a remote named like an element on the page (`<div id="dashboard">`, the example shell's `root`) or a browser global (`history`, `status`, `name`) failed as `incompatible`. The SDK's `loadRemote` and the preset's `containerName` change together, and `loadRemote` now also loads the entry when the global holds something other than a container. **Upgrade:** rebuild every remote with the new preset and deploy the shell with the new SDK at the same time (a remote built with an older preset defines the old global, which the new SDK does not read). There is no opt-out.
- **Breaking:** `/storage` keys are `@bcbp-solutions-fzc-llc/frontend-sdk:storage:<namespace>:<appId>:<key>`, the prefix the SDK's other keys use. `clearAllAppStorage()` (sign-out, workspace switch) removed every key shaped `<word>:<word>:…`, including keys other libraries wrote; it now removes only keys with this prefix. **Upgrade:** values saved under the old keys are not read; nothing is in production, so they are not migrated (a user sets the value again). There is no opt-out.
- **Breaking:** `@bcbp-solutions-fzc-llc/eslint-plugin` `no-unsafe-html` trusts, by default, only `sanitizeHtml` imported from `@bcbp-solutions-fzc-llc/frontend-sdk/security` (by name, as an alias, or as `security.sanitizeHtml` of a namespace import). Before, any function called `sanitizeHtml`, local or from another module, passed. **Opt-out:** list your own sanitizer in the `sanitizers` option, which trusts the names it lists (and replaces the default, as before).
- `/react`: `useBeforeAuthRedirect` also runs before the SDK reloads the page (a chunk-load error after a deploy, `useAppUpdate().reload`), so a draft survives those too.
- `/core`: the RUM session id lasts at most 24 hours; a browser that silent-restores day after day gets a new one.

### Fixed

- `/logging`, `/tracing`: URL stripping is linear (40 000 `/` characters took 1.5 s on the main thread) and runs after the 256-byte cut; it also strips queries after scheme-less hosts (`bucket.s3.amazonaws.com/k?X-Amz-Signature=…`) and relative paths, and leaves prose such as `/help?` alone. Span names are cleaned like attribute values.
- `/logging`: the ~8 KiB attribute cap counts serialised errors and keys, cuts long keys, and stops after one `[TRUNCATED]` marker (records of 853 KB and 433 KB got through).
- `/react`: a boundary whose `resetKeys` change in the same update that makes its child throw catches and logs the error once, not twice. `useApi` never returns the previous deps' data or error for new deps, not even for one render (a form could save tender 42's fields to tender 43); `reload()` still keeps the data. The default fallback takes focus. Global error capture is rate-limited (10 per signature and 60 per page a minute; the next line carries `suppressed`).
- `/auth`: while a refresh backs off, `getAccessToken` and a 401 join it and get its answer instead of failing at once; the retry must answer 5 s before the token expires. An expired or loading tab follows another tab's sign-out (anonymous, storage no longer the tenant's); a sign-in the loading tab was finishing is dropped. A step-up answer whose `auth_time` is older than `max_age` is reported (`step-up not performed by the identity provider`). Cached workspaces whose realm does not fit their slug are ignored.
- `/security`: `sanitizeHtml({ allowLinks: true })` removed `//evil` but kept `/\evil.example`, which browsers follow to another origin; links and images with a backslash, whitespace or control character are removed, and images and media (`src`, `poster`) only keep same-origin paths and `data:image/*` (as CSP `img-src 'self' data:` allows).
- `/http`: a 2xx body that is not the JSON it claims, or a redirect on a call that carries a token or correlation headers (no longer followed: they would go to the redirect's origin), is a synthetic 502 `ProblemError` instead of a raw `SyntaxError`; typed arrays and DataViews are sent as bytes (they were JSON-encoded), a `ReadableStream` body is refused (not replayable); `retry.attempts` is capped at 5.
- `/mfe`: a remote load's timeout covers the whole attempt (the entry, the share-scope `init` and the module's chunks), not only the entry script; `loadManifest` and the `/version.json` poll time out; `startVersionPolling` refuses an interval under 1 s. The container cache and the flag provider's subscription live on the runtime, so a second SDK copy of the major neither re-initialises containers nor leaks subscriptions.
- `/i18n`: a catalog that does not answer within 10 s counts as failed instead of holding `setLocale`; a failed catalog is retried (2 s, 4 s, 8 s) while its locale is shown; the Intl format caches are bounded.
- `/storage`: `clearAllAppStorage` also removes the unprefixed realm keys alpha.3 and earlier wrote, so they never outlive a sign-out on a shared device.
- `/react`: `useStepUp().needed` turns true when the MFA window lapses while the page stays open.
- `/auth`: a refresh the token endpoint refused without processing it (429, or 503 with `Retry-After`: Keycloak or its gateway shedding load) keeps the tokens and retries with backoff (2 s doubling to 30 s, with jitter, or `Retry-After`) while the access token stays valid; meanwhile `getAccessToken` and a 401 wait for the backoff instead of sending more. It restores the session (`prompt=none`) only when the token would expire first. Before, every tab dropped its tokens and redirected to the IdP at once. A 500, 502, 504 or bare 503 stays ambiguous (a gateway may answer it after Keycloak rotated the token, and resending the old one is refresh-token reuse) and restores as before. Logged as `token endpoint unavailable: retrying the refresh` (warn, essential).
- `/logging`: a record's attributes are capped at about 8 KiB (`[TRUNCATED]` past it); a record too big for the unload beacon on its own is skipped instead of cancelling the beacon for every record. Before, `logger.error('…', { ids: bigArray })` as the newest record meant nothing was sent on `pagehide`.
- `/logging`, `/tracing`: what is left after the hide or `pagehide` beacon goes through the OTLP exporter, which sends with `keepalive` while the browser allows; its estimated size now counts against the page's keepalive budget, so a later beacon is not refused by the browser (known browser bug 1, through the exporter).
- `/logging`, `/tracing`: withdrawing `telemetry` consent drops the spans and the info, debug and non-essential warning records already queued (counted in `droppedNoConsent`), before any send or beacon. Before, up to 2,048 spans and 1,000 records collected under consent were still sent.
- `/logging`, `/tracing`: URL query strings and fragments are removed from every logged string (message and attributes) and span attribute, not only from stacks, as LLD §7.2 states (an OIDC callback's `code` and `state`, a pre-signed URL's signature).
- Example shell: a production build without `PLATFORM_ENVIRONMENT` fails instead of building a `dev` shell; a development build still defaults to `dev`, and the repository's `pnpm build` passes `dev` when it is unset.
- Example shell: a session context (IAM P-35) that fails at boot with a network error, a timeout, 429 or 5xx is retried 3 times (after 1 s, 2 s, 4 s); on success the shell sets the authorization subject, the session flags and the workspace and re-renders. Before, one transient failure left the page deny-all until a reload. The shell's provider also reads the locale live, so `shell.locale` follows `setLocale`.
- Example CloudFront Function (`spa-rewrite.js`): a deep link whose last segment has a dot (`/users/john.doe`, `/tenders/RFQ-2026.01`) is rewritten to `/index.html`. Only a known static-asset extension (`.js`, `.css`, `.png`, `.woff2`, `.txt`, `.webmanifest`, …) skips the rewrite; before, any dot did and the link answered 403/404.
- Reference Collector gateway: label keys are bounded. A Tier 1 or Tier 2 metric keeps only the registry's and the Tier 1 proposal's keys; a Tier 3 metric keeps its own snake_case keys, never a prohibited one (`user_id`, `*_id`, …), and at most 8 besides `domain`, `service`, `environment`. `platform_web_*` names are only the proposal's. A `page_route` over 64 characters is recorded as `unknown`, and every signal keeps only the SDK's four resource attributes. Before, made-up names, keys and resource attributes passed, so anyone POSTing to `/otel` could create unbounded series in Mimir. `examples/collector/README.md` adds Mimir per-tenant series limits as the backstop.
- Example CloudFront README: a remote served from another origin sends CORS headers and `Cross-Origin-Resource-Policy: cross-origin` on all of its assets (scripts, styles, fonts, images), not only `.js`.
- `@bcbp-solutions-fzc-llc/webpack-preset`: `ChunkIntegrityPlugin` covers lazily loaded CSS. Each runtime chunk carries a second map, chunk id → sha384 of every lazily loaded CSS file, and the CSS loader sets `link.integrity` from it (`MISSING_INTEGRITY` for a chunk it lacks, so the load fails closed): mini-css-extract-plugin (`beforeTagInsert`) and native CSS (`experiments.css`) on webpack, `CssExtractRspackPlugin` and native CSS on Rspack and Rsbuild (`RuntimePlugin` `createLink`). A build with lazily loaded CSS whose loader sets no integrity (another loader, or mini-css-extract-plugin with `runtime: false`) fails. The build's HTML gets `integrity` + `crossorigin` on its `<link rel="stylesheet">`s as on its scripts. Before, a remote's CSS chunks loaded unchecked, though the README promised SRI on every lazily loaded chunk.
- `@bcbp-solutions-fzc-llc/eslint-plugin` `no-identity-headers`: also reports `h['x-user-id'] = v` (a computed assignment with a static name), `new Headers([['x-user-id', v]])` and `headers: [[…]]` (header pairs), ``h.set(`x-user-id`, v)`` (a template literal without expressions, as in `.append`), `init.headers = { … }` and `new globalThis.Headers(…)`. Before, each of these passed.
- `@bcbp-solutions-fzc-llc/eslint-plugin` `no-raw-storage`: follows aliases of the global object (`const w = window; w.localStorage`, a `let` never reassigned, `x as Window`), chains (`window.self.localStorage`) and destructuring (`const { localStorage } = window`). A local `window` (a parameter, say) is no longer taken for the global.
- `@bcbp-solutions-fzc-llc/eslint-plugin` `no-unsafe-html`: also covers `setHTMLUnsafe`, `Document.parseHTMLUnsafe`, `srcdoc` (assignment, `setAttribute('srcdoc', …)`, JSX `srcDoc`), `Range#createContextualFragment` and `DOMParser#parseFromString` of any type but `text/xml` / `application/xml`.
- `@bcbp-solutions-fzc-llc/eslint-plugin`: every rule's `meta.docs.url` is an absolute URL (LLD §13.2 on GitHub), not a repository-relative path editors could not open.
- `@bcbp-solutions-fzc-llc/webpack-preset`: the CSS integrity check failed valid builds whose CSS only loads at startup (`optimization.runtimeChunk: 'single'`, or mini-css-extract-plugin's "one CSS file" `cacheGroup`): it took every non-runtime chunk for a lazily loaded one. The CSS map now holds only chunks a runtime loads on demand; startup stylesheets are pinned by the HTML as before.
- `/config`: `loadRuntimeConfig` times out after 10 s (`timeoutMs`, combined with the caller's `signal`) with a `RuntimeConfigError`; a stalled `/config/runtime.json` left a blank page instead of the unavailable one.
- `/auth`: a sign-out (this tab's or another's) and a workspace switch also drop the UI authorization subject, the flag provider and the read-only mark, so a shell that does not unmount cannot show the previous user's permissions or flags.
- `/core`: a second SDK copy shares the page runtime only when its version is compatible: the same major, or for a pre-release the same version (`1.0.0-alpha.3` next to `alpha.4` each keep their own, as for two majors).
- `/testing`: `createTestPlatform`'s shell provides `signOut` (calls recorded in `signOuts`), so `useSignOut()` works in a remote's tests; a new platform stops the previous one (unload listeners, logging, tracing, identity provider) instead of leaving them across a test file.
- Reference Collector: metrics keep no resource attribute. `service.version` made old-build and new-build tabs two streams writing one Prometheus series after a deploy (read by `rate()` as counter resets), and `service.name` (the Prometheus `job` and `target_info`) let anyone POST new series. Traces and logs keep the SDK's four.
- Example shell: a sign-out during boot (another tab) no longer mounts the app for the signed-out user; the session-context retry's wait stops at once on an aborted signal and leaves no listener.
- Example remote: `EditTender` submits with `onSubmit` (React 19's `<form action>` reset the fields, erasing the user's edits next to a 422's errors), sends the `version` it read (a concurrent edit is a 409, now reachable), shows the saved tender after a save, and still hands a save with no answer (timeout, network) to its error boundary.
- `/tracing`: `shutdownTracing` leaves the OTel globals alone when tracing was started again while it flushed; a second `createTestPlatform` in a test file recorded no spans after an await.
- `/config`: `loadRuntimeConfig` refuses a `timeoutMs` outside 1 to 2 147 483 647 (setTimeout would take it as about 1 ms).


## [1.0.0-alpha.3] - 2026-11-04

### Fixed

- `/testing`: `createTestPlatform()` scopes `storage()` to its signed-in workspace, as a real sign-in does; before, every `set()` was dropped ("no workspace is signed in") and `get()` returned `undefined`. A trial workspace takes `user.tenantId`, else `context.tenantId`. The new option `storageNamespace: 'anon'` tests the signed-out case. Reported by mfe-dashboard.

## [1.0.0-alpha.2] - 2026-11-03

### Added

- **Rspack and Rsbuild** (`@bcbp-solutions-fzc-llc/webpack-preset`):
  - `@bcbp-solutions-fzc-llc/webpack-preset/rspack`: `platformRspackConfig(options)`, the webpack preset's settings for Rspack 2 (same mode, devtool, output, ids, shared map). Module Federation uses Rspack's `ModuleFederationPluginV1`, the webpack-compatible protocol, so Rspack and webpack shells and remotes load each other; Rspack's default `ModuleFederationPlugin` (the v2 runtime) does not interoperate. `ProvideSdkRspackPlugin` makes the shell provide every SDK subpath; `GlobalThisOnlyPlugin` removes Rspack's `Function('return this')` fallback, which CSP `script-src 'self'` forbids; `ChunkIntegrityPlugin` works unchanged (the script hook comes from Rspack's `RuntimePlugin`).
  - `@bcbp-solutions-fzc-llc/webpack-preset/rsbuild`: `pluginPlatform({ role, name?, exposes? })` for Rsbuild 2, with Rsbuild's mode. It refuses Rsbuild's own `moduleFederation` option.
  - Each entry point loads only its bundler: the main entry webpack, `/rspack` `@rspack/core`, `/rsbuild` `@rsbuild/core` (and the Rspack it bundles, so an Rsbuild app needs no `@rspack/core`). All three are optional peer dependencies; the tarball smoke test checks each entry's imports and types.
  - Tested with real Rspack and Rsbuild builds, a mixed estate in both directions, and the SRI browser tests on an Rspack-built remote in Chromium, Firefox and WebKit.

### Fixed

- LLD §13.1 said `crossOriginLoading: false`; the preset sets `'anonymous'` (since chunk integrity).

## [1.0.0-alpha.1] - 2026-11-03

> **First release.** Everything below is new. The SDK implements design-doc steps 0–14; the browser's Tier 1 metrics (step 15) wait for governance to ratify their names.

### Added

- `/react`: `useSignOut()` (global by default, see *Changed*; `{ global: false }` signs out of this browser only), backed by an optional `signOut` in `PlatformProvider`'s shell value. `/auth`: the `anonymous` reason `device-clock`.

- **Publication to GitHub Packages** (`VERSIONING.md`, *Consume a release* and *Publishing*):
  - `release.yml`'s `npm-publish` job publishes the gated tarballs, after every gate and before the GitHub Release, from the protected `npm` environment. It runs only after their `SHA256SUMS` check, attaches a build-provenance attestation per tarball, and is idempotent: a version is never overwritten, and the registry's integrity is checked after publishing;
  - `pnpm publish:check` (the `package` job in CI and at release) validates the packed manifests and derives the dist-tag (`alpha`, `rc`, `latest`);
  - the root `.npmrc` maps the scope to GitHub Packages.
- **Subresource Integrity for lazily loaded chunks** (`@bcbp-solutions-fzc-llc/webpack-preset`, production): `ChunkIntegrityPlugin` gives every chunk a shell or remote loads after its entry a sha384, which the browser enforces. A chunk without one fails closed, and the build fails if a shipped chunk differs from its recorded hash. `crossOriginLoading` is now `'anonymous'`. `pnpm examples:check` and `test/browser/integrity.spec.ts` check it: in Chromium, Firefox and WebKit a tampered chunk is refused and never runs.

- **Tier 1 metrics submitted for ratification** (`docs/observability/tier1-ratification.md`), as platform-events and platform-pgcommon did:
  - the seven `platform_web_*` metrics, four labels, the `web_vitals` preset and two amendments, as registry entries in gincommon's schema (`monitoring/registry/platform-web.proposal.json`, rendered as `tier1-proposal.md`), validated by gincommon's `metricslint` (`pnpm metrics:proposal`, CI *Validate / Contracts*);
  - `monitoring/`: a Grafana dashboard and Prometheus recording rules, alerts and SLOs (remote availability 99.9%, browser API success 99.5%, Core Web Vitals ≥ 75% good), all in `*.proposed` groups with `metric_status: proposed` until ratification; `promtool` unit tests and a PromQL gate (`pnpm run rules-check`, `dashboards-check`, CI *Validate / Quality*), and registry compliance in `test/unit/monitoring`;
  - the runbooks renamed to the alert names, and an assessment of what logs and traces show until the metrics ship, with four gaps.

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Foundation**

- **`/core`:**
  - page identity (`initializeCore`), validated against the platform registry vocabulary, including the multi-domain shell's `portal` domain (platform-gincommon v2.3.0);
  - the `PlatformRuntime`, shared by every SDK copy on the page, with duplicate-copy detection;
  - correlation ids (`getSessionId`: one RUM session id per browser profile, shared by tabs; `newRequestId`);
  - consent (`setConsentProvider`, `hasConsent`);
  - log sanitizing with gincommon parity (`isSensitiveKey`, `sanitizeFields`, `sanitizeString`).
- **`/config`:**
  - the strict `RuntimeConfigSchema` (`zod/mini`, typed `z.ZodMiniType<RuntimeConfig>`): unknown keys rejected at every level, the design doc's defaults. Using `zod/mini` instead of classic Zod halves the SDK the shell loads (all subpaths, gzipped: 168.6 KB → 86.1 KB);
  - `loadRuntimeConfig`: no HTTP cache, and every failure a `RuntimeConfigError` with issue paths and SDK-worded messages (for example `unknown keys "typo"`, `must be ≥ 1000`);
  - `setRuntimeConfig` / `getConfig` / `tryGetConfig`: set once, deep-frozen;
  - validation never constructs code at runtime (CSP-safe).
- **`/problem`:**
  - the platform error-type registry (`PlatformProblemTypes`, `typeForStatus`, `defineProblemType` with gincommon's rules);
  - the error model (`ProblemError`, `TimeoutError`, `NetworkError`, `AbortedError`);
  - `parseProblemResponse`, which decodes as gincommon does, with synthetic problems for non-problem responses;
  - the gateway deny codes (`GATEWAY_DENY_CODES`, `gatewayDenyCode`).

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Observability**

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

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Data access**

- **`/http`:** `createApiClient`.
  - **Requests:** route templates; identity headers refused; request id, trace context and session id on the page origin and allowlist; the token on the page origin only; an idempotency key on `POST`; a client deadline.
  - **Errors and retries:** the 401 path through the tab's single token refresh; retries with backoff and `Retry-After` for idempotent calls.
  - **Concurrency:** shared concurrent `GET`s; offline detection (`isOnline`, `subscribeOnline`).

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Identity & access**

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

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Micro-frontend platform**

- **`/mfe`:**
  - `loadManifest`: per-remote validation of the entry origin, version, registry owner domain and SRI;
  - `loadRemote`: kill switch, per-attempt timeout, retries, shared-module setup, `RemoteDisabledError` / `RemoteLoadError`;
  - `isChunkLoadError` / `reloadOnceForChunkError`;
  - `/version.json` polling with `subscribeAppUpdate`.
- **`/flags`:** `getFlag` (typed by its fallback), `isRemoteKilled`, the runtime-config and session-context flag providers, `setFlagProvider`.
- **`/nav`:** `navigate` through the shell's router (`registerNavigator`), and `isSafeRedirect` for return-URL validation.

**`@bcbp-solutions-fzc-llc/frontend-sdk` — UI support**

- **`/i18n`:**
  - locale negotiation with `<html lang dir>` (RTL for Arabic);
  - per-remote message namespaces and ICU-lite messages (plural, select, offset; no `eval`);
  - `formatMoney`, `formatDate`, `formatNumber`;
  - `problemMessage`.
- **`/security`:** `sanitizeHtml` (DOMPurify; `TrustedHTML` where Trusted Types exist), `installTrustedTypesPolicy` (the CSP's `platform-sdk` policy) and `isAllowedOrigin`.

**`@bcbp-solutions-fzc-llc/frontend-sdk` — Developer surface**

- **`/react`:** `PlatformProvider` and its hooks.
  - **Session and workspace:** `useSession`, `useCurrentUser`, `useWorkspace`, `useSessionContext`, `useBeforeAuthRedirect`, `useStepUp`, `useSwitchWorkspace`.
  - **Access, flags and language:** `useReadOnly`, `useFeatureFlag`, `useHasPermission` / `Can`, `useLocale` / `useT`.
  - **Data and page state:** `useApi` / `useApiClient` (bound to the nearest MFE scope), `useRouteTemplate`, `useOnlineStatus`, `useAppUpdate`.
  - **Error handling:** `MFEErrorBoundary` and `RemoteBoundary`, and `installGlobalErrorHandlers` (errors, rejections, redacted CSP violations).
- **`/testing`:** `createTestPlatform` (a real SDK runtime with in-memory logs and spans, a signed-in session, permissions and flags), `mockApi` and `mockProblem` (gincommon-shaped problems), and `renderMetricInventory` for `metricslint check` in a remote's CI.

**`@bcbp-solutions-fzc-llc/webpack-preset`**

- **`platformShared`:** React, react-dom, `@opentelemetry/api` `~1.10.0` and every SDK subpath except `/testing`, all as strict singletons, with the SDK under `^1.0.0-0`.
- **`sharedFor('shell' | 'remote')`:** remotes never bundle the SDK.
- **`containerName`:** the SDK's container-global rule.
- **`platformWebpackConfig`:** Trusted Types policy `platform-webpack`, no `eval` devtools, hidden source maps, content hashes, `environment.globalThis`.

**`@bcbp-solutions-fzc-llc/eslint-plugin`**

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
- **Docs:** `ARCHITECTURE.md`, the LLD, functional areas, observability, problem details, `README.md`, `SECURITY.md`, `VERSIONING.md`, `CONTRIBUTING.md` and this changelog; a `.githooks/pre-commit` with the fast gates.

### Security

Fixed before the first release, after a security and production-readiness review:

- `/http`: route param values `.` and `..` are refused; URL parsing resolved them as path steps, so the call (with the token) could reach another endpoint.
- `/logging`, `/tracing`: sensitive keys inside class instances are redacted, and span attributes and recorded errors are scrubbed of JWT and Bearer values like logs (`scrubSecrets` in `/core`).
- `/auth` on shared devices: after a local logout the next sign-in asks for credentials (`prompt=login`); a sign-in by a different user clears the previous user's app storage first (only a SHA-256 of realm and `sub` is kept).
- `/mfe`: remote names never resolve from `Object.prototype`; an already-aborted `loadRemote` injects no script.
- `/config`: `http://localhost` origins are accepted only when the page environment is `local`, `dev` or `test`.
- `examples/cloudfront`: `/csp-report` is a Lambda URL behind a CloudFront secret origin header (`x-origin-verify`, constant-time, rotation list, fails closed), not OAC, which refuses a browser's POST; the CSP adds `report-uri` as a fallback and takes the cross-origin remote and API origins.

### Changed

- **Breaking: signing out is global by default** (report Issue 10, with IAM's recommendation). `IdentityProvider.logout()`, the shell's `signOut` and `useSignOut()` now also end the Keycloak SSO session: after the local sign-out (tokens dropped, app storage cleared, other tabs told) the page goes to the realm's end-session endpoint and comes back to `<origin>/`. A local-only sign-out left that session alive, so on a shared device the next person's sign-in showed the previous user's re-login form with their username. **To keep the old behaviour**, pass `{ global: false }` (`signOut({ global: false })`, `logout({ global: false })`). Keycloak needs nothing: `tender-web` registers `<origin>/*` as an allowed post-logout redirect. The example shell relies on the default.

- **Breaking: React 19 only.** The peer range and the Module Federation shared range for `react` / `react-dom` are `^19.0.0` (was `^18.3.0 || ^19.0.0`). A page runs one React, the shell's, so a range spanning two majors let a remote built on one major run on a shell of the other and fail inside the page; now such a remote is refused at share negotiation. Nothing ran on React 18 (the reference shell and remote already used React 19 form actions). The new CI job `react-floor` (`pnpm run test-react-floor`) runs the typecheck, the unit suite, the build and the example checks on React 19.0.0; the policy for the next major is in VERSIONING.md, *Supported React versions*.

- **Breaking:** the packages are renamed from `@platform/*` to `@bcbp-solutions-fzc-llc/frontend-sdk`, `/webpack-preset` and `/eslint-plugin` (and the ESLint rules from `@platform/<rule>` to `@bcbp-solutions-fzc-llc/<rule>`). GitHub Packages requires the organisation's scope, and the `platform` scope on npmjs.com belongs to a third party, so any install that resolved `@platform/*` from the public registry could have received someone else's code. Imports, the shared-module keys, ESLint configs and SDK-owned storage keys change with the name.

- `@bcbp-solutions-fzc-llc/webpack-preset`: a remote requires `^<the SDK version it was built against>` (`sharedFor('remote')`); the shell keeps `^1.0.0-0`. A shell with an older SDK refuses the remote inside its `RemoteBoundary` instead of failing on a missing export. `react/jsx-runtime`, `react/jsx-dev-runtime` and `react-dom/client` are shared like `react`.
- `/config`: `telemetry.enabled` (default `true`) turns all trace, log and metric export off.
- `/flags`: `read_only` is true when the platform or the tenant says so.
- Release PRs run `pnpm run version-packages` (`changeset version` + `exports:sync`).
- The coverage gate is 98% of statements (as platform-gincommon); 1100+ tests.
- Tests live under `test/` as in platform-gincommon: `unit/<subpath>`, `integration`, `e2e` (the reference shell and remote booted end to end), `smoke` (the served builds, or a deployed shell with `SMOKE_BASE_URL`), `fixtures`, `testenv`, `browser` (Playwright in Chromium, Firefox and WebKit under the production CSP; CI job `browser`), and `stack` (the example shell in the three browsers against a production-like deployment: Keycloak, Envoy with the real IAM services, the distribution on floci and an OTel Collector; `pnpm run stack-up`, `test-stack`, `stack-down`; local only). The issues it found are in `docs/e2e/integrated-deployment-report.md`.

### Fixed

- Production-readiness review, round 4 (`docs/e2e/integrated-deployment-report.md`, `test/browser/README.md`):
  - **`/csp-report` Lambda** (Issue 11): it threw on every invocation, because the runtime calls `handler(event, context)` and `context` landed in `deps`. `handler(event)` is now the entry point and `handle(event, deps)` the logic.
  - **Integrity roots:**
    - the webpack preset pins the shell's entry in `index.html` (`integrity` and `crossorigin` on every `<script src>` the build's HTML loads), checked again before the build is reported;
    - `/mfe` drops a manifest entry without `integrity` outside local, dev and test.
  - **`/auth` device clock** (Issue 8): ID-token times are judged on the provider's clock (its `iat` at receipt), so a device a few minutes off signs in with short tokens. Beyond 10 minutes the session is `anonymous` with the new reason `device-clock`, which the example shell explains.
  - **Telemetry on tab close** (known browser bugs 1 and 2): one `pagehide` budget for the page (`src/internal/unload.ts`): logs first, then the newest spans that fit. Spans are sent inside the listener (`sendBeacon`, else `fetch` keepalive), no longer after the OTLP exporter's `await`.
  - **`sanitizeHtml`** (known browser bug 3): no CSP reports in Chromium for hostile input. A pre-pass removes handler and style attributes and `<style>` elements before DOMPurify parses.
  - **`/http`** (known browser bug 4): never the native `AbortSignal.any`, which loses aborts in WebKit. The by-hand combination releases its listeners when the call ends.
  - **`/auth`:** a restore deferred by a navigation away waits for the network if the page is offline by then.
  - **`/logging`** (Issue 18): logged errors carry `exception.cause`.
  - **Example shell** (Issues 6, 7): a Sign out control (`useSignOut`), and the signed-out screen after a sign-out here or in another tab, with the app unmounted rather than left under the dialog (a shared device).
  - **CloudFront deploy steps** (Issue 15): `--cache-control` on every upload.
  - **Release:** `npm-publish` refuses to publish unless publishing is gated: the `npm` environment requires reviewers, or (a private repository on GitHub Team, which has no reviewers there) it accepts only release tags and an active tag ruleset limits who may create, move or delete `v*` tags to admins and named teams.
  - **Contracts:** the `iam-org-membership` pin moves to `98cf517` (#47). The two interop fixtures are regenerated, because the scope rename had edited their copied comments.

- Production-readiness review, round 5:
  - **`/metrics` on page hide:** the interval is collected when the page is hidden or closing and sent by `sendBeacon`, which outlives a closing tab. Before, the hide flush went through the exporter's plain fetch, and a closing tab lost the last interval of Tier 2 and Tier 3 metrics.
  - **One keepalive budget for all three signals** (`src/internal/unload.ts`), in one priority order on hide and on `pagehide` (metrics' share, then logs, then spans), whatever order the signals were initialised in: the shell initialises tracing first, and on hide the spans took the budget and left the logs nothing.
  - The ledger itself: what the hidden phase sends is recorded, so `pagehide` hands out only what is left (it handed out a fresh 60 KiB). Logs and spans leave the metrics interval its share, sized from the last interval (1–8 KiB). On hide, the logs no longer send several beacons past the budget: the newest that fit go by beacon, the rest by fetch a task later.
  - **Reference Collector configuration** (`examples/collector`, two tiers):
    - the gateway allowlists metric names and label values from the metric registry, drops per-browser attributes, and routes each metric stream to one aggregator;
    - the aggregator converts delta to cumulative. One converter per stream, or replicas write conflicting totals for one series.
    - Points are re-stamped on arrival: with device timestamps, `delta_to_cumulative` silently dropped a slow clock's or a late beacon's points.
    - Tested in the Collector image with two gateways and two aggregators (`pnpm test-collector`, CI job `collector`), and used by the integrated stack.
  - **Nightly integrated-deployment run** (`.github/workflows/stack-nightly.yml`): the stack suite against the pinned backend commits, or every default branch on dispatch; a failing scheduled run opens an issue.

- `@bcbp-solutions-fzc-llc/webpack-preset`: `ProvideSdkPlugin` no longer runs in child compilations (HtmlWebpackPlugin's), which had emitted a second, unused copy of every provided SDK chunk into the shell's build (16 extra files, about 1.5 MB with maps, outside the integrity map).

- Operational failures are visible without telemetry consent (`docs/observability/tier1-ratification.md` §5): `/http` logs an essential warning `api call got no response` for timeouts and network failures (rate-limited, offline and aborts excluded), `/mfe` logs `chunk load failed: reloading` before the reload, and `/auth`'s sign-in, workspace-resolve, refresh-restore and live-session-ended warnings are essential.
- No remote could load in production (both found by the integrated E2E run, `docs/e2e/integrated-deployment-report.md`, Issues 1 and 2):
  - CSP: the shell's and every remote's webpack runtime create the `platform-webpack` Trusted Types policy, so `trusted-types` now carries `'allow-duplicates'` (`examples/cloudfront/csp.mjs`, `response-headers-policy.json`);
  - `@bcbp-solutions-fzc-llc/webpack-preset`: the shell provides every SDK subpath in the share scope (`ProvideSdkPlugin`, lazily), not only those it imports itself; a remote using one the shell never imports (such as `/problem`) failed with "Shared module … doesn't exist in shared scope". `pnpm examples:check` asserts it on the built shell.
- `/auth` (integrated E2E run, Issues 4 and 19):
  - a short-lived access token no longer causes a refresh storm: the refresh lead is at most a third of the token's lifetime (a 60 s token was refreshed many times a second; 300 s tokens are unchanged);
  - a refresh request cancelled because the page is navigating away no longer redirects that page to the IdP (its `prompt=none` restore replaced the user's navigation). The page restores only if it is still there 10 s later.
- `@bcbp-solutions-fzc-llc/webpack-preset`: the shell loads its scripts from `/` (`publicPath: '/'`, bundles under `assets/`); with `'auto'`, `index.html` served for a deep link or `/auth/callback` asked for its scripts under that route, so the shell never started there (found by the new `test/smoke`).
- `/http`: a deduplicated GET started inside `withSpan` continues the caller's trace (`/tracing` adds `bindTraceContext`); `/react`: `MFEErrorBoundary` logs an API error with its `request_id` (both found by the new `test/integration`).
- `/http` + `useApi`: a GET made right after every subscriber of a shared GET aborted no longer joins the dead request (`useApi` stayed `loading` under React StrictMode); failures while reading a body are `TimeoutError` / `AbortedError` / `NetworkError`; works without `AbortSignal.any` (Safari < 17.4); each subscriber of a deduplicated GET gets its own copy of `data`.
- `/auth`, `/react`: `getSession()` returns one stable `loading` object before `initializeAuth` (React looped); hooks keep stable subscriptions; `useSession` follows a provider installed after its first render; the first recorded sign-in keeps a draft saved before the redirect.
- `/tracing`: a hidden page sends the newest spans first in one keepalive request (a closing tab keeps them), then flushes the rest; `pagehide` sends what fits one keepalive request and counts the rest (`droppedOnUnload`); the sampler description matches Go's `%g`.
- `/metrics`: instruments created before `initializeCore` record once it has run.
- `/storage`: a write that fails (storage full) is read back for the rest of the page, and the last saved value stays for a reload.
- `/i18n`: a namespace registered during a locale change loads the new locale; `/logging`: `Map` and `Set` keep their contents.
- `@bcbp-solutions-fzc-llc/eslint-plugin`: `no-identity-headers` sees computed `['headers']`; the import rules see template-literal `require` / `import()`.

[Unreleased]: https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/compare/v1.0.0-alpha.3...HEAD
[1.0.0-alpha.3]: https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/compare/v1.0.0-alpha.2...v1.0.0-alpha.3
[1.0.0-alpha.2]: https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/compare/v1.0.0-alpha.1...v1.0.0-alpha.2
[1.0.0-alpha.1]: https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/releases/tag/v1.0.0-alpha.1
