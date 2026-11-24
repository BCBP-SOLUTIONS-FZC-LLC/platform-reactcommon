---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
'@bcbp-solutions-fzc-llc/eslint-plugin': major
---

`/auth`: a cached trial workspace is re-checked with PUB-1 before an interactive sign-in (trial → paid conversion), and `switchWorkspace(w, { prompt: 'login' })`. `/problem`: `DENY_MEMBER_SUSPENDED`; deny codes now come from AuthZ Enrichment's published `api/deny-codes.json`. Breaking: `x-auth-time` joins `FORBIDDEN_REQUEST_HEADERS` and `no-identity-headers` (`configs.recommended`); `GATEWAY_DENY_CODES` follows AuthZ Enrichment's order.
