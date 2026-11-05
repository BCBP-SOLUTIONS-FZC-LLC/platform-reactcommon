# Data access

`/http`

One way to call platform APIs, with the platform's conventions built in: route templates, correlation, identity safety, retries, token refresh and RFC 9457 errors.

| Subpath | What it does | Main exports |
|---|---|---|
| `/http` | The `ApiClient`: `get`, `post`, `put`, `patch`, `delete` on route templates such as `'/tenders/:id'` | `createApiClient`, `setTokenSource`, `isOnline`, `subscribeOnline`, `FORBIDDEN_REQUEST_HEADERS`, types `ApiClient`, `RequestOptions`, `ApiResponse`, `TokenSource` |

## How it's used

In React, through the [developer surface](developer-surface.md):

```ts
const { data, error, loading } = useApi((c, signal) => c.get<Tender>('/tenders/:id', { params: { id }, signal }), [id]);
```

Without React: `createApiClient({ mfe: 'tenders' }).put('/tenders/:id', { params: { id }, body })`.

## Guarantees

- **Templates, not URLs:** the template is also the metric's `route` label, so a raw URL never becomes a label (`@bcbp-solutions-fzc-llc/eslint-plugin` `api-route-template`).
- **Identity headers are never sent** (`x-user-id`, `x-tenant-id`, …: the gateway sets them from the token). They're dropped, and in development they throw.
- **The token goes to the page's own origin only.** Correlation headers (`x-request-id`, `x-session-id`, `traceparent`) go to the page's origin and to exact allowlisted origins. A call carrying either never follows a redirect (it would take them to the redirect's origin): it fails as a synthetic 502.
- **Retries** apply only to idempotent methods (or when asked): on timeouts, network errors, 429 and 502–504, honouring `Retry-After`, at most 5. Every `POST` carries an `Idempotency-Key`.
- **Bodies:** typed arrays and DataViews are sent as bytes; a `ReadableStream` is refused (not replayable). A 2xx body that is not the JSON it claims is a synthetic 502 problem.
- **A 401** joins the tab's single token refresh and retries once. Identical concurrent `GET`s share one request.
- **Errors** are always one of `ProblemError`, `TimeoutError`, `NetworkError`, `AbortedError` (from the [foundation](foundation.md)).

It depends on the foundation and observability areas, and gets tokens from [identity & access](identity-access.md) through the `TokenSource` port (it never imports `/auth`).

Design doc: §C1 `/http`.
