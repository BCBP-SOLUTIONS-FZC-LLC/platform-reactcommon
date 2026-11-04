---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

`/auth` retries a refresh refused unprocessed (429, or 503 with `Retry-After`) with backoff while the access token is valid, instead of sending every tab to the IdP. `/logging` caps a record's attributes at 8 KiB, skips a record too big for the unload beacon, and counts the exporter's keepalive leftovers in the page budget (as `/tracing` does). Queued telemetry that needed consent is dropped when consent is withdrawn. URL query strings and fragments (absolute URLs and rooted paths) are removed from logged strings and span attributes. `MFEErrorBoundary` takes `resetKeys`; both boundaries clear their error when what they show changes.
