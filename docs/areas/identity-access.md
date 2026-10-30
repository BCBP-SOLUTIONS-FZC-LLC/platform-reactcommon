# Identity & access

`/auth` · `/authz` · `/storage`

Who the user is, which workspace (tenant) they're in, what the UI should let them do, and keeping each tenant's browser data apart. This is the browser's side of IAM.

| Subpath | What it does | Main exports |
|---|---|---|
| `/auth` | Keycloak sign-in (Authorization Code + PKCE, tokens in memory only); workspace (realm) choice and caching; silent restore, token refresh, idle timeout, logout, workspace switch, step-up MFA | `createOidcProvider`, `initializeAuth`, `getSession`, `chooseWorkspace`, `rememberWorkspace`, `cachedWorkspace`, `slugFromPath`, `isWrongWorkspace`, `signInAgain`; ports `WorkspaceResolver`, `SessionContextSource` |
| `/authz` | UI permissions from the user's roles (P-35 session context): a hint for hiding and disabling, never a security decision | `roleMapAuthorizer`, `setAuthorizer`, `setAuthzSubject`, `hasPermission`, `denyAll` |
| `/storage` | Browser storage namespaced per workspace and app; refuses token-like keys; cleared on logout and switch | `storage(appId, { area })`, `clearAllAppStorage`, `workspaceNamespace`, `ForbiddenStorageKeyError` |

## How it's used

The shell wires sign-in (design doc §C2 step 7) and implements two ports over the `ApiClient`: tenant resolve (PUB-1) and session context (P-35). Remotes read the result through the [developer surface](developer-surface.md): `useSession()`, `useCurrentUser()`, `useHasPermission('update', 'tender')`, `<Can>`, `useStepUp()`. Drafts go to `storage('tenders', { area: 'session' })`.

## Guarantees

- **Tokens:** they never reach storage, a global, a log or the cross-tab channel. The access token goes only to the page's own origin.
- **Callbacks:** a code is exchanged at most once. The callback must match its PKCE record and Keycloak's `iss`, and the ID token's claims are checked.
- **Refresh across tabs:** each tab refreshes only its own token lineage, one refresh at a time, and never resends a refresh token Keycloak may already have replaced.
- **Expiry:** a session that ends is reported (`expired`), never silently re-signed in. After a logout, nothing signs the user in automatically.
- **Tenant isolation in storage:** one tenant never reads another's stored data on a shared browser.
- **Permissions are hints:** the gateway authorizes every request.

Design doc: §C1 `/auth`, `/authz`, `/storage`, §D2 (tenant model), §D4 (IdP).
