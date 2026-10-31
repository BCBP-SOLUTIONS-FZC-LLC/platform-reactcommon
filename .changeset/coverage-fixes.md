---
'@platform/frontend-sdk': patch
---

`/logging`: sensitive keys inside class instances are now redacted (`sanitizeFields` passes class
instances through unchanged, so `{ c: new Creds() }` sent `password` in clear). `/auth`: `getSession()`
returns one stable `loading` object before `initializeAuth`, so `useSession`, `useCurrentUser`,
`useWorkspace` and `useStepUp` no longer crash React with "Maximum update depth exceeded" when they
render first. `/mfe`: `loadRemote` with an already-aborted signal no longer injects the remote entry
script.
