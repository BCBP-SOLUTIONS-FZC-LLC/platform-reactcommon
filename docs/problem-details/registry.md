# Error type registry (as the SDK reads it)

<!-- Generated from packages/frontend-sdk/contracts/problem-types.json, packages/frontend-sdk/contracts/gateway-deny-codes.json by `pnpm docs:sync`. Do not edit. -->

Every platform HTTP error is `application/problem+json` with a `type` URI `https://errors.company.com/{domain}/{error}`. The SDK never matches the full URI: it derives `typeId` (`{domain}/{error}`) and matches on that, so a different type base changes nothing.

## Platform types (`platform/*`)

From platform-gincommon `pkg/problem` (`go-probe contracts-export`). In the SDK: `PlatformProblemTypes.<Key>` (`/problem`), `e.is(PlatformProblemTypes.<Key>)` on a `ProblemError`, and `problemMessage(e)` (`/i18n`: in the `platform` namespace, `problem.<typeId>.<errorCode>`, then `problem.<typeId>`, in the current then the default locale, else the title).

| Type | Status | Default `errorCode` | Title | `PlatformProblemTypes` key |
|---|---|---|---|---|
| `platform/bad-request` | 400 | `BAD_REQUEST` | Bad Request | `BadRequest` |
| `platform/validation-failed` | 400 | `VALIDATION_FAILED` | Validation failed | `ValidationFailed` |
| `platform/unauthorized` | 401 | `UNAUTHORIZED` | Unauthorized | `Unauthorized` |
| `platform/forbidden` | 403 | `FORBIDDEN` | Forbidden | `Forbidden` |
| `platform/not-found` | 404 | `NOT_FOUND` | Not Found | `NotFound` |
| `platform/method-not-allowed` | 405 | `METHOD_NOT_ALLOWED` | Method Not Allowed | `MethodNotAllowed` |
| `platform/conflict` | 409 | `CONFLICT` | Conflict | `Conflict` |
| `platform/payload-too-large` | 413 | `PAYLOAD_TOO_LARGE` | Payload Too Large | `PayloadTooLarge` |
| `platform/unsupported-media-type` | 415 | `UNSUPPORTED_MEDIA_TYPE` | Unsupported Media Type | `UnsupportedMediaType` |
| `platform/business-rule-violation` | 422 | `BUSINESS_RULE_VIOLATION` | Business rule violation | `BusinessRuleViolation` |
| `platform/rate-limit-exceeded` | 429 | `RATE_LIMIT_EXCEEDED` | Too Many Requests | `RateLimitExceeded` |
| `platform/internal-error` | 500 | `INTERNAL_ERROR` | Internal Server Error | `InternalError` |
| `platform/not-implemented` | 501 | `NOT_IMPLEMENTED` | Not Implemented | `NotImplemented` |
| `platform/service-unavailable` | 503 | `SERVICE_UNAVAILABLE` | Service Unavailable | `ServiceUnavailable` |
| `platform/gateway-timeout` | 504 | `GATEWAY_TIMEOUT` | Gateway Timeout | `GatewayTimeout` |

## Gateway deny codes

Sent by IAM AuthZ Enrichment as `errorCode` on its `platform/unauthorized`, `platform/forbidden` or `platform/service-unavailable` problems. `gatewayDenyCode(e)` returns one of these, else `undefined`. See [README.md](README.md#gateway-denials) for how the UI reacts to each.

| `errorCode` | Status |
|---|---|
| `DENY_UNRESOLVABLE_SUBJECT` | 403 |
| `DENY_TENANT_READ_ONLY` | 403 |
| `DENY_MFA_STALE` | 403 |
| `DENY_TENDER_ACL_INSUFFICIENT` | 403 |
| `DENY_ROLE_INSUFFICIENT` | 403 |
| `DENY_SERVICE_UNAVAILABLE` | 503 |
| `DENY_MALFORMED_IDENTITY` | 401 |

## Wire rules

- Standard members: `type`, `title`, `status`, `detail`, `instance`, `traceId`, `errorCode`, `tenantId`, `timestamp`, `validationErrors`. Every other top-level member is an extension (`ProblemDetails.extensions`).
- Extension member names match `^[A-Za-z][A-Za-z0-9_]{2,}$`.
- A problem body larger than 1048576 bytes is not parsed (a synthetic problem is returned instead).
- Domain and error slugs match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; error codes match `^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$`.

## Domain types (`{domain}/*`)

Defined by each domain's services; the SDK accepts any type and exposes `defineProblemType(domain, name, title, status, code)` so remotes can match their own (for example `tender/deadline-passed`). Domain types are not listed here.
