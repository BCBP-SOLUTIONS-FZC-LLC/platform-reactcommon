# Observability

`/tracing` · `/logging` · `/metrics`

The browser's side of the Enterprise Platform Observability Standard: the same field names, redaction rules, sampler and metric registry as platform-gincommon. Everything goes over OTLP/HTTP to the same-origin `/otel` path, so there is one pipeline (no Faro SDK).

| Subpath | What it does | Main exports |
|---|---|---|
| `/tracing` | Spans with Go's trace sampler, so browser and backend agree on which traces to keep; `traceparent` only to the page's origin and allowlisted origins | `initializeTracing`, `getTracer`, `withSpan`, `currentTraceId`, `injectTraceHeaders`, `shutdownTracing` |
| `/logging` | Structured logs with `trace_id`, `request_id`, `session_id`, `mfe` and `page_route`; redaction; consent rules; beacon on page hide | `initializeLogging`, `getLogger`, `setRouteTemplate`, `serializeError` |
| `/metrics` | Domain (Tier 2) and service (Tier 3) metrics checked with `metricslint`'s rules; the browser's platform metrics (Tier 1) once ratified | `initializeMetrics`, `getDomainMeter`, `getServiceMeter`, `startWebVitals`, `InvalidMetricError` |

## How it's used

The shell starts the three exporters once (`initializeTracing`, `initializeLogging`, `initializeMetrics`). Remotes only use them:

```ts
const log = getLogger({ mfe: 'tenders' });
log.info('draft saved', { tender: id });

await withSpan('save draft', () => api.put('/tenders/:id/draft', { params: { id }, body }));

getServiceMeter({ mfe: 'tenders' })
  .counter('tender_management_tenders_drafts_saved_total', 'Drafts saved.', ['outcome'])
  .add(1, { outcome: 'ok' });
```

## Guarantees

- **Correlation:** every log carries the active trace, the request id of the call it's about, and the session id. The server's `X-Trace-ID` joins the browser trace.
- **Redaction:** the same sensitive keys as gincommon; JWT and `Bearer` values masked; URL query strings dropped; stacks capped at 4 KiB.
- **Consent:** only errors and essential warnings leave the page without `telemetry` consent.
- **Bounded:** fixed-size queues that drop the oldest items, at most two sends in flight, no retries into a struggling page.
- **Registry rules at registration time:** a metric name or label that `metricslint` would reject throws in the remote's tests, not in production.

**Not active yet:** the seven `platform_web_*` metrics (HTTP client, remote loads, errors, web vitals) wait for governance to ratify their names (design doc §D5, §D6 K).

Design doc: §C1 `/tracing`, `/logging`, `/metrics`, §D1 (identity), §D5.
