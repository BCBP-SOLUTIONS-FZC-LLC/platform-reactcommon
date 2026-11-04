---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

`/testing`: `createTestPlatform()` scopes `storage()` to its signed-in workspace (writes were dropped as if signed out); the new `storageNamespace` option (`'anon'`) tests the signed-out case.
