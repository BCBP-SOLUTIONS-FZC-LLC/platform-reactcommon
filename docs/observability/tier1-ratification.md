# Tier 1 browser metrics: submission for ratification

**To:** observability governance · **From:** platform-reactcommon (`@bcbp-solutions-fzc-llc/frontend-sdk`) · **Status:** submitted, awaiting ratification · **Standard:** Enterprise Platform Observability Standard, Registry Ratification Requirement

The web shells and their micro-frontends have no platform metrics today. This submission proposes seven `platform_web_*` metrics, four labels, one bucket preset and two amendments to existing entries. Each entry gives the semantic definition, the required labels, the allowed label values and the aggregation expectations. It also lists the dashboards, alerts, recording rules and SLOs that depend on each metric, and what each metric depends on. Nothing is emitted until you ratify it: the SDK records these through an internal instrument port that is a no-op, and every rule that depends on them carries `metric_status: proposed`.

| What | Where |
|---|---|
| The registry entries (gincommon's `registry.json` schema; merged as-is once ratified) | [`monitoring/registry/platform-web.proposal.json`](../../monitoring/registry/platform-web.proposal.json) |
| The same entries, readable: one section per metric | [`tier1-proposal.md`](tier1-proposal.md) (generated) |
| Dashboard | [`monitoring/grafana/platform-web.json`](../../monitoring/grafana/platform-web.json) |
| Recording rules, alerts, SLOs | [`monitoring/prometheus/platform-web.rules.yml`](../../monitoring/prometheus/platform-web.rules.yml), unit-tested in `platform-web.rules.test.yml` |
| Runbooks | [`runbooks.md`](runbooks.md) |

## 1. Validation already done

The submission is checked with the same tools governance uses, and in CI:

| Check | Tool | Result |
|---|---|---|
| The candidate registry (gincommon's `registry.json` at the pinned commit + this proposal) is a valid registry document | `metricslint registry` | ✅ 122 metrics, 30 labels |
| A scrape of every proposed metric, with every allowed label value and the injected `domain`/`service`/`environment` | `metricslint check -strict` (candidate registry) | ✅ |
| The same scrape against today's registry | `metricslint check` (pinned registry) | ✗, as expected: every name is new; none is already ratified |
| The dashboard and rules reference only registered or proposed metrics | `metricslint refs` | ✅ |
| Rules depending on proposed metrics are in `*.proposed` groups with `metric_status: proposed`; every alert has a runbook; label matchers stay in each metric's vocabulary; every proposed metric is used by a dashboard and a rule; the proposal's enums equal what the SDK records | `test/unit/monitoring` (Vitest) | ✅ |
| Rule syntax and alert unit tests (8 scenarios, including no-alert cases) | `promtool check rules`, `promtool test rules` | ✅ |
| Dashboard PromQL syntax | `promtool` (platform-events' `dashboard-promql.sh`) | ✅ |

Run locally: `pnpm metrics:proposal` (Go and the gincommon checkout), `pnpm test`, `pnpm run rules-check`, `pnpm run dashboards-check` (Docker). `pnpm metrics:proposal --emit registry.json` writes the candidate `registry.json` for the registry PR.

## 2. Decisions requested

| # | Decision | Our proposal |
|---|---|---|
| 1 | Ratify the seven metrics | `platform_web_vitals_seconds`, `platform_web_vital_ratings_total`, `platform_web_http_client_duration_seconds`, `platform_web_http_client_failures_total`, `platform_web_remote_load_seconds`, `platform_web_remote_load_failures_total`, `platform_web_errors_total` |
| 2 | Approve four labels | `page_route` (pattern, ≤ 500), `mfe` (pattern, ≤ 100), `vital` (5 fixed), `rating` (3 fixed) |
| 3 | Approve the bucket preset `web_vitals` | 0.05 … 10 s, including the web-vitals good/poor thresholds |
| 4 | Widen the existing `route` label's description | "route template of the HTTP request: the server's router template, or the browser SDK's call template"; no server value changes |
| 5 | Add the SDK as an emitter of `platform_telemetry_label_overflow_total` | `label` gains `page_route` and `mfe` (rule 7: reuse the shared metric). Its help text, written for `event_type`, should be generalised |
| 6 | `source` on `platform_web_errors_total` | The existing label means "origin system of a change or event"; we use it for the error's capture point. If that is a different meaning, we will use a new label `capture` with the same four values |
| 7 | Per-metric enums for the existing pattern labels | `reason` (two enums) and `source` (one), as the labels' descriptions require; listed in the entries |
| 8 | The population these metrics describe | Metrics leave the page only with the visitor's `telemetry` consent. The SLOs below are measured over consenting visitors. We think that is acceptable, since the alternative is not measuring at all, but it is your call |

### Why `platform_*` (the decision tree)

Each metric describes something every domain's web shell does in the same way: render pages (vitals), call APIs through the gateway, load micro-frontends, catch errors. IAM administration, tender management, workflow design and billing UIs all run in shells built on the same SDK, so the answer to question 1 is yes, and the namespace is `platform_*`. `web` names the runtime, not a service (rule 1). The page's `domain`, `service` and `environment` are injected centrally by the SDK from `initializeCore` (rule 8). Remotes are told apart by `mfe`, never by a second `domain`. A remote's own business metrics remain Tier 2/3 under its owning domain (`getDomainMeter`, `getServiceMeter`), and need no decision here.

High-cardinality values never become labels: no URLs, user, tenant, session or request ids. `page_route` and `route` are templates; `mfe` must be in the remote manifest. Values past a bound become `unknown` and are counted in the overflow metric.

## 3. Dependencies

### What each metric depends on before it can be emitted

| Dependency | Needed by | State |
|---|---|---|
| This ratification, then the registry PR in platform-gincommon (re-vendored by platform-fastapicommon) and `pnpm contracts:sync --update-pins` here | all seven | waiting |
| The Tier 1 binding in `/metrics`: replace the no-op instrument port with real instruments (design doc step 15) | all seven | waiting on ratification; `/http`, `/mfe` and `/react` already record through the port |
| `startWebVitals()`: today an empty function. Needs the `web-vitals` library, a new runtime dependency of about 2 KB gzipped for every page | `platform_web_vitals_seconds`, `platform_web_vital_ratings_total` | not started |
| **A metrics flush on page hide.** The metrics exporter sends every 60 s and has no page-hide flush, but LCP, INP and CLS are final only when the page is hidden, so without it most vitals would be lost. It shares the 64 KiB keepalive budget with spans and log beacons (known browser bug 1, `test/browser/known-bugs.ts`) | vitals mostly; the last interval of all seven | not started |
| Route templates registered with `useRouteTemplate` in the shell and remotes | `page_route` | in place; unregistered routes become `unknown` and fire `PlatformWebLabelOverflow` |
| `/remotes/manifest.json` | `mfe` | in place |
| The CMP granting `telemetry` consent (`setConsentProvider`) | all seven | per shell; the example shell grants only `essential` |
| OTel Collector: the `/otel/v1/metrics` receiver path, `deltatocumulative`, the label allowlists extended with `page_route`, `mfe`, `vital` and `rating`, and the per-browser resource attributes dropped | all seven | the `/otel/v1/metrics` receiver path is verified in the integrated E2E run; `deltatocumulative` and the allowlists are specified (design doc §C1 `/metrics`) but configured nowhere yet: the E2E Collector has neither, and the platform Collector is not deployed |
| CloudFront `/otel/*` behaviour (POST only, 1 MB) and the WAF rate rule | all seven | in the reference distribution (`examples/cloudfront`) |
| The server's `platform_http_request_duration_seconds` with the same buckets and route templates | the browser-vs-server latency panel | in gincommon (proposed); the route templates match when the gateway strips `/api` (verified in the E2E run: `/api/tenders/1` reaches gincommon as `/tenders/:id`) |

### What depends on each metric

| Metric | Dashboard panels | Recording rules | Alerts | SLO |
|---|---|---|---|---|
| `platform_web_remote_load_seconds` | Remote load availability, Remote load time (p95); the `$mfe` variable | `platform_web:remote_load_error_ratio:rate5m`, `:rate1h`, `platform_web:remote_loads:rate1h`, `platform_web:remote_load_seconds:p95_15m` | `PlatformWebRemoteLoadErrorBudgetBurn` (critical) | Remote availability 99.9% |
| `platform_web_remote_load_failures_total` | Remote load failures by reason | — | `PlatformWebRemoteIncompatible` (warning) | — |
| `platform_web_http_client_duration_seconds` | API error ratio, Browser vs server latency per route | `platform_web:http_client_error_ratio:rate5m`, `:rate1h`, `platform_web:http_client_calls:rate1h`, `platform_web:http_client_duration_seconds:p95_5m` | `PlatformWebApiErrorBudgetBurn` (warning) | Browser API success 99.5% |
| `platform_web_http_client_failures_total` | Calls with no HTTP status, by reason | `platform_web:http_client_failures:rate5m` | — (inside the API SLI) | — |
| `platform_web_vital_ratings_total` | Share of good page views; the `$domain`/`$service`/`$environment` variables | `platform_web:vital_good_ratio:rate1h`, `platform_web:vital_ratings:rate1h` | `PlatformWebCoreWebVitalFailing` (warning) | Core Web Vitals ≥ 75% good (LCP, INP, CLS) |
| `platform_web_vitals_seconds` | Vitals p75, Slowest pages | `platform_web:vitals_seconds:p75_1h` | — | — |
| `platform_web_errors_total` | Errors by capture point, Errors by micro-frontend | `platform_web:errors:rate5m` | `PlatformWebChunkLoadErrors` (warning) | — |
| `platform_telemetry_label_overflow_total` (amended) | Label values replaced | — | `PlatformWebLabelOverflow` (info) | — |

HPA references: none. The web tier is static content on S3 and CloudFront, with nothing to scale.

### Proposed SLOs

| SLO | SLI | Objective (30 days) | Burn alert |
|---|---|---|---|
| Remote availability | successful loads ÷ loads attempted, per `mfe` (kill-switched loads excluded) | 99.9% | 14.4× over 1 h and 5 min, ≥ 1 load/min |
| Browser API success | calls without a 5xx, timeout or network failure ÷ calls (caller aborts excluded) | 99.5% | 14.4× over 1 h and 5 min, ≥ 1 call/s; warning, because the backend SLOs page for their own 5xx |
| Core Web Vitals | page views rated good ÷ rated views, per vital | ≥ 75% (Google's assessment) | below 75% for 1 h, ≥ ~180 views/h |

## 4. After ratification

1. Registry PR in platform-gincommon with the candidate entries (`pnpm metrics:proposal --emit`), `status` set to `approved`; then re-vendor into platform-fastapicommon.
2. Here: `pnpm contracts:sync --update-pins`, which moves the entries into [`metric-registry.md`](metric-registry.md).
3. SDK: bind the instrument port in `/metrics`, implement `startWebVitals()` with `web-vitals`, and add the metrics flush on page hide (§3), each with real-browser tests.
4. Collector: add the four labels to the allowlists.
5. Rules: move the rules from `platform_web.proposed.*` into `platform_web.recording` / `platform_web.alerts`, and drop `metric_status: proposed`. `test/unit/monitoring` enforces the split, so the move fails CI until the registry shows the metrics as approved.

## 5. Interim visibility: logs and traces

Until the metrics are bound, can logs and traces alone run the web tier? **For failures, yes; for SLOs and performance, no.** Every failure mode below now leaves the page without consent and can be alerted on by count; the three log gaps found in this assessment are fixed (see Gaps). They are not enough for ratio SLOs, latency or page speed (web vitals), which need the metrics.

The evidence comes from the integrated E2E run ([`docs/e2e/integrated-deployment-report.md`](../e2e/integrated-deployment-report.md)) and the real-browser suite (`test/browser`):
- **Errors without consent:** with only `essential` consent, error logs reached the Collector, including `remote failed to load` with `mfe` and `reason`.
- **Spans without consent:** no browser spans left the page.
- **Traces still join up:** the backend spans (Envoy, AuthZ Enrichment, org-membership, gincommon) carried the browser's trace id, because `traceparent` is sent either way. A problem shown to the user carries `traceId` and `requestId`, which match the backend's logs.
- **With consent:** spans, logs and metrics are exported in Chromium, Firefox and WebKit.

What leaves the page depends on consent:

| Signal | Without `telemetry` consent | With it |
|---|---|---|
| `error` logs | ✅ always | ✅ |
| `warn` logs marked essential (identity header dropped, CSP violation, API call with no response, chunk-load reload, sign-in and session warnings) | ✅ always | ✅ |
| other `warn` and `info` logs | ✗ | ✅ (≥ `telemetry.logLevel`) |
| spans | ✗ | ✅, sampled at `telemetry.sampleRatio` (default 10%) |
| backend spans continuing the browser's trace | ✅ (`traceparent` is sent either way) | ✅ |

### Operational questions

| Question | Logs and traces today | Enough? |
|---|---|---|
| Is a remote failing to load, and why? | `remote failed to load` (error: `mfe`, `reason`), `remote dropped from the manifest` (error) | ✅ for detection and cause. No denominator, so a ratio and an SLO aren't possible; alert on counts |
| Are pages crashing? | `uncaught error`, `unhandled promise rejection`, `remote failed to render` (error, with `mfe` and the stack) | ✅ counts and stacks; no rate per page view |
| Did a deploy break chunk loading? | `chunk load failed: reloading` (essential warn, `version`, the chunk in `exception.message`) | ✅ (gap 1, fixed) |
| Are API calls failing for users? | backend 5xx: ✅ in the services' own logs and metrics. Timeouts and network failures the server never saw: `api call got no response` (essential warn: `route`, `reason`, `request_id`, `mfe`; ≤ 10 a minute per page, `suppressed` counts the rest; offline is not logged) | ✅ by count (gap 2, fixed); no ratio without a call count |
| How slow are API calls for users? | sampled, consented `HTTP <method>` spans (`url.template`, status); the server's own latency | ⚠️ diagnosis only, no client-side percentiles |
| How fast do pages render (LCP, INP, CLS)? | nothing | ✗ **Gap 3**, until the vitals metrics ship |
| Are sessions ending or sign-ins failing? | errors ✅ (`sign-in callback rejected`, `token refresh failed`); essential warnings: `session ended` when Keycloak ended a live session, `sign-in failed`, `sign-in callback ignored`, `workspace resolve failed`, the refresh-restore warnings | ✅ (gap 4, fixed). A routine end (lifetime unknown) stays an info log |
| CSP violations? | essential warning in the page, and the `/csp-report` Lambda for violations before boot | ✅ |
| Trace one user's problem end to end? | `traceId`/`requestId` on the problem and in the logs, and the backend spans | ✅ |

### Gaps

Three of the four gaps are closed in the SDK; none needed governance, because they add or reclassify log lines and use no metric names. `test/integration/essential-logs.test.ts` boots the SDK with only `essential` consent, as the example shell does, and asserts each line below leaves the page while routine events stay consent-gated.

1. **Chunk-load reloads:** fixed. An essential warning `chunk load failed: reloading` (`version`, the chunk in `exception.message`) is logged before the reload, and the reload's page hide sends it.
2. **Client-only API failures (timeout, network):** fixed. An essential warning `api call got no response` per failed call (`method`, `route` template, `reason`, `request_id`, `mfe`). It is capped at 10 a minute per page, and the next one after the window carries `suppressed`, so a flaky connection cannot flood the pipeline. Offline failures, caller aborts and HTTP error answers are not logged: the server logs its own answers.
3. **No vitals:** open. No interim substitute exists; this needs the metrics.
4. **Session and sign-in warnings:** fixed. `sign-in failed`, `sign-in callback ignored`, `workspace resolve failed` and both refresh-restore warnings are essential, and so is `session ended` when Keycloak ended a live session. A routine end is still an info log.

So logs alone can now alert on every failure mode in the table above by counts. Only ratios, latency and page speed wait for the metrics. Alert on counts of those log lines per `service` and `mfe`, for example in Loki: `sum by (mfe, reason) (count_over_time({service_name="web-app"} |= "remote failed to load" [5m]))`, assuming the Collector exports to Loki with native OTLP.
