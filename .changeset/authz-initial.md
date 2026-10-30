---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/authz`: UI permission hints (`hasPermission`, `roleMapAuthorizer`,
`denyAll`, `setAuthorizer`, `setAuthzSubject`). Subject roles are re-parsed with gincommon's
ParseRoles rule and fail closed; everything is denied until the shell sets both.
