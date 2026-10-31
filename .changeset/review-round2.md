---
'@platform/frontend-sdk': minor
'@platform/webpack-preset': minor
---

`@platform/webpack-preset`: `sharedFor('remote')` requires `^<the SDK version the remote was built
against>` for every SDK entry (the shell keeps `^1.0.0-0`), so a remote that needs a newer SDK than the
shell provides fails share negotiation inside its `RemoteBoundary` instead of hitting a missing export at
run time. Upgrade the shell first; roll it back only to an SDK at or above the newest one any deployed
remote was built against. `/config`: `telemetry.enabled` (default `true`; `false` turns off all trace,
log and metric export); `http://localhost` origins are accepted only when the page environment is `local`
or `dev` (call `initializeCore` before `loadRuntimeConfig` / `setRuntimeConfig`). `/tracing`: a hidden page
flushes the whole queue without dropping spans; `pagehide` sends one keepalive request with the newest
spans and counts the rest (`droppedOnUnload`). `/storage`: a write that fails (storage full) removes the
older stored value, so reads never return it. `/flags`: `read_only` is true when the platform or the
tenant says so. `/auth`: the first recorded sign-in on a browser no longer clears app storage, so a draft
saved before the login redirect survives.
