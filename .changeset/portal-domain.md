---
'@platform/frontend-sdk': minor
---

`/core`: `DOMAINS` gains `portal` (platform-gincommon v2.3.0), so a shell that fronts several business
domains can call `initializeCore({ domain: 'portal', … })` (design doc §D1). Contracts regenerated from
the new gincommon pin.
