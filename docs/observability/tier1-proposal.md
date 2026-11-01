# Tier 1 browser metrics: registry proposal (platform-reactcommon)

<!-- Generated from monitoring/registry/platform-web.proposal.json, packages/frontend-sdk/contracts/metric-registry.json by `pnpm docs:sync`. Do not edit. -->

platform-reactcommon's entries for the Platform Observability Registry, submitted under the standard's Registry Ratification Requirement. Every entry is `proposed` until observability governance ratifies it; the SDK records none of them until then (its instrument port is a no-op). The submission, the dependencies of each metric and the interim logs-and-traces coverage are in [tier1-ratification.md](tier1-ratification.md).

## Summary

| Metric | Type | Labels (after the required ones) | Status |
|---|---|---|---|
| `platform_web_vitals_seconds` | histogram (seconds, `web_vitals` buckets) | `vital`, `page_route` | proposed |
| `platform_web_vital_ratings_total` | counter | `vital`, `rating`, `page_route` | proposed |
| `platform_web_http_client_duration_seconds` | histogram (seconds, `request_duration` buckets) | `method`, `route`, `status_class`, `error_class`, `mfe` | proposed |
| `platform_web_http_client_failures_total` | counter | `route`, `reason`, `mfe` | proposed |
| `platform_web_remote_load_seconds` | histogram (seconds, `dependency_request` buckets) | `mfe`, `outcome` | proposed |
| `platform_web_remote_load_failures_total` | counter | `mfe`, `reason` | proposed |
| `platform_web_errors_total` | counter | `source`, `mfe` | proposed |

Required labels on every entry, injected centrally by the SDK from the page identity: `domain`, `service`, `environment`.

## New labels

| Label | Meaning | Allowed values | Cardinality |
|---|---|---|---|
| `page_route` | Client router template of the page the measurement was taken on (registered with the SDK's useRouteTemplate, e.g. /t/:slug/tenders/:id/edit), or unknown. Never a URL or path; not the API route. | pattern `^(unknown\|/[A-Za-z0-9_./:*~-]*)$`, at most 500 values | bounded by registered page routes; values past the bound are recorded as unknown |
| `mfe` | Micro-frontend the measurement belongs to: a remote's manifest name, or shell for the shell's own code. Remotes run in the shell's page, so this, not domain, tells them apart. | pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values | bounded by /remotes/manifest.json (plus shell); values not in the manifest are rejected |
| `vital` | Core Web Vital or loading metric, as the web-vitals library names it (lowercase). Each metric declares the subset it uses. | `lcp`, `inp`, `cls`, `ttfb`, `fcp` | fixed |
| `rating` | web-vitals rating of one measurement against Google's published thresholds. | `good`, `needs_improvement`, `poor` | fixed |

## New bucket presets

- `web_vitals`: 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 1.2, 1.8, 2.5, 3, 4, 6, 10 (seconds)

## Metrics

### `platform_web_vitals_seconds`

- **Type:** histogram · **Unit:** seconds · **Buckets:** `web_vitals` · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** One web-vitals measurement of a time-valued vital on a page view: LCP (largest contentful paint), INP (interaction to next paint), TTFB (time to first byte) or FCP (first contentful paint), reported once per page view when the library finalises it (INP and LCP on page hide). CLS is unitless and is reported only in platform_web_vital_ratings_total.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `vital`, `page_route`
  - `vital` (new): `lcp`, `inp`, `ttfb`, `fcp`
  - `page_route` (new): pattern `^(unknown|/[A-Za-z0-9_./:*~-]*)$`, at most 500 values
- **Cardinality:** vital (4) × page_route (≤500 per page identity); 14 buckets.
- **Aggregation:** p75 per page route (the Core Web Vitals assessment percentile): histogram_quantile(0.75, sum by (le, domain, service, environment, vital, page_route) (rate(platform_web_vitals_seconds_bucket[1h]))). Never averaged across vitals.
- **Governance notes:** New platform_* name submitted under the Registry Ratification Requirement. Decision tree: every domain's web shell emits it with identical meaning, so platform_*; web names the runtime, not a service (rule 1). Requests: the new labels vital and page_route, and the bucket preset web_vitals, whose bounds include the web-vitals good/poor thresholds (INP 0.2/0.5 s, TTFB 0.8/1.8 s, FCP 1.8/3 s, LCP 2.5/4 s). Recorded only with the visitor's telemetry consent.

### `platform_web_vital_ratings_total`

- **Type:** counter · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** One web-vitals measurement of a vital on a page view, by the library's rating against Google's thresholds (good, needs_improvement, poor). Every vital is counted, CLS included, so the share of good page views is available for all five.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `vital`, `rating`, `page_route`
  - `vital` (new): `lcp`, `inp`, `cls`, `ttfb`, `fcp`
  - `rating` (new): `good`, `needs_improvement`, `poor`
  - `page_route` (new): pattern `^(unknown|/[A-Za-z0-9_./:*~-]*)$`, at most 500 values
- **Cardinality:** vital (5) × rating (3) × page_route (≤500 per page identity).
- **Aggregation:** Share of good views (the Core Web Vitals pass criterion is ≥ 75 %): sum by (domain, service, environment, vital) (rate(platform_web_vital_ratings_total{rating="good"}[1h])) / sum by (domain, service, environment, vital) (rate(platform_web_vital_ratings_total[1h])).
- **Governance notes:** New platform_* name (Registry Ratification Requirement). Exists because CLS cannot be a histogram under the suffix rule (it has no unit), and because the share of good views is what the Core Web Vitals assessment and the proposed SLO use. Requests the new labels vital, rating and page_route.

### `platform_web_http_client_duration_seconds`

- **Type:** histogram · **Unit:** seconds · **Buckets:** `request_duration` · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** Wall time of one logical API call made by the browser through the SDK's HTTP client, from the call to its result, retries and token refresh included, as the user experiences it. Calls that ended with no HTTP status are classified like the server's: a caller abort as 4xx/client_error, a timeout or network failure as 5xx/server_error, and are also counted in platform_web_http_client_failures_total.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `method`, `route`, `status_class`, `error_class`, `mfe`
  - `method` (existing): `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `CONNECT`, `TRACE`, `OTHER`
  - `route` (existing): pattern `^(unknown|/[A-Za-z0-9_./:*~-]*)$`, at most 1000 values
  - `status_class` (existing): `2xx`, `4xx`, `5xx`
  - `error_class` (existing): `success`, `client_error`, `server_error`
  - `mfe` (new): pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values
- **Cardinality:** method (≤5 used) × route (API templates the page calls, ≤1000) × status_class (3) × mfe (≤100); the realistic product is far smaller, since a route is called by one or two mfes with one or two methods.
- **Aggregation:** Same shape as platform_http_request_duration_seconds, so browser and server latency compare per route: histogram_quantile(0.95, sum by (le, domain, service, environment, route) (rate(platform_web_http_client_duration_seconds_bucket[5m]))). Error ratio: sum(rate(..._count{status_class="5xx"}[5m])) / sum(rate(..._count[5m])).
- **Governance notes:** New platform_* name (Registry Ratification Requirement). Reuses method, route, status_class and error_class with the server's vocabularies. Requests: (1) the existing route label's description be widened from 'Gin route template' to 'route template of the HTTP request (server: the router template; browser: the SDK call template relative to the API base URL)', which is the same value when the gateway strips the /api prefix; (2) the new label mfe. Recorded only with telemetry consent.

### `platform_web_http_client_failures_total`

- **Type:** counter · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** A browser API call (as in platform_web_http_client_duration_seconds) that ended with no HTTP status, by reason: timeout (the SDK's deadline), network (the request failed below HTTP: offline, DNS, TLS, connection reset, CORS) or aborted (the caller cancelled it, e.g. the user navigated away). The server never sees these, so they exist only on the client.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `route`, `reason`, `mfe`
  - `route` (existing): pattern `^(unknown|/[A-Za-z0-9_./:*~-]*)$`, at most 1000 values
  - `reason` (existing): `timeout`, `network`, `aborted`
  - `mfe` (new): pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values
- **Cardinality:** route (≤1000) × reason (3) × mfe (≤100), sparse.
- **Aggregation:** sum by (domain, service, environment, route, reason) (rate(platform_web_http_client_failures_total[5m])); compare with the call rate from platform_web_http_client_duration_seconds_count. aborted is expected and is excluded from error ratios.
- **Governance notes:** New platform_* name (Registry Ratification Requirement). reason takes a per-metric enum, as the existing reason label's description requires. Requests the new label mfe.

### `platform_web_remote_load_seconds`

- **Type:** histogram · **Unit:** seconds · **Buckets:** `dependency_request` · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** Wall time to load one micro-frontend module for the page (the SDK's loadRemote: manifest entry, remoteEntry.js with its integrity check, share negotiation, module evaluation), retries included, by outcome: success; failure, the remote is switched off by its kill switch; error, it could not be loaded.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `mfe`, `outcome`
  - `mfe` (new): pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values
  - `outcome` (existing): `success`, `failure`, `error`
- **Cardinality:** mfe (≤100) × outcome (3).
- **Aggregation:** Availability per remote: sum by (domain, service, environment, mfe) (rate(platform_web_remote_load_seconds_count{outcome="success"}[5m])) / sum by (domain, service, environment, mfe) (rate(platform_web_remote_load_seconds_count{outcome!="failure"}[5m])). Latency: histogram_quantile(0.95, sum by (le, mfe) (rate(platform_web_remote_load_seconds_bucket{outcome="success"}[15m]))).
- **Governance notes:** New platform_* name (Registry Ratification Requirement). Uses the existing outcome label with its standard meanings and the existing dependency_request preset (a remote is a dependency the page loads). Requests the new label mfe. Recorded only with telemetry consent; a failed load is also always logged (remote failed to load).

### `platform_web_remote_load_failures_total`

- **Type:** counter · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** A micro-frontend load that did not succeed, by reason: disabled (kill switch; outcome failure), timeout, network (entry script or chunk could not be fetched, integrity mismatch included), aborted (the caller cancelled it), incompatible (share negotiation refused the remote's SDK or React version, or the module failed to evaluate).
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `mfe`, `reason`
  - `mfe` (new): pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values
  - `reason` (existing): `disabled`, `timeout`, `network`, `aborted`, `incompatible`
- **Cardinality:** mfe (≤100) × reason (5), sparse.
- **Aggregation:** sum by (domain, service, environment, mfe, reason) (rate(platform_web_remote_load_failures_total[5m])). incompatible after a release means the remote was built against a newer SDK than the shell provides.
- **Governance notes:** New platform_* name (Registry Ratification Requirement). reason takes a per-metric enum. Requests the new label mfe.

### `platform_web_errors_total`

- **Type:** counter · **Tier:** platform · **Status:** proposed · **Owner:** platform-reactcommon
- **Semantic definition:** An error the SDK captured in the page, by capture point (source): unhandled_error (window error event), unhandled_rejection (unhandledrejection event), boundary (an error a React error boundary caught), chunk_load (a script chunk of the current build could not be loaded; the page reloads once to pick up the new build). One count per error.
- **Required labels:** `domain`, `service`, `environment`
- **Labels:** `source`, `mfe`
  - `source` (existing): `unhandled_error`, `unhandled_rejection`, `boundary`, `chunk_load`
  - `mfe` (new): pattern `^[a-z][a-z0-9_-]{0,62}$`, at most 100 values
- **Cardinality:** source (4) × mfe (≤100).
- **Aggregation:** sum by (domain, service, environment, mfe, source) (rate(platform_web_errors_total[5m])). Normalise per page view with sum(rate(platform_web_vital_ratings_total{vital="ttfb"}[5m])), which counts every consented page view once.
- **Governance notes:** New platform_* name (Registry Ratification Requirement). Requests the new label mfe. Decision for governance: the existing source label is described as 'origin system of a change or event'; this metric uses it for the capture point of an error. If governance holds that to be a different meaning, the alternative is a new label capture with the same four values.

## Amendments to existing entries

- `platform_telemetry_label_overflow_total`: label `label` gains `page_route`, `mfe`. platform-reactcommon is added as an emitter of the existing metric (rule 7: prefer the shared metric). The SDK replaces a page_route that is not a registered template, or one past its bound, with unknown, and counts each replacement here. The label vocabulary of label grows by page_route and mfe; the help text, written for event_type, should be generalised to 'a label value replaced because it exceeded its cardinality bound'.
- Label `route`: description becomes "Route template of the HTTP request: the server's router template (e.g. /api/items/:id), or the browser SDK's call template relative to the API base URL; unknown for unmatched requests. Never the raw URL path." Widens the meaning to the browser client's call template (platform_web_http_client_*), without changing any server value.
