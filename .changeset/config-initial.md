---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/config`: the strict `RuntimeConfigSchema` (unknown keys rejected at
every level, design-doc defaults), `loadRuntimeConfig` (no HTTP cache, every failure a
`RuntimeConfigError` with issue paths), and `setRuntimeConfig` / `getConfig` / `tryGetConfig`
(set once, deep-frozen, shared through the PlatformRuntime).
