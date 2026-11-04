# @bcbp-solutions-fzc-llc/eslint-plugin

ESLint rules for the platform's shell and remotes (flat config, ESLint 9 or 10):

```js
// eslint.config.js
import platform from '@bcbp-solutions-fzc-llc/eslint-plugin';

export default [platform.configs.recommended];
```

| Rule | Reports |
|---|---|
| `no-sdk-root-import` | an import of the SDK's package root (import a subpath) |
| `no-sdk-deep-import` | an SDK specifier that is not a public subpath |
| `no-identity-headers` | identity headers (`x-user-id`, `x-tenant-id`, …) set by the browser |
| `no-raw-storage` | `localStorage` / `sessionStorage` used directly (use `storage(appId)`) |
| `no-unsafe-html` | HTML sinks without `sanitizeHtml` from `@bcbp-solutions-fzc-llc/frontend-sdk/security` |
| `no-runtime-css-in-js` | runtime CSS-in-JS libraries (CSP `style-src 'self'`) |
| `api-route-template` | API paths built from strings instead of route templates |

`configs.recommended` turns on all seven, plus `no-eval`, `no-implied-eval` and `no-new-func`. Node ≥ 22, ESM only. Installs from GitHub Packages (`@bcbp-solutions-fzc-llc` scope, `read:packages`).

Documentation: [LLD §13.2](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/docs/lld/platform-reactcommon-lld.md#132-bcbp-solutions-fzc-llceslint-plugin) (what each rule reports, each rule's `docs.url`), the repository [README](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/README.md) and [CHANGELOG](https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon/blob/main/CHANGELOG.md).
