# Enterprise Platform Observability Standard — frontend SDK implementation

This repository is where the standard is implemented for the browser: the shell and every remote.

| Piece | Location |
|---|---|
| Dashboards, alert and recording rules, SLOs, the Tier 1 registry proposal | [`monitoring/`](../../monitoring) (as platform-events and platform-pgcommon) |
| Platform Observability Registry (the SDK's copy, generated) | [`contracts/metric-registry.json`](../../packages/frontend-sdk/contracts/metric-registry.json), rendered as [`metric-registry.md`](metric-registry.md); source of truth: platform-gincommon `internal/obsregistry/registry.json` |
| Page identity (`domain`, `service`, `environment`) | `/core` `initializeCore` (registry vocabulary); the shell is `domain: 'portal'` (design doc §D1) |
| Domain-shared metrics (Tier 2, registry-driven) | `/metrics` `getDomainMeter({ mfe })` |
| Service-specific metrics (Tier 3, validated) | `/metrics` `getServiceMeter({ mfe })` |
| Browser platform metrics (Tier 1, `platform_web_*`) | Proposed; recorded through the instrument port and bound once ratified (§D5, §D6 K) |
| Compliance checks for a remote's CI | `/testing` `renderMetricInventory()` → gincommon `metricslint check` |
| Parity of the SDK's checks with `metricslint` | `pnpm metrics:parity` (CI: *Validate / Contracts*) |
| Logs and traces | `/logging`, `/tracing`: OTLP/HTTP to `/otel`, gincommon's field names, redaction and sampler |
| Moving an existing app onto the SDK | [`migration.md`](migration.md) |
| Runbooks | [`runbooks.md`](runbooks.md) |

## One pipeline

All three signals leave the page over **OTLP/HTTP** (JSON) to the same-origin `/otel` path. CloudFront forwards it to the OTel Collector. There is no Faro SDK and no second pipeline. Export is:
- **consent-gated** (see [Consent](#consent));
- **bounded:** queues drop their oldest items, and at most two sends are in flight;
- **never retried:** a failed batch is counted and dropped, so a struggling collector never costs the page more memory or requests.

| Signal | Batching | Page hide |
|---|---|---|
| Traces | batch 512, every 5 s, queue 2048 | the newest spans in one keepalive request, the rest through the batcher |
| Logs | batch 50, every 5 s, queue 1000 | the newest records in one `navigator.sendBeacon`, the rest by fetch |
| Metrics | every 60 s, **delta** temporality | the interval, collected then, in one `navigator.sendBeacon` |

Only keepalive requests (sendBeacon, fetch `keepalive`) outlive a closing tab, and the browser allows
64 KiB of them in flight per page. The three signals share one 60 KiB budget (`src/internal/unload.ts`):
on hide and on `pagehide`, logs first, then spans; both leave the metrics interval its share, sized
from the last interval it sent (1–8 KiB), because metrics are collected asynchronously and send last.

The Collector runs as two tiers. The reference configuration is `examples/collector`, tested in the
real Collector image by `pnpm test-collector` (CI job `collector`) and used by the integrated stack:
- **gateway** (`gateway.yaml`, behind `/otel/*`, any number of replicas):
  - keeps only the SDK's resource attributes (`service.name`, `service.version`, `service.namespace`, `deployment.environment.name`), because anyone can POST to `/otel`: per-browser or made-up ones (`service.instance.id`, `browser.*`, `user_agent.*`, …) are removed;
  - allowlists metric names (a Tier 1 name of the proposal, or a `<domain>_*` name matching the `domain` label, with a unit suffix);
  - allowlists label keys: on a Tier 1 or Tier 2 metric the registry's and the Tier 1 proposal's; on a Tier 3 metric snake_case keys that are not prohibited, at most 8 besides `domain`, `service`, `environment`;
  - allowlists label values (the registry vocabulary, this deployment's environment), records a `page_route` over 64 characters as `unknown`, and cuts any value at 128 characters;
  - routes every point of one metric stream to the same aggregator (`loadbalancing`, `routing_key: streamID`).
- **aggregator** (`aggregator.yaml`): stamps each delta with the time it arrived, then converts delta to
  cumulative (`delta_to_cumulative`) for Mimir. The conversion keeps each stream's running total in one
  Collector's memory, so two Collectors converting the same stream would write two different totals for one
  series; hence the routing. Device clocks are not trusted: with the browser's own timestamps, a slow clock
  or a late beacon had its points dropped silently.
- `examples/collector/test` keeps the gateway's allowlists equal to the metric registry: a domain added
  there must reach the gateway too.
- The allowlists bound what one request adds, not the product of allowed values: set Mimir's per-tenant
  series limits as well (`examples/collector/README.md`).

## Identity

Every signal carries the **page** identity set once by the shell. The OTel resource has `service.name`, `service.version`, `service.namespace` (= `domain`) and `deployment.environment.name`; metrics have the const labels `domain`, `service` and `environment`.

Remotes run in the shell's page, so they don't have their own `domain`. They are told apart by `mfe`:
- the `mfe` log attribute (`getLogger({ mfe })`, or automatically inside an `MFEErrorBoundary`);
- the `mfe` span attribute;
- the `mfe` metric label on Tier 1.

The one exception is a remote's **own** Tier 2/3 metrics. `metricslint` requires them to carry the domain they are namespaced under, so their `domain` is the remote's manifest `ownerDomain` and their `service` is the remote's name.

## Tiers

| Tier | Namespace | Who may add a metric | SDK constructor |
|---|---|---|---|
| 1 — platform-shared | `platform_*` (`platform_web_*` for the browser) | Observability governance only (registry PR) | none; the SDK records them itself |
| 2 — domain-shared | `<domain>_*` | Governance with the domain's owners (registry PR) | `getDomainMeter({ mfe })` |
| 3 — service-specific | `<domain>_<service>_*` | The team, no registry entry | `getServiceMeter({ mfe })` |

```ts
import { getServiceMeter } from '@bcbp-solutions-fzc-llc/frontend-sdk/metrics';

// In the tenders remote (ownerDomain tender_management, service tenders):
const drafts = getServiceMeter({ mfe: 'tenders' }).counter('tender_management_tenders_drafts_saved_total', 'Drafts saved.', ['outcome']);
drafts.add(1, { outcome: 'ok' });
```

**Registration checks.** These are the same rules as `metricslint`, run when a metric is created, so a violation fails the remote's tests, not production:
- the name pattern and namespace for the tier;
- `_total` on counters;
- `_seconds` or `_bytes` on histograms;
- no prohibited labels (`user_id`, `tenant_id`, `request_id`, `trace_id`, `ip`, `path`, …) or suffixes (`_id`, `_email`, `_ip`, `_uuid`, `_token`);
- registry label values;
- known bucket presets;
- no reuse of a legacy name.

A violation throws `InvalidMetricError`. A Tier 3 label keeps at most 100 distinct values; further values become `__other__`.

## Tier 1 browser metrics (proposed)

Recorded through an internal instrument port by `/http`, `/mfe` and `/react`, so those subpaths never import metric names. The port is a no-op until governance ratifies the names (design doc §D5, §D6 K). Ratifying them adds them to the registry, and from then they appear in [`metric-registry.md`](metric-registry.md).

- **The submission:** [tier1-ratification.md](tier1-ratification.md). It covers the decisions requested, the dependencies of each metric (what it needs and what uses it), the proposed SLOs, and how far logs and traces go in the meantime.
- **The entries:** [tier1-proposal.md](tier1-proposal.md), generated from [`monitoring/registry/platform-web.proposal.json`](../../monitoring/registry/platform-web.proposal.json). That file is in gincommon's registry schema and is merged as-is once ratified.
- **What uses them:**
  - the dashboard [`monitoring/grafana/platform-web.json`](../../monitoring/grafana/platform-web.json);
  - the rules [`monitoring/prometheus/platform-web.rules.yml`](../../monitoring/prometheus/platform-web.rules.yml). They are all in `*.proposed` groups with `metric_status: proposed` until ratification;
  - the runbooks in [runbooks.md](runbooks.md).
- **Label notes:**
  - **CLS** is unitless, so it appears only in the ratings counter.
  - **`route`** is always the call's template, and `page_route` is a template registered with `useRouteTemplate` (else `unknown`), so raw URLs never become labels.
- **Units** are set (`s`, `1`), so the OTLP → Prometheus translation keeps the registry name exactly.

## Logs

| Field | Source |
|---|---|
| `trace_id`, `span_id` | the active span |
| `request_id` | `attrs.request_id` (the `/http` call's id) |
| `session_id` | the RUM session id (`x-session-id`) |
| `mfe` | the logger's scope, `shell` by default |
| `page_route` | the registered route template, else `unknown` |
| `exception.type`, `exception.message`, `exception.stacktrace` | `attrs.error` through `serializeError` (stack ≤ 4 KiB) |
| `exception.cause` | the error's cause chain, "Type: message ← Type: message" (three deep, redacted, ≤ 1 KiB) |

Every other attribute is redacted with gincommon's rules (`contracts/redaction.json`):
- sensitive keys become `[REDACTED]`;
- JWT and `Bearer` values are masked;
- URL query strings and fragments are removed;
- control characters are stripped.

The SDK's own log events are listed in the [LLD §11.1](../lld/platform-reactcommon-lld.md#111-log-event-catalogue).

## Traces

The `ParentBased` sampler uses **Go's `TraceIDRatioBased` algorithm** for roots (`telemetry.sampleRatio`, default 0.1). So a trace started in the browser and one started by a Go service make the same decision for the same trace id.

`traceparent` / `tracestate` go only to the page's origin and to the exact origins in the allowlist. The server's `X-Trace-ID` echo is returned on every `ApiResponse` and `ProblemError`, and the interop tests check it equals the trace the SDK sent.

## Consent

| Category | Allows |
|---|---|
| `essential` (always granted) | `error` logs and the `warn` logs marked `essential: true`: operational events with no personal data (forbidden header dropped, CSP violation, API call with no response, chunk-load reload, sign-in and session warnings; [LLD §11.1](../lld/platform-reactcommon-lld.md#111-log-event-catalogue)) |
| `telemetry` | all logs at or above `telemetry.logLevel`, spans, metrics |
| `analytics` | nothing in the SDK today (reserved for product analytics) |

`setConsentProvider(cmp)` runs before any exporter. Without it, only `essential` is granted. Withheld spans are counted and dropped, and a withheld metrics interval is discarded (delta, so nothing piles up).

## CI enforcement

| Check | Where |
|---|---|
| The registry copy equals what the pinned gincommon commit generates | `pnpm contracts:check` (*Validate / Contracts*) |
| The SDK's registration checks agree with `metricslint` | `pnpm metrics:parity` (*Validate / Contracts*) |
| The SDK's own inventory passes `metricslint check -strict` | `pnpm metrics:parity` |
| The Tier 1 proposal, merged into the pinned registry, passes `metricslint registry` and `check -strict`; `monitoring/` references only registered or proposed metrics (`metricslint refs`) | `pnpm metrics:proposal` (*Validate / Contracts*) |
| Dashboards and rules: label vocabulary, `*.proposed` groups, runbooks, every proposed metric used, enums equal to the SDK's | `test/unit/monitoring` (`pnpm test`) |
| Rules: `promtool check` and alert unit tests; dashboards: PromQL syntax | `pnpm run rules-check`, `pnpm run dashboards-check` (*Validate / Quality*) |
| `metric-registry.md` is current | `pnpm docs:check` (*Validate / Quality*) |
| A remote's metrics | In the remote's CI: `renderMetricInventory()` piped to `metricslint check` |

## Changing the registry (governance)

The SDK never edits the registry:
1. A new Tier 1 or Tier 2 metric goes to platform-gincommon's `registry.json` by registry PR, and is re-vendored by fastapicommon.
2. After it's released, `pnpm contracts:sync --update-pins` moves the SDK's pin, and `pnpm docs:sync` regenerates [`metric-registry.md`](metric-registry.md).

The `portal` domain followed this path: gincommon #51 (v2.3.0), then fastapicommon #50.

### Items awaiting ratification

Submitted in [tier1-ratification.md](tier1-ratification.md), which also lists two amendments: widening `route`'s description, and the `source` question.

| Item | Design doc |
|---|---|
| The seven `platform_web_*` metrics ([tier1-proposal.md](tier1-proposal.md); `proposed`, `owner: platform-reactcommon`) | §C1 `/metrics`, §D5 |
| Four new labels: `page_route`, `mfe`, `vital`, `rating` (the existing `reason`, `outcome` and `source` labels take the per-metric enums above) | §C1 `/metrics`, §D5 |
| The `web_vitals` bucket preset | §D5 |
| The SDK as an emitter of `platform_telemetry_label_overflow_total` | §D5 |
