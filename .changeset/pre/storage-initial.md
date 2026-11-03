---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

Add `@bcbp-solutions-fzc-llc/frontend-sdk/storage`: per-workspace, per-app JSON storage (`storage`,
`workspaceNamespace`, `clearAllAppStorage`) that refuses credential-like keys
(`ForbiddenStorageKeyError`), writes nothing before sign-in and falls back to the page when the
browser's storage is unavailable.
