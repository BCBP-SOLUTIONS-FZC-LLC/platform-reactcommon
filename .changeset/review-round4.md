---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
'@bcbp-solutions-fzc-llc/webpack-preset': patch
---

`/react` `useSignOut()` and `PlatformProvider` shell `signOut`; `/auth` reason `device-clock`, with ID-token times judged on the provider's clock; `/mfe` requires manifest `integrity` outside local/dev/test; one pagehide keepalive budget for logs and spans, spans sent synchronously (sendBeacon, else fetch keepalive); `sanitizeHtml` pre-pass (no Chromium CSP reports); never the native `AbortSignal.any`; deferred restore waits for the network; `exception.cause` in logs. `@bcbp-solutions-fzc-llc/webpack-preset`: the build's HTML loads its scripts with `integrity` and `crossorigin`.
