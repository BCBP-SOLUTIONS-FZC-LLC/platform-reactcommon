# CloudFront and CSP (design doc §C3)

Documentation and IaC inputs for the web distribution. **Nothing here deploys anything.** The
platform's infrastructure repository owns the distribution; it takes these files as they are.

| File | What it is |
|---|---|
| `csp.mjs` | The response headers, from one source: `buildCsp({ idpOrigin, remoteOrigins, apiOrigins })`, `securityHeaders()` |
| `response-headers-policy.json` | A CloudFront `ResponseHeadersPolicyConfig` with those headers (tests keep it equal to `csp.mjs` and to the design doc) |
| `spa-rewrite.js` | CloudFront Function (`cloudfront-js-2.0`, viewer request) for the **Default (\*)** behavior: extension-less paths → `/index.html` |
| `csp-report/handler.mjs` | Lambda (function URL, payload 2.0) behind `/csp-report`: CSP reports → OTLP logs to the Collector |

## Behaviors, in precedence order

| Path | Origin | Cache policy | Origin request | Headers policy | Notes |
|---|---|---|---|---|---|
| `/api/*` | API gateway / ALB | CachingDisabled | AllViewerExceptHostHeader | none (the gateway owns them) | All methods, WAF. Envoy strips `x-user-id`, `x-tenant-id`, `x-tenant-roles`, `x-departments`, `x-plan`, `x-feature-flags`, `x-residency-mode`. `/api/v1/public/tenants/resolve` routes without `jwt_authn`/`ext_authz`, with a per-IP rate limit and CAPTCHA |
| `/otel/*` | OTel Collector (OTLP/HTTP) | CachingDisabled | no cookies, no `Authorization` | security headers | POST only. WAF rate rule, 1 MB body limit. Unauthenticated by design (pre-login errors) |
| `/csp-report` | Lambda function URL (`AuthType NONE`) + custom origin header `x-origin-verify` | CachingDisabled | no cookies | security headers | POST only, WAF rate rule, 64 KB limit (also enforced by the handler). **Not** OAC: see [`/csp-report`](#csp-report) |
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
require-trusted-types-for 'script'; trusted-types platform-sdk platform-webpack dompurify;
report-uri /csp-report; report-to csp
```

- `connect-src` names Keycloak (`auth.bcbpsolutions.com`, not proxied, §D4) for the token and refresh
  fetches. Login, `prompt=none` and logout are top-level navigations, which CSP does not restrict.
- `report-to csp` (with `Reporting-Endpoints: csp="/csp-report"`) is used by browsers with Reporting-API
  CSP reports; `report-uri /csp-report` is the fallback for the rest (browsers that support `report-to`
  ignore it). Both reach the same handler.
- Cross-origin remotes and APIs: `buildCsp({ remoteOrigins, apiOrigins })`. `remoteOrigins` (added to
  `script-src`, `style-src`, `img-src`, `font-src` and `connect-src`: a remote's chunks and its static
  CSS, images and fonts) **must mirror** runtime.json `remotes.allowedOrigins`; `apiOrigins`
  (added to `connect-src`) must mirror the cross-origin entries of runtime.json `api.propagationAllowlist`.
  An origin in runtime.json but not in the CSP is blocked by the browser; one in the CSP but not in
  runtime.json is attack surface. Each must be an exact `https://host[:port]` origin (no wildcard, path,
  trailing slash or `http:`; runtime.json's `http://localhost` dev origins have no place in a deployed
  CSP), or `buildCsp` throws. Both default to none, which gives the policy above.
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
`ORIGIN_VERIFY_SECRET`, `COLLECTOR_LOGS_URL`, `SERVICE_NAMESPACE` (`portal`, §D1), `DEPLOYMENT_ENVIRONMENT`.

### Origin authentication: a secret origin header, not OAC

OAC in front of a Lambda function URL (`AuthType AWS_IAM`) does not work here: for `POST`/`PUT` bodies,
Lambda URL OAC requires the **viewer** to send `x-amz-content-sha256` (unsigned payloads are not
supported), and a browser delivering a CSP report never does, so every report would be a 403. Instead:

- The function URL is `AuthType NONE`.
- The `/csp-report` CloudFront origin adds a custom origin header
  `x-origin-verify: <secret>` (CloudFront overwrites any viewer-sent header of that name). Keep the
  value in Secrets Manager or SSM SecureString and inject it at deploy into both the origin's
  `CustomHeaders` and the Lambda's `ORIGIN_VERIFY_SECRET`.
- The handler answers 403 (empty body) before looking at anything else when the header does not match
  one of the comma-separated values in `ORIGIN_VERIFY_SECRET` (constant-time compare). An unset or empty
  `ORIGIN_VERIFY_SECRET` rejects everything (fails closed).
- Rotation: set `ORIGIN_VERIFY_SECRET=<new>,<old>` on the Lambda, switch the CloudFront origin header to
  `<new>`, wait for the distribution to deploy, then set `ORIGIN_VERIFY_SECRET=<new>`.

```json
"Origins": { "Items": [{
  "Id": "csp-report",
  "DomainName": "<url-id>.lambda-url.<region>.on.aws",
  "CustomOriginConfig": { "HTTPPort": 80, "HTTPSPort": 443, "OriginProtocolPolicy": "https-only", "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] } },
  "CustomHeaders": { "Quantity": 1, "Items": [{ "HeaderName": "x-origin-verify", "HeaderValue": "{{resolve:secretsmanager:platform/csp-report/origin-verify}}" }] },
  "OriginAccessControlId": ""
}] }
```

(The `HeaderValue` is a CloudFormation dynamic reference; use your IaC's equivalent secret lookup.
The secret never goes in this repository.) The function URL is publicly reachable by design; the header check, the payload limits and the WAF rule
on the distribution are what bound it. Without the header a direct caller gets a 403 and no detail.

Violations after the shell has started are also logged by the SDK itself (`installGlobalErrorHandlers`,
with trace and session correlation); this endpoint covers the ones before that.
