---
'@bcbp-solutions-fzc-llc/frontend-sdk': patch
---

Operational failures leave the page without telemetry consent (essential warnings, no personal data): `/http` logs `api call got no response` for a call that ended in a timeout or a network failure while online (`method`, `route` template, `reason`, `request_id`, `mfe`; at most 10 a minute per page, the next carrying `suppressed`); `/mfe` logs `chunk load failed: reloading` before the one reload per version; `/auth`'s `sign-in failed`, `sign-in callback ignored`, `workspace resolve failed` and the refresh-restore warnings are essential, and `session ended` is an essential warning when Keycloak ended a live session (info otherwise). Closes the logs-and-traces gaps of docs/observability/tier1-ratification.md §5.
