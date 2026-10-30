---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/tracing`: OTLP/HTTP browser tracing with gincommon's resource
attributes and sampler (ParentBased, Go's exact TraceIDRatioBased), a bounded drop-oldest export
queue gated on telemetry consent, `withSpan`, `currentTraceId`, and `injectTraceHeaders` limited
to the page origin and an exact-origin allowlist. The `@opentelemetry/api` peer range is now
`>=1.10.0 <1.11.0`, as required by `@opentelemetry/sdk-trace` 3.
