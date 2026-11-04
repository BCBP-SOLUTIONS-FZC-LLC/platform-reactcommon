---
'@bcbp-solutions-fzc-llc/eslint-plugin': minor
---

`no-identity-headers` also reports computed assignments (`h['x-user-id'] = v`), header pairs (`new Headers([['x-user-id', v]])`), template-literal names in `.set` / `.append` and `x.headers = {…}`. `no-raw-storage` follows aliases of the global object (`const w = window; w.localStorage`), chains (`window.self`) and destructuring. `no-unsafe-html` covers `setHTMLUnsafe`, `parseHTMLUnsafe`, `srcdoc` (property, attribute, JSX `srcDoc`), `createContextualFragment` and `DOMParser#parseFromString` for HTML, and by default trusts only `sanitizeHtml` imported from `@bcbp-solutions-fzc-llc/frontend-sdk/security`. Every rule's `docs.url` is an absolute GitHub URL.
