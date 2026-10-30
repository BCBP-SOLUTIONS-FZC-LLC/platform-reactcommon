# RFC 9457 Problem Details in the browser

platform-gincommon and platform-fastapicommon answer every HTTP error with an RFC 9457 problem (`application/problem+json`). This page covers the browser's side:
- how the SDK reads those problems;
- how a remote reacts to them;
- what the SDK guarantees when a response isn't a problem.

The registry of platform types and gateway deny codes is generated: [`registry.md`](registry.md).

## The contract

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

`/http` turns every non-2xx answer into a `ProblemError` with:
- **the standard members:** `type`, `title`, `status`, `detail`, `instance`;
- **gincommon's members:** `traceId`, `errorCode`, `tenantId`, `timestamp`, `validationErrors`;
- **`extensions`:** every other top-level member;
- **`typeId`:** `{domain}/{error}`, the last two path segments of `type`, `undefined` for `about:blank`;
- **`requestId`:** the `x-request-id` the SDK sent;
- **`synthetic`:** see below.

The parsing matches gincommon's own client decoder: the interop fixture `problem_bodies.json` holds real gincommon and fastapicommon responses with gincommon's decoding as the expected result. Interop pair 4 checks that both servers parse to the same `ProblemDetails`.

### When the answer isn't a problem

A body that isn't `application/problem+json`, or is larger than 1 MiB, isn't parsed. The SDK synthesizes a problem from the status (`typeForStatus`, gincommon's `TypeForStatus`), with `traceId` from the `X-Trace-ID` header and `synthetic: true`. **The raw body is never surfaced.**

### Other errors

| Class | When | Fields |
|---|---|---|
| `TimeoutError` | The client deadline (`api.timeoutMs`, default 35 s) passed | `timeoutMs`, `requestId` |
| `NetworkError` | `fetch` failed; `offline: true` when the browser is offline (then the call fails without a fetch) | `offline`, `requestId` |
| `AbortedError` | The caller's signal aborted (unmount, deps change) | — (never reported or counted as a failure) |

`ApiError = ProblemError | TimeoutError | NetworkError` is what `useApi` returns as `error`. Anything else thrown inside `useApi`'s function goes to the nearest error boundary.

## Matching problems

Match by **type id**, never by `title`, `detail` or the full URI (the type base may differ between environments):

```ts
import { isProblemError, PlatformProblemTypes, toFieldErrorMap } from '@platform/frontend-sdk/problem';
import { problemMessage } from '@platform/frontend-sdk/i18n';

try {
  await api.put('/tenders/:id', { params: { id }, body });
} catch (e) {
  if (!isProblemError(e)) throw e;                                   // Timeout/Network → boundary
  if (e.is(PlatformProblemTypes.ValidationFailed)) setFieldErrors(toFieldErrorMap(e));
  else if (e.is(PlatformProblemTypes.Conflict)) setFormError(problemMessage(e));
  else setFormError(problemMessage(e));
}
```

- **`toFieldErrorMap(e)`** returns `field → messages[]`. It has no prototype, so a field named `__proto__` is just a key.
- **Domain types:** a remote can match its own with `defineProblemType('tender', 'deadline-passed', 'Deadline passed', 422, 'DEADLINE_PASSED')`. The domain and name are kebab slugs, the status is 4xx/5xx, the code is UPPER_SNAKE, and the `platform` domain is reserved.
- **`errorCode` refinements:** a service may refine a type's default `errorCode` per occurrence (`TENDER_NOT_FOUND` on `platform/not-found`). Match `e.errorCode` for those.

## User-facing messages

`problemMessage(e)` looks up, in the `platform` namespace:
1. `problem.<typeId>.<errorCode>`, then `problem.<typeId>`, in the current locale;
2. the same two keys in the default locale;
3. otherwise the problem's `title`.

Messages can use `{status}` and `{errorCode}`. A general message in the user's language beats a specific one in another language. Never show `detail` to users unless the type documents it as safe.

## Gateway denials

IAM AuthZ Enrichment denies a request before it reaches the service. Its body is a platform problem (`platform/unauthorized`, `platform/forbidden` or `platform/service-unavailable`) with the deny reason as `errorCode`. `gatewayDenyCode(e)` returns that code when it's one of `GATEWAY_DENY_CODES`, and the UI reacts by code:

| Code | Reaction |
|---|---|
| `DENY_MFA_STALE` | Step-up: `useStepUp().reauthenticate()` (`prompt=login&max_age`). Never auto-retry the request; the user confirms again after the redirect |
| `DENY_TENANT_READ_ONLY` | `/http` sets the read-only state; `useReadOnly()` becomes `true` and the UI disables writes |
| `DENY_MALFORMED_IDENTITY` | Sign in again |
| `DENY_UNRESOLVABLE_SUBJECT` | "Your workspace is being set up": retry the session-context load at 6 s, 12 s and 24 s (past AuthZ Enrichment's 5 s negative cache), then "no access to this workspace" with sign-out and switch. Never sign out or clear the cache on your own |
| `DENY_ROLE_INSUFFICIENT`, `DENY_TENDER_ACL_INSUFFICIENT`, … | A normal 403: show the problem message |

The full list, with statuses, is in [`registry.md`](registry.md#gateway-deny-codes).

## Trace correlation

Every `ApiResponse` and `ProblemError` carries the server's `X-Trace-ID` (`traceId`) and the SDK's `requestId`. The trace is the one the SDK propagated in `traceparent` (interop pair 4 checks this). `MFEErrorBoundary`'s fallback shows `traceId` (or `requestId`) as a support reference, and logs the error with the same ids.

## Logging and metrics

| What | How |
|---|---|
| A `ProblemError` that reaches an error boundary | `warn` log `remote showed an error` with `exception.*` (the server already traced it) |
| A render or code error | `error` log `remote failed to render` |
| 5xx, timeouts, network errors | Recorded on the call's span (`recordError`) |
| Every call | One observation of `platform_web_http_client_*` with `status_class` / `error_class` like the server's labels (no-op until Tier 1 is ratified) |

## Security

- The raw body of a non-problem answer is never shown or logged.
- Problem bodies are size-capped before parsing, and extension member names are validated.
- `detail` may contain server-side context: show it only for types that document it as user-facing.
- A gateway denial never signs the user out on its own, except `DENY_MALFORMED_IDENTITY` through the sign-in flow.

## Tests

`/testing`'s `mockProblem(PlatformProblemTypes.NotFound, { errorCode: 'TENDER_NOT_FOUND', traceId })` builds a gincommon-shaped problem response. `mockApi` answers unmatched routes with a 404 `ROUTE_NOT_FOUND`, like gincommon's NoRoute handler.

```ts
const p = createTestPlatform();
mockApi({ 'PUT /tenders/:id': mockProblem(PlatformProblemTypes.ValidationFailed, { validationErrors: [{ field: 'title', message: 'is required' }] }) });
```
