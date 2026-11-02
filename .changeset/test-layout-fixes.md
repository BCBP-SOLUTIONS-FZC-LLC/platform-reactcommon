---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
'@bcbp-solutions-fzc-llc/webpack-preset': patch
---

`/http`: a deduplicated GET started inside `withSpan` continues the caller's trace (its span was started
after the token await, as a new root trace). `/tracing` exports `bindTraceContext(fn)`, which binds `fn`
to the trace context active when it is called. `/react`: `MFEErrorBoundary` logs an API error with its
`request_id`. `@bcbp-solutions-fzc-llc/webpack-preset`: the shell gets `publicPath: '/'` with its bundles under
`assets/`, so `index.html` loads its scripts on every deep link and on `/auth/callback` (a relative URL
resolved under the route and failed); remotes keep `publicPath: 'auto'`.
