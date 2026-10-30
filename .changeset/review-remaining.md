---
'@platform/frontend-sdk': patch
'@platform/eslint-plugin': patch
---

`/auth`: after a local logout, the next sign-in asks for credentials (`prompt=login`), and a sign-in by a
different user on the same browser clears the previous user's app storage first (a SHA-256 fingerprint
of realm and `sub` in `@platform/frontend-sdk:auth:last-user`; never the raw `sub`). `/react`: hooks keep
stable subscriptions across renders, and `useSession` follows an identity provider installed after its
first render. `/metrics`: instruments created before `initializeCore` record once it has run. `/tracing`:
span attributes and recorded errors are scrubbed of JWT and Bearer values like logs (`/core` exports
`scrubSecrets`); on page hide spans are sent in keepalive-sized requests; the sampler description
matches Go's `%g`. `/logging`: a `Map` is logged as an object of its entries and a `Set` as an array.
`/mfe`: remote names never resolve from `Object.prototype`. `/i18n`: a namespace registered during a
locale change also loads the new locale. `/http`: each subscriber of a deduplicated GET gets its own copy
of `data`. `@platform/eslint-plugin`: `no-identity-headers` sees a computed `['headers']` key, and the
import rules see template-literal `require` / `import()`.
