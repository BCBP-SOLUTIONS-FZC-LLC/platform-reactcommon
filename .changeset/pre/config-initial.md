---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

Add `@bcbp-solutions-fzc-llc/frontend-sdk/config`: the strict `RuntimeConfigSchema` (unknown keys rejected at
every level, design-doc defaults), `loadRuntimeConfig` (no HTTP cache, every failure a
`RuntimeConfigError` with issue paths), and `setRuntimeConfig` / `getConfig` / `tryGetConfig`
(set once, deep-frozen, shared through the PlatformRuntime).
