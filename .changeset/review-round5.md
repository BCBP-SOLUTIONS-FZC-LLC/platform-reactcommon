---
'@bcbp-solutions-fzc-llc/frontend-sdk': patch
---

`/metrics` sends the interval by `sendBeacon` when the page is hidden or closing (the last interval was lost on tab close). Logs, spans and metrics share one keepalive budget across the hidden phase and `pagehide`; logs and spans leave the metrics interval its share; on hide, logs send one beacon within the budget and the rest by fetch.
