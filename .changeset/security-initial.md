---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

Add `@bcbp-solutions-fzc-llc/frontend-sdk/security`: `sanitizeHtml` (DOMPurify; TrustedHTML where Trusted Types
exist), `installTrustedTypesPolicy` (the CSP's 'platform-sdk' policy: sanitised HTML, script URLs
only from the page or configured remote origins, no scripts from strings) and `isAllowedOrigin`.
