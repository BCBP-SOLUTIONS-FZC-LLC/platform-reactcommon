# Request Flows

The flows a change most often touches, in order. Authoritative detail: [LLD §8](../docs/lld/platform-reactcommon-lld.md#8-key-flows) (flows), §5.4 (behaviour specifications), §7.5 (unload); sequence diagrams in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Shell Bootstrap (`examples/shell/src/bootstrap.tsx`)

1. `installTrustedTypesPolicy()`, then `initializeCore({ serviceName, domain, environment, buildVersion })`.
2. `loadRuntimeConfig()` → `setRuntimeConfig(cfg)` (strict schema, deep-frozen), `setConsentProvider(cmp)`.
3. `initializeTracing`, `initializeLogging`, `initializeMetrics` (all to `cfg.telemetry.otlpBaseUrl`, same origin), `installGlobalErrorHandlers()`, `startWebVitals()`, `setFlagProvider(runtimeConfigFlagProvider())`.
4. `createOidcProvider(cfg.auth, workspaceResolver)` → `setTokenSource(initializeAuth(idp))` → `await idp.init()`. `init()` may redirect once (`prompt=none`) and never settle.
5. Anonymous: choose a workspace and `idp.login(...)`, unless the reason is `signed-out` (show "You are signed out") or `device-clock` (show "Check your device's clock"): never an automatic login there.
6. Authenticated: P-35 session context → `setAuthorizer`, `setAuthzSubject`, session flags; `rememberWorkspace`; `initializeI18n`; `loadManifest`; `startVersionPolling`; render `<ShellRoot>` (a `PlatformProvider` whose `locale` follows `setLocale` and whose `context` follows the session-context store; `signOut: (o) => idp.logout(o)`). If P-35 failed, the page renders deny-all and retries a transient failure (network, timeout, 429, 5xx) 3 times after 1 s, 2 s, 4 s; on success it sets the subject, flags and workspace and re-renders. A sign-out stops the retries.
7. On `anonymous / signed-out` later (here or another tab): unmount the app, show the signed-out screen.

## Sign-in (Authorization Code + PKCE S256)

`login({ workspace, returnUrl, prompt? })` writes a pending record (`state`, `nonce`, 32-byte verifier; sessionStorage, 10 min) and assigns the realm's `/auth` URL. After a sign-out the signed-out mark makes it `prompt=login`. The callback (`/auth/callback`, served by the SPA rewrite) checks: the `state` record → RFC 9207 `iss` → code exchange (15 s) → ID-token claims (`iss`, `aud`, `azp`, `nonce`; times on the provider's clock from `iat`, more than 10 min off is `device-clock`). Tokens go to memory only; the URL becomes the record's `returnUrl`.

## Refresh and Restore

- Timer at `expiresAt − min(60 s, lifetime/3) ± jitter`, `getAccessToken()` near expiry, or `/http`'s 401 path. Single-flight per tab; a replaced refresh token is never resent.
- `invalid_grant` → `expired`. 429, or 503 with `Retry-After` (refused unprocessed) → keep the tokens, retry with backoff (2 s doubling to 30 s with jitter, or `Retry-After` if longer) inside the same single-flight refresh, so `getAccessToken()` and a 401 wait for its answer instead of sending more; the retry must answer 5 s before the access token expires, else a `prompt=none` restore. Anything ambiguous (may have reached Keycloak: a network error, 500, 502, 504, bare 503) → drop the lineage, wait for `online`, `prompt=none` restore. Cancelled by a navigation away → wait 10 s first (an unloading page never gets there).
- Each tab keeps its own lineage in one Keycloak session; nothing about tokens crosses tabs.

## Sign-out (global by default)

`logout(o?)` / the shell's `signOut` / `useSignOut()`: drop tokens, `clearAllAppStorage()`, forget the user (UI authorization subject, flag provider, read-only mark), rotate the session id, set the signed-out mark, broadcast `{ type: 'logout' }`, move to `anonymous { signed-out }`; then, **unless `{ global: false }`**, a form POST (a hidden form, removed once the page leaves) to the realm's end-session endpoint (`id_token_hint`, `client_id`, `post_logout_redirect_uri=<origin>/` in the body, never the URL); the shell's CSP `form-action` must allow the IdP origin. Other tabs follow the broadcast, expired and loading ones included (a sign-in a loading tab was finishing is dropped). `dispose()` stops a provider without signing out (HMR, tests). `switchWorkspace(w)` is a local sign-out of the realm, then `login(w)`.

## API Call (`createApiClient`)

`api.get('/v1/tenders/:id', { params: { id } })`: route template → URL (params `.`/`..` refused); headers: `x-request-id`, `traceparent`/`tracestate` (page origin + exact allowlist), `x-session-id`, `idempotency-key` on POST, the token on the page origin only; identity headers refused. 401 → one shared refresh → retry once. Idempotent calls retry with backoff and `Retry-After`. Concurrent identical GETs share one request. Errors are `ProblemError` (RFC 9457 parsed as gincommon does), `TimeoutError`, `NetworkError`, `AbortedError`. One span `HTTP <METHOD>` and one Tier 1 observation (port) per logical call.

## Remote Load (`/mfe`)

`loadManifest()` (with a timeout) validates each entry (origin, version, registry owner domain, `integrity` required outside local/dev/test). `loadRemote(name, module)`: kill switch → script with `integrity` + Trusted Types URL (skipped only when `window.__platform_mfe_<name>` already holds a container) → container init with the shell's share scope → `get(module)`; one timeout covers the whole attempt (entry, `init`, the module's chunks), with retries; containers are cached on the runtime; `RemoteDisabledError` / `RemoteLoadError`, contained by `RemoteBoundary`. Lazy JS and CSS chunks carry their sha384 (preset); a chunk-load error reloads once per version, after the `useBeforeAuthRedirect` listeners run (`src/internal/reload.ts`). `/version.json` polls time out; the interval is at least 1 s.

## Telemetry on Hide and Close (`src/internal/unload`)

`visibilitychange` (hidden) and `pagehide` each run the senders in priority order, within one 60 KiB keepalive budget (ledger of what is in flight for 5 s):
1. **metrics** (`-1`): reserve the share (last interval ×1.25, 1–8 KiB), collect asynchronously, `sendBeacon` in it;
2. **logs** (`0`): the newest queued records that fit, one `sendBeacon`; the rest by fetch (a task later when hidden);
3. **spans** (`1`): the newest that fit; on `pagehide` by `sendBeacon` (else fetch keepalive) started in the listener, the rest counted as `droppedOnUnload`.

Browsers fire `visibilitychange` before `pagehide` on a tab close, so the metrics interval is usually collected while the page is alive.
