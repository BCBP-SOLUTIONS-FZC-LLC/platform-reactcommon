---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

/auth: a saved paid workspace whose realm Keycloak no longer serves (a reverted conversion, an offboarding) is re-checked with PUB-1 before a redirect to it; signInAgain takes a prompt callback of the chosen workspace. Docs: login-required without a workspace and no slug in the URL uses chooseWorkspace.
