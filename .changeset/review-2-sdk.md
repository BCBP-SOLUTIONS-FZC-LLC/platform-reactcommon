---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
---

Second production-readiness review: linear URL stripping and an attribute cap that holds; **Breaking (deployment):** logout as a form POST (the ID token stays out of URLs; the shell's CSP `form-action` must allow the IdP origin); cross-tab sign-out reaches expired tabs; step-up `auth_time` checked; `IdentityProvider.dispose()`; validated workspace cache; refresh backoff joined by callers; `sanitizeHtml` refuses backslash/whitespace URLs and foreign images; `useApi` keyed by deps; SDK reloads run `useBeforeAuthRedirect` listeners; HTTP synthetic 502 for unusable answers and redirects with a token, typed-array bodies, retries capped at 5; remote attempt timeout covers init and get; manifest, version and catalog timeouts and catalog retries; global error rate limit; 24 h session id; fallback focus; clean span names; legacy storage keys cleared.
