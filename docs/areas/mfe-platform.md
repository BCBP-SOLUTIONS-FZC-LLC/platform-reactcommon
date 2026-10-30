# Micro-frontend platform

`/mfe` · `/flags` · `/nav`

What makes one shell and many independently deployed remotes behave as one app: finding and loading remotes, switching them off, moving between them, and noticing a new deployment.

| Subpath | What it does | Main exports |
|---|---|---|
| `/mfe` | The remote manifest (validated per remote); `loadRemote` with kill switch, timeout, retries, SRI and shared-module setup; reload once after a deploy removed old chunks; `/version.json` polling | `loadManifest`, `loadRemote`, `RemoteDisabledError`, `RemoteLoadError`, `isChunkLoadError`, `reloadOnceForChunkError`, `startVersionPolling`, `subscribeAppUpdate` |
| `/flags` | Platform flags and kill switches from the runtime config, tenant feature flags from the session context | `getFlag`, `setFlagProvider`, `runtimeConfigFlagProvider`, `sessionContextFlagProvider`, `isRemoteKilled` |
| `/nav` | Navigation between apps through the shell's router; redirect-target validation | `navigate`, `registerNavigator`, `isSafeRedirect` |

Build time: [`@platform/webpack-preset`](../../packages/webpack-preset) gives every app the same Module Federation setup:
- **Shared modules:** React, the OTel API and the SDK as strict singletons.
- **Remotes never bundle the SDK:** they take it from the shell.
- **CSP-safe output:** Trusted Types, no `eval`, hidden source maps.

## How it's used

The shell loads the manifest once (`loadManifest()`) and starts `startVersionPolling()`. Routes render remotes with `<RemoteBoundary remote="tenders" module="./EditTender" />` from the [developer surface](developer-surface.md). A remote switches features with `useFeatureFlag('ai.drafting', false)` and moves to another app with `navigate('iam', '/members')`.

## Guarantees

- **Containment:** one remote's failure (disabled, not found, timeout, version clash) stays in its own boundary; the shell and other remotes keep working.
- **Entry origins:** a remote entry is loaded only from the page's origin or an exact allowed origin, checked again right before the script is added.
- **No reload loops:** a deploy causes at most one reload per version.
- **Kill switch:** any remote can be switched off without a deploy (runtime config or flag).
- **Safe navigation:** navigation never follows an unsafe or foreign-origin target.

Design doc: §C1 `/mfe`, `/flags`, `/nav`, §C3 (Module Federation, CloudFront).
