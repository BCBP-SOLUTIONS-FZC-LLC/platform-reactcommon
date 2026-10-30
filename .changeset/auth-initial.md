---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/auth`: `createOidcProvider` (Keycloak Authorization Code + PKCE S256,
tokens in memory only, pending-login records with RFC 9207 `iss` and ID-token claim checks, silent
`prompt=none` restore with a per-tab loop guard and a signed-out mark, single-flight refresh that
never resends a replaced refresh token and restores the lineage after an ambiguous failure, a
cross-tab idle timeout, local and global logout, `switchWorkspace`, step-up), workspace choice and
caching (`slugFromPath`, `chooseWorkspace`, `cachedWorkspace`, `rememberWorkspace`,
`isWrongWorkspace`), `signInAgain`, `initializeAuth` and `getSession`. Contract fixtures
`tenant-resolve-cases.json` (PUB-1) and `session-context-cases.json` (P-35), checked against
iam-org-membership's swagger.
