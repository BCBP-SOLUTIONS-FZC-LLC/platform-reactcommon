---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
'@bcbp-solutions-fzc-llc/webpack-preset': major
---

**Breaking:** a remote's container global is `__platform_mfe_<name>` (SDK `loadRemote` and preset `containerName` together), so an element id or browser global with the remote's name no longer stops it loading; `/storage` keys start with `@bcbp-solutions-fzc-llc/frontend-sdk:storage:`, so `clearAllAppStorage` removes only the SDK's keys. The preset's new `SdkVersionPlugin` fails a build whose installed SDK is not the preset's version.
