---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

Add `@bcbp-solutions-fzc-llc/frontend-sdk/mfe`: `loadManifest` (per-remote validation of entry origin, version,
registry ownerDomain and SRI; publishes remote → domain for /metrics), `loadRemote` over Webpack 5
Module Federation (kill switch, per-attempt timeout, retries, share-scope negotiation, metrics,
`RemoteDisabledError` / `RemoteLoadError`), `isChunkLoadError` / `reloadOnceForChunkError` and
`/version.json` polling with `subscribeAppUpdate`.
