---
'@platform/frontend-sdk': patch
---

`/config`: Zod runs jitless, so parsing the runtime config never probes `new Function` (under the
platform CSP that probe fired a CSP violation and a `/csp-report` on every page load). `/react`:
`ShellContextValue`'s `user`, `workspace` and `context` accept `undefined`, as the shell bootstrap passes
an unloaded session context.
