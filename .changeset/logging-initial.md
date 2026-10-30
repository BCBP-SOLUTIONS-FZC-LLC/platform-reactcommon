---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/logging`: OTLP browser logs with gincommon's field names (`trace_id`,
`span_id`, `request_id`, `session_id`, `mfe`, `page_route`), redaction (sensitive keys, control
characters, JWT and Bearer credentials, URL query strings in stacks), consent gating (`error` and
`warn` with `essential: true` always; the rest need telemetry consent), batching with `sendBeacon`
on page hide, `serializeError` and `setRouteTemplate`. `/tracing`'s export queue now applies real
backpressure: at most two sends in flight, the oldest spans dropped when the queue is full.
