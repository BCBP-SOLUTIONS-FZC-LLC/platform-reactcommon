---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/http`: `createApiClient` with the fixed request pipeline (offline
check, encoded route params, forbidden identity headers refused, request id, trace context,
session id and token on the page origin only, idempotency key on POST, client deadline), the
401 path through the token source's single refresh, retries with backoff and Retry-After for
idempotent calls, shared concurrent GETs, problem parsing and metrics through the instrument
port. `injectTraceHeaders` takes an optional span, so retries stay in the request's trace.
