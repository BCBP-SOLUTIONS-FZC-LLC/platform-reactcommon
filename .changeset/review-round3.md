---
'@platform/frontend-sdk': patch
---

`/config`: `http://localhost` origins are also accepted when the page environment is `test` (CI and
integration runs against local servers, as platform-interop-tests pair 4 does). `/tracing`: a hidden page
sends the newest spans first in one keepalive request, so a closing tab keeps them, then flushes the rest.
`/storage`: a write that fails keeps the last saved value for a reload and is read back for the page.
