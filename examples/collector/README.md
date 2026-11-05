# Reference OpenTelemetry Collector (LLD §7.6)

The configuration for the Collector that receives the browser's telemetry. **Nothing here deploys
anything**: Platform observability runs the Collector and takes these files as they are.

| File | What it is |
|---|---|
| `gateway.yaml` | Tier 1, behind the distribution's `/otel/*` (any number of replicas): resource and label allowlists, metric streams routed to one aggregator |
| `aggregator.yaml` | Tier 2: re-stamps each delta with its arrival time, then delta → cumulative for Mimir |
| `test/allowlist.test.ts` | Keeps the gateway's lists equal to the metric registry and the Tier 1 proposal (`pnpm test`) |

`pnpm run test-collector` runs two gateways and two aggregators in the Collector image (Docker; CI job
`collector`).

## What the gateway lets through

`/otel` is unauthenticated (pre-login errors must reach it), so anyone can POST to it. The gateway keeps
what the SDK can send and nothing else:

| What | Kept | Otherwise |
|---|---|---|
| Resource attributes (traces, logs) | `service.name`, `service.version`, `service.namespace`, `deployment.environment.name` | removed |
| Resource attributes (metrics) | none: `domain`, `service` and `environment` are labels; `service.version` would split a series after a deploy, and `service.name` (Prometheus `job`, `target_info`) would let a POST mint series | removed |
| Metric names | a Tier 1 name of the proposal (`platform_web_vitals_seconds`, …), or a `<domain>_*` name matching the `domain` label with a `_total` / `_seconds` / `_bytes` suffix | point dropped |
| Label keys, Tier 1 and Tier 2 (the proposal's and the registry's metric names) | the registry's labels (`contracts/metric-registry.json`) and the Tier 1 proposal's (`page_route`, `mfe`, `vital`, `rating`) | key removed |
| Label keys, Tier 3 (any other `<domain>_<service>_*`) | snake_case keys (≤ 64 characters) that are not prohibited (`user_id`, `email`, `*_id`, `*_token`, …: the registry's list); `domain`, `service`, `environment` and at most 8 others | key removed |
| Label values | the registry vocabulary for `domain`, `vital`, `rating`; the patterns for `service`, `mfe`, `page_route`; this deployment's `environment` | point dropped |
| `page_route` length | at most 64 characters | recorded as `unknown` |
| Any label value | the first 128 characters | cut |

A Tier 3 (service-owned) metric declares its own labels, so the gateway keeps them, but bounds them: at
most 8 besides the const labels, the limit the SDK enforces at registration (`getServiceMeter` throws
`InvalidMetricError`, rule `label_vocabulary`, for a 9th), so a point with more came from something other
than the SDK (with more, which 8 survive is arbitrary); each value is cut at 128 characters.
The SDK itself bounds each Tier 3 label at 100 distinct values per page.

## Set Mimir's series limits too

The allowlists bound what one request can add, not the product of the allowed values (`service` and `mfe`
are patterns, `page_route` is any 64-character template). Set Mimir's per-tenant limits for the tenant the
aggregators write to, so a flood of made-up values is refused at ingestion instead of growing the TSDB:

```yaml
# Mimir runtime configuration (overrides), per tenant
overrides:
  <tenant>:
    max_global_series_per_user: 150000     # all the browser's series; size from the real count plus headroom
    max_global_series_per_metric: 20000    # one metric with a runaway label
```

Alert on `cortex_discarded_samples_total{reason=~"per_user_series_limit|per_metric_series_limit"}`: a
rejected sample means either real growth (raise the limit) or someone POSTing to `/otel`.
