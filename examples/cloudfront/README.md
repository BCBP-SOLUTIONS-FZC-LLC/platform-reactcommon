# CloudFront and CSP (design doc §C3)

Documentation and IaC inputs for the web distribution. **Nothing here deploys anything.** The
platform's infrastructure repository owns the distribution; it takes these files as they are.

| File | What it is |
|---|---|
| `csp.mjs` | The response headers, from one source: `buildCsp({ idpOrigin })`, `securityHeaders()` |
| `response-headers-policy.json` | A CloudFront `ResponseHeadersPolicyConfig` with those headers (tests keep it equal to `csp.mjs` and to the design doc) |
| `spa-rewrite.js` | CloudFront Function (`cloudfront-js-2.0`, viewer request) for the **Default (\*)** behavior: extension-less paths → `/index.html` |
| `csp-report/handler.mjs` | Lambda (function URL, payload 2.0) behind `/csp-report`: CSP reports → OTLP logs to the Collector |

## Behaviors, in precedence order

| Path | Origin | Cache policy | Origin request | Headers policy | Notes |
|---|---|---|---|---|---|
| `/api/*` | API gateway / ALB | CachingDisabled | AllViewerExceptHostHeader | none (the gateway owns them) | All methods, WAF. Envoy strips `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`. `/api/v1/public/tenants/resolve` routes without `jwt_authn`/`ext_authz`, with a per-IP rate limit and CAPTCHA |
| `/otel/*` | OTel Collector (OTLP/HTTP) | CachingDisabled | no cookies, no `Authorization` | security headers | POST only. WAF rate rule, 1 MB body limit. Unauthenticated by design (pre-login errors) |
| `/csp-report` | Lambda function URL (OAC-signed) | CachingDisabled | no cookies | security headers | POST only, WAF rate rule, 64 KB limit (also enforced by the handler) |
| `/config/runtime.json` | S3 | TTL 0, honour `Cache-Control: no-cache` + ETag | — | security headers | One object per environment (see `examples/shell/public/config/runtime.json`) |
| `/version.json` | S3 | as above | — | security headers | Written **last** by the deploy |
| `/remotes/manifest.json` | S3 | as above | — | security headers | Written after every remote has uploaded |
| `/remotes/*` | S3 | CachingOptimized, `max-age=31536000, immutable` | — | security headers | `/remotes/<name>/<version>/…`, never overwritten |
| `/assets/*` | S3 | CachingOptimized, immutable | — | security headers | Content-hashed |
| `Default (*)` | S3 | `no-cache` | — | security headers | `spa-rewrite.js` on viewer request. **No** custom 403/404 → `index.html` error responses: they would turn `/api/*` 404s into HTML |

## Deploy order

1. Upload each remote to `/remotes/<name>/<version>/` (the `examples/remote-tenders/dist` contents). Never
   overwrite a version.
2. Write `/remotes/manifest.json`:
   `{ "tenders": { "entry": "/remotes/tenders/<version>/remoteEntry.js", "version": "<version>", "ownerDomain": "tender_management", "integrity": "sha384-…" } }`.
3. Upload the shell (`examples/shell/dist`): hashed files first, `index.html` last.
4. Write `/version.json` (`{ "version": "<shell build version>" }`), which tells open tabs an update exists.

Source maps (`*.map`) are emitted by the build (`hidden-source-map`) and never referenced. Upload them
to the error-tracking store, never to S3 behind the distribution.

## Content-Security-Policy

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self';
connect-src 'self' https://auth.bcbpsolutions.com; manifest-src 'self'; worker-src 'self';
base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; upgrade-insecure-requests;
require-trusted-types-for 'script'; trusted-types platform-sdk platform-webpack dompurify; report-to csp
```

- `connect-src` names Keycloak (`auth.bcbpsolutions.com`, not proxied, §D4) for the token and refresh
  fetches. Login, `prompt=none` and logout are top-level navigations, which CSP does not restrict.
- The three Trusted Types policies are the SDK's (`/security`), webpack's (`@platform/webpack-preset`)
  and DOMPurify's.
- Nothing in the SDK or the example builds needs `eval`: the preset removes webpack's `new Function`
  fallback (`output.environment.globalThis`), and the SDK runs Zod jitless. `pnpm examples:check`
  checks the built output.
- `style-src 'self'` stays strict (§D3): zero-runtime CSS only; `@platform/eslint-plugin`'s
  `no-runtime-css-in-js` rule enforces it in code.

## `/csp-report`

Browsers post `application/reports+json` (Reporting API, via `Reporting-Endpoints: csp="/csp-report"`)
or `application/csp-report`. The handler keeps the effective directive, disposition, and the origin and path
of the blocked, document and source URLs (no query string, fragment or credentials), runs every value
through the SDK's redaction (`sanitizeString`), and posts OTLP/HTTP JSON logs
(`event.name=csp.violation`, severity WARN) to `COLLECTOR_LOGS_URL`. Bundle it with its
`@platform/frontend-sdk/core` import (e.g. esbuild, `--platform=node`). Environment:
`COLLECTOR_LOGS_URL`, `SERVICE_NAMESPACE` (`portal`, §D1), `DEPLOYMENT_ENVIRONMENT`.

Violations after the shell has started are also logged by the SDK itself (`installGlobalErrorHandlers`,
with trace and session correlation); this endpoint covers the ones before that.
