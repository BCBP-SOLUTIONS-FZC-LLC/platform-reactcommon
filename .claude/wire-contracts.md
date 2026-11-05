# Wire Contracts

What crosses the page boundary. Backend-shaped values are **generated** from pinned commits into `packages/frontend-sdk/contracts/*.json` and `src/internal/generated/` (`pnpm contracts:sync`; pins in `contracts/sources.json`): change the source repo, then re-sync. Never hand-edit them.

## Request Headers (`/http`)

| Header | When | Source |
|---|---|---|
| `x-request-id` | every call (`newRequestId`) | `contracts/headers.json` (gincommon transport) |
| `traceparent`, `tracestate` | page origin + exact `api.propagationAllowlist` origins | W3C |
| `x-session-id` | correlated calls, unless `telemetry.sendSessionHeader: false` | `/core` session id |
| `idempotency-key` | `POST` | `/http` |
| `Authorization: Bearer …` | the page origin only | `/auth` token source |

**Never sent** (`FORBIDDEN_REQUEST_HEADERS`, refused with an error): `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`. The gateway injects them (`contracts/gateway-headers.json`, from AuthZ Enrichment). Response headers read: `X-Trace-ID`, `X-Request-ID`. A call that carries the token or correlation headers uses `redirect: 'manual'`: a redirect is not followed (the headers would reach its origin) and becomes a synthetic 502.

Limits (gincommon validation): header value ≤ 256 bytes, request id ≤ 128 bytes `^[a-zA-Z0-9._-]+$`, roles header ≤ 4096 bytes / 64 roles.

## Errors

Every API error is an RFC 9457 problem decoded as gincommon's client does (`contracts/problem-types.json`; non-problem responses become synthetic problems). Gateway deny codes (`DENY_UNRESOLVABLE_SUBJECT`, `DENY_TENANT_READ_ONLY`, `DENY_MFA_STALE`, …): `contracts/gateway-deny-codes.json`, `gatewayDenyCode(problem)`. Registry: [`docs/problem-details/`](../docs/problem-details/README.md).

## Identity Provider (Keycloak)

- Issuer per realm: `<authOrigin>/realms/<realm>`; client `tender-web` (public, PKCE S256); the SDK asks for `auth.scopes` from `runtime.json` (default `['openid']`; must include `openid`). Name and email come from the **ID token** (realm-provisioner #49: access tokens carry no name or email; they keep `sub`, `aud`, `tenant_id`, `auth_time`).
- End-session: form POST to `/protocol/openid-connect/logout` with `id_token_hint`, `client_id`, `post_logout_redirect_uri=<origin>/` (registered as `<origin>/*`); CSP `form-action` lists the IdP origin.
- IAM ports used by the shell: PUB-1 `GET /api/v1/public/tenants/resolve?identifier=` (no auth), P-35 `GET /api/v1/me/session-context` (cases in `contracts/tenant-resolve-cases.json`, `session-context-cases.json`).

## Browser Storage and Channel

| Key | Area | Owner |
|---|---|---|
| `@bcbp-solutions-fzc-llc/frontend-sdk:session-id` | local | `/core` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:session-started` | local | `/core` (the session id's start; a new id after 24 h) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:workspaces` | local | `/auth` (workspace cache) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:signed-out` | local | `/auth` (no silent sign-in; next login `prompt=login`) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-activity` | local | `/auth` (cross-tab idle) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:last-user` | local | `/auth` (SHA-256 of realm + `sub`, never the `sub`) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:pending:<state>` | session | `/auth` (PKCE record, 10 min) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:auth:restore-attempt` | session | `/auth` (loop guard) |
| `@bcbp-solutions-fzc-llc/frontend-sdk:chunk-reload` | session | `/mfe` |
| `@bcbp-solutions-fzc-llc/frontend-sdk:storage:<namespace>:<appId>:<key>` | both | `/storage` (cleared on sign-out and workspace switch, with the unprefixed `<realm>:<appId>:<key>` keys alpha.3 and earlier wrote; other keys are left alone) |

`BroadcastChannel('platform-auth')` carries only `{ type: 'logout' | 'workspace-switched' }`, never a token. Credential-like storage keys are refused (`ForbiddenStorageKeyError`).

## Static Paths the Shell Reads (CloudFront)

`/config/runtime.json` (no-cache, strict schema), `/remotes/manifest.json` (no-cache; entries carry `integrity`), `/remotes/<name>/<version>/remoteEntry.js` (immutable), `/version.json` (no-cache, app-update polling), `/assets/*` (immutable, pinned by `integrity` in `index.html`), `/csp-report` (Lambda, `x-origin-verify`). Behaviours: [`examples/cloudfront/README.md`](../examples/cloudfront/README.md).

## Telemetry (`/otel`)

- OTLP/HTTP **JSON** to the same origin: `POST /otel/v1/traces`, `/otel/v1/logs`, `/otel/v1/metrics` (CloudFront cannot strip `/otel`; the Collector listens on these paths).
- Resource: `service.name`, `service.version`, `service.namespace` (= domain), `deployment.environment.name`; never `service.instance.id`. The reference Collector removes all of them from metrics.
- Log envelope: `trace_id`, `span_id`, `request_id`, `session_id`, `mfe`, `page_route`; redaction as gincommon (sensitive keys, JWT/Bearer, URL query). Event catalogue: LLD §11.1.
- Metrics: **delta** temporality; const labels `domain`, `service`, `environment`; names `<domain>_*` (Tier 2, registry), `<domain>_<service>_*` (Tier 3), `platform_web_*` (Tier 1, proposed, not emitted yet). Registry: `contracts/metric-registry.json`; Tier 1 proposal: `monitoring/registry/platform-web.proposal.json`.
- On hide/close: `sendBeacon` / fetch `keepalive` within one 60 KiB page budget (LLD §7.5).
- The reference Collector (`examples/collector`) accepts only the proposal's `platform_web_*` names or a `<domain>_*` name matching the `domain` label with a `_total`/`_seconds`/`_bytes` suffix; label keys from the registry and the proposal on Tier 1 and Tier 2 metrics, and on Tier 3 metrics snake_case keys that are not prohibited, at most 8 besides the const labels; label values from the registry and the proposal, and `page_route` up to 64 characters (longer → `unknown`); traces and logs keep only the four resource attributes above, metrics none (their `domain`, `service`, `environment` labels say the same). `examples/collector/test` keeps those lists equal to the registry. Mimir's per-tenant series limits are the backstop (`examples/collector/README.md`).

## CSP

`script-src 'self'`, `form-action 'self' <IdP origin>` (the sign-out form POST), `require-trusted-types-for 'script'`, `trusted-types platform-sdk platform-webpack dompurify 'allow-duplicates'`, `report-to` + `report-uri /csp-report`. Source of truth: `examples/cloudfront/csp.mjs` (also the response-headers policy); `test/browser/csp.spec.ts` boots the SDK under it in three engines.
