---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
---

Signing out is global by default: `IdentityProvider.logout()`, the shell's `signOut` and `useSignOut()` also end the Keycloak SSO session (end-session request, back to `<origin>/`), so the next person on a shared device signs in from scratch (report Issue 10). Pass `{ global: false }` for the previous local-only sign-out.
