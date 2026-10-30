---
'@platform/frontend-sdk': minor
---

Add `@platform/frontend-sdk/core`: page identity (`initializeCore`, validated against the registry
vocabulary), the `PlatformRuntime` with duplicate-copy detection, correlation ids (`getSessionId`,
`newRequestId`), consent (`setConsentProvider`, `hasConsent`) and log sanitisation with gincommon
parity (`isSensitiveKey`, `sanitizeFields`, `sanitizeString`).
