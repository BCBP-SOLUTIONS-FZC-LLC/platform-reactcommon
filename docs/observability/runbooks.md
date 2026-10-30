# Runbooks: frontend symptoms and the proposed web alerts

The browser's Tier 1 metrics (`platform_web_*`) are **proposed**, and their alerts don't exist yet (design doc §D5, §D6 K). Until they're ratified, these runbooks start from logs, which carry `trace_id`, `request_id`, `session_id`, `mfe` and `page_route`. Each section names the alert it becomes once the metrics are bound. Alert names follow gincommon's `Platform*` style.

## PlatformWebRemoteLoadFailures (proposed)

**Signal:** `platform_web_remote_load_failures_total` by `mfe`, `reason`. Today: the `/mfe` log `remote failed to load` (`mfe`, `reason`), and users see a remote's fallback.

| `reason` | Likely cause | Action |
|---|---|---|
| `disabled` | Kill switch on (`remotes.killSwitch` or flag `remote.<name>.disabled`) | Expected if intentional; otherwise remove it from `runtime.json` |
| `timeout` / `network` | Entry URL missing (deploy order), CloudFront, a slow network | Check `/remotes/<name>/<version>/remoteEntry.js` exists, and that the manifest was written **after** the upload |
| `incompatible` | `strictVersion` share negotiation failed (SDK, React or OTel API range), or the module failed to evaluate | Compare the remote's shared versions with the shell's `platformShared`; rebuild the remote with the shell's preset version |
| `aborted` | Navigation away during load | Normally harmless |

Also check the `/mfe` error `remote dropped from the manifest`. It names an entry the shell refused (origin not allowed, bad version or `ownerDomain`, bad SRI).

## PlatformWebChunkLoadErrors (proposed)

**Signal:** `platform_web_errors_total{source="chunk_load"}`. Today: the page reloads once per version, by design.

**Cause:** a tab still running the old build requested chunks a deploy removed, or a deploy is still uploading. **Action:** check that `/remotes/*` and `/assets/*` are versioned and never overwritten, and that `/version.json` is written **last**. A sustained rate after a deploy means files were deleted too early.

## PlatformWebErrorsHigh (proposed)

**Signal:** `platform_web_errors_total` by `source`, `mfe`. Today: the `/react` logs `remote failed to render` (by `mfe`), `uncaught error` and `unhandled promise rejection`.

**Action:** group by `mfe` and `exception.type`. `boundary` errors are contained in one remote (route them to the owning team via the manifest's `ownerDomain`). `unhandled_error` is attributed to `shell` and needs the stack to find the owner.

## PlatformWebHTTPClientErrorBudgetBurn (proposed)

**Signal:** `platform_web_http_client_duration_seconds_count{error_class!="success"}` by `mfe`, `route`, compared with the server's `platform_http_requests_total` for the same route.

| Client vs server | Meaning |
|---|---|
| Both high | Backend problem: follow gincommon's `PlatformHTTPErrorBudget*` runbook |
| Client high, server normal | The request never reached the service: gateway denials (`401`/`403` with deny codes), CloudFront, CORS, network. Check `platform_web_http_client_failures_total{reason}` |
| `reason="timeout"` | Calls hit the 35 s client deadline (`api.timeoutMs`); compare with the server's latency for the route |

Correlate a single failure with the `requestId` / `traceId` the error boundary shows the user. `X-Trace-ID` from the server is on every `ProblemError`.

## PlatformWebLCPPoor / PlatformWebINPPoor (proposed)

**Signal:** the share of `platform_web_vital_ratings_total{rating="poor"}` by `vital`, `page_route`. **Action:** look at the page's remotes (bundle size, the time the `loadRemote` span takes), API latency on its first calls, and the shell's CloudFront cache behaviour.

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
