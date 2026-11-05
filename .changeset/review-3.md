---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
'@bcbp-solutions-fzc-llc/webpack-preset': minor
'@bcbp-solutions-fzc-llc/eslint-plugin': major
---

Third production-readiness review. **Breaking:** a Tier 3 metric with more than 8 labels is refused; `no-raw-storage` reports bare `localStorage` / `sessionStorage` under configured browser globals, and `no-unsafe-html` every unsanitized `parseFromString` (XML too). Preset: CSS that only loads at startup no longer fails the CSS integrity check. SDK: `loadRuntimeConfig` times out (10 s); sign-out drops the authorization subject, flags and read-only mark; a second SDK copy shares the runtime only within one pre-release; `createTestPlatform` provides `signOut` (`signOuts`) and stops the previous platform.
