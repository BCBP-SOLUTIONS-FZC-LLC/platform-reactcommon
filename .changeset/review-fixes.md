---
'@platform/frontend-sdk': patch
'@platform/webpack-preset': patch
---

`/http`: a GET for the same URL made right after every subscriber of a shared GET aborted no longer
joins the dead request (under React StrictMode, `reload()` while loading or deps A→B→A, `useApi`
stayed `loading` forever); `useApi` also ends the load on an `AbortedError` it didn't cause. Route
param values `.` and `..` are refused (URL parsing resolved them as path steps, so `{ id: '..' }`
sent the call, with the token, to another endpoint). A timeout, abort or dropped connection while the
response body is read is a `TimeoutError`, `AbortedError` or `NetworkError`, not a raw `DOMException`.
Works without `AbortSignal.any` (Safari before 17.4). `@platform/webpack-preset`: `react/jsx-runtime`,
`react/jsx-dev-runtime` and `react-dom/client` are shared like `react` and `react-dom`, so a remote's
JSX always comes from the shell's React.
