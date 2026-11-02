---
'@bcbp-solutions-fzc-llc/frontend-sdk': patch
---

`/auth`: the refresh lead is `min(60 s, lifetime / 3)` with jitter of at most half the lead, so a short-lived access token (60 s) is refreshed 30–50 s after it was issued instead of many times a second. A refresh request the browser cancels because the page is navigating away (beforeunload or pagehide seen while it was in flight) no longer starts a `prompt=none` restore that replaces the navigation; the page restores only if it is still there 10 s later. Found by the integrated E2E run (docs/e2e/integrated-deployment-report.md, Issues 4 and 19).
