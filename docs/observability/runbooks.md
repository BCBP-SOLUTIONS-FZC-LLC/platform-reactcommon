# Runbooks: frontend symptoms and the proposed web alerts

The browser's Tier 1 metrics (`platform_web_*`) are **proposed** (submission: [tier1-ratification.md](tier1-ratification.md)). Their alerts are written and tested (`monitoring/prometheus/platform-web.rules.yml`), but carry `metric_status: proposed` and evaluate to nothing until governance ratifies the names and the SDK binds them. Until then each section below also says how to see the same problem in **logs and traces**, which carry `trace_id`, `request_id`, `session_id`, `mfe` and `page_route`. Alert names follow gincommon's `Platform*` style; each section heading is the alert name the alert's `runbook_url` points to.

## PlatformWebRemoteLoadErrorBudgetBurn

**Status:** proposed (critical). **Fires when:** more than 1.44% of a remote's loads fail in both the last hour and the last 5 minutes (14.4× the 99.9% monthly SLO), with at least one load a minute.

**Signal:** `platform_web_remote_load_seconds_count{outcome="error"}` over all loads (kill-switched loads excluded), by `mfe`; the cause is in `platform_web_remote_load_failures_total{reason}`. **Today:** the essential `/mfe` error log `remote failed to load` (`mfe`, `reason`); users see the remote's fallback.

| `reason` | Likely cause | Action |
|---|---|---|
| `timeout` / `network` | Entry URL missing (deploy order), CloudFront, an integrity mismatch, a slow network | Check `/remotes/<name>/<version>/remoteEntry.js` exists, that its SRI matches the manifest, and that the manifest was written **after** the upload |
| `incompatible` | See [PlatformWebRemoteIncompatible](#platformwebremoteincompatible) | |
| `aborted` | Navigation away during load | Not counted as an error |
| `disabled` | Kill switch on (`remotes.killSwitch` or flag `remote.<name>.disabled`) | Not counted as an error; expected if intentional, otherwise remove it from `runtime.json` |

Also check the `/mfe` error `remote dropped from the manifest`. It names an entry the shell refused (origin not allowed, bad version or `ownerDomain`, bad SRI).

## PlatformWebRemoteIncompatible

**Status:** proposed (warning). **Fires when:** a remote has been refused or has failed to evaluate for 10 minutes (`platform_web_remote_load_failures_total{reason="incompatible"}`). **Today:** `remote failed to load` with `reason=incompatible`.

**Cause:** `strictVersion` share negotiation refused the remote (it requires a newer SDK, React or OTel API than the shell provides), or the module threw while evaluating (a shared module missing from the shell's scope looked like this: docs/e2e report, Issue 2). **Action:** release the shell before the remote; compare the remote's shared versions with the shell's `platformShared`; rebuild the remote with the shell's preset version. One stale tab does not alert.

## PlatformWebApiErrorBudgetBurn

**Status:** proposed (warning; the backend's own SLOs page for their 5xx). **Fires when:** more than 7.2% of browser API calls end in a 5xx, a timeout or a network failure in both the last hour and the last 5 minutes (14.4× the 99.5% monthly SLO), with at least one call a second.

**Signal:** `platform_web_http_client_duration_seconds_count{status_class="5xx"}` by `route`, `mfe`, compared with the server's `platform_http_requests_total` for the same route; calls the server never saw are in `platform_web_http_client_failures_total{reason}`. **Today:** backend 5xx are in the services' own logs and metrics; client-only failures (timeout, network) are visible only in sampled, consented `HTTP <method>` spans and, when a remote shows them, in its boundary's `remote showed an error` warning (consented). See the gaps in [tier1-ratification.md](tier1-ratification.md#interim-visibility-logs-and-traces).

| Client vs server | Meaning |
|---|---|
| Both high | Backend problem: follow gincommon's `PlatformHTTPErrorBudget*` runbook |
| Client high, server normal | The request never reached the service: gateway (Envoy `ext_authz` 503 on a cold cache, docs/e2e report Issue 12), CloudFront, network. Check `platform_web_http_client_failures_total{reason}` |
| `reason="timeout"` | Calls hit the client deadline (`api.timeoutMs`); compare with the server's latency for the route |

Correlate a single failure with the `requestId` / `traceId` the error boundary shows the user. `X-Trace-ID` from the server is on every `ProblemError`.

## PlatformWebChunkLoadErrors

**Status:** proposed (warning). **Fires when:** chunk-load errors exceed 0.01/s for 10 minutes (`platform_web_errors_total{source="chunk_load"}`). **Today:** nothing: the page reloads once per version, by design, and logs nothing for it (a gap: [tier1-ratification.md](tier1-ratification.md#interim-visibility-logs-and-traces)).

**Cause:** a tab still running the old build requested chunks a deploy removed, or a deploy is still uploading. **Action:** check that `/remotes/*` and `/assets/*` are versioned and never overwritten or deleted early, and that `/version.json` is written **last**. A sustained rate after a deploy means files were deleted too early.

## PlatformWebCoreWebVitalFailing

**Status:** proposed (warning). **Fires when:** fewer than 75% of page views rate good on LCP, INP or CLS for over an hour (the Core Web Vitals assessment), with at least ~180 rated views an hour.

**Signal:** `platform_web_vital_ratings_total` by `vital`, `page_route`; the p75 in `platform_web_vitals_seconds`. **Today:** no equivalent in logs or traces. **Action:** find the page routes on the dashboard's "Slowest pages"; look at the page's remotes (bundle size, the `remote load` span), API latency on its first calls, and the shell's CloudFront cache behaviour.

## PlatformWebLabelOverflow

**Status:** proposed (info). **Fires when:** `platform_telemetry_label_overflow_total{label=~"page_route|mfe"}` grows for 15 minutes.

**Cause:** pages whose route template is not registered with `useRouteTemplate`, or more routes than the 500-value bound; their measurements are recorded under `page_route="unknown"`. **Action:** register the route templates in the remote or the shell.

## Errors in the page (no alert)

**Signal:** `platform_web_errors_total` by `source`, `mfe` (dashboard only: a rate without page views is not alertable). **Today:** the `/react` error logs `remote failed to render` (by `mfe`), `uncaught error` and `unhandled promise rejection`.

**Action:** group by `mfe` and `exception.type`. `boundary` errors are contained in one remote (route them to the owning team via the manifest's `ownerDomain`). `unhandled_error` is attributed to `shell` and needs the stack to find the owner.

## Session ended spike

**Signal (logs today):**
- `/auth` `session ended` with `server_ended: true`;
- the shell's session-ended dialog;
- many users at once.

| Pattern | Cause | Action |
|---|---|---|
| One tenant, `server_ended: true` | Trial → paid conversion (expected) or an admin revoked sessions | None; users sign in again, and the workspace is re-resolved |
| Many tenants, `server_ended: true` | Refresh-token reuse revoked SSO sessions (should be impossible: single-flight per tab), or a Keycloak restart without persistent sessions | Check Keycloak events for `REFRESH_TOKEN_ERROR` / reuse; check `tender-web` rotation settings (RP #41) |
| `token refresh outcome unknown: restoring the session` warnings | Keycloak unreachable or slow (15 s token timeout) | Check `auth.bcbpsolutions.com` health; tabs restore silently once it answers |

## Sign-in failures

| Log | Cause | Action |
|---|---|---|
| `sign-in callback rejected: iss does not match the realm` | The callback came from another realm (possible attack, or a misrouted Keycloak shard) | Investigate; the code was not exchanged |
| `sign-in callback rejected` | The token exchange failed (`redirect_uri` not registered on `tender-web`, clock skew > 60 s, wrong `client_id`) | Check the realm's client settings and the error in the log |
| `sign-in callback ignored: unknown or expired state` | The callback was opened in another tab or after 10 minutes | Harmless for single users; a spike means a broken redirect flow |
| `workspace resolve failed` | PUB-1 unreachable or rate-limited (per IP) | The cache is still used; check the rate limit on `/api/v1/public/tenants/resolve` |
| Users stuck on "workspace being set up" | `DENY_UNRESOLVABLE_SUBJECT` for more than ~45 s (membership not created after signup) | Check org-membership's tenant creation for that signup |

## CSP violations

**Signal:** the essential `warn` log `content security policy violation` (`violated_directive`, `blocked_uri` origin). Violations before bootstrap go to `/csp-report` (OTLP logs, `event.name=csp.violation`).

| Directive | Likely cause |
|---|---|
| `script-src` / `require-trusted-types-for` | A remote or library uses `eval`, inline script, or a script URL without a Trusted Types policy; check `examples:check` on its build |
| `style-src` | Runtime CSS-in-JS slipped in (`no-runtime-css-in-js`) |
| `connect-src` | A call to an origin not in the CSP (only `self` and the IdP are allowed) |
| `trusted-types` | A policy name other than `platform-sdk`, `platform-webpack`, `dompurify` |

## Telemetry gaps

**Symptom:** a remote's logs or spans are missing. **Checks:**
- Consent: without `telemetry`, only errors and essential warnings leave the page.
- `telemetry.logLevel` and `sampleRatio` in `runtime.json`.
- `/otel` behaviour in CloudFront: POST only, 1 MB limit, the WAF rate rule.
- The Collector's label allowlists, which drop values not on the list.
