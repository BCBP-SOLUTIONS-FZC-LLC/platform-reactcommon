---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/nav`: `navigate` through the shell's router (`registerNavigator`),
with a page-navigation fallback for standalone remotes, and `isSafeRedirect` for returnUrl
validation (same origin, http(s), no protocol-relative, backslash, whitespace or control-character
tricks, no credentials).
