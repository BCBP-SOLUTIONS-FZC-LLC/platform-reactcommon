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

- **Templates, not URLs:** the template is also the metric's `route` label, so a raw URL never becomes a label (`@platform/eslint-plugin` `api-route-template`).
- **Identity headers are never sent** (`x-user-id`, `x-tenant-id`, …: the gateway sets them from the token). They're dropped, and in development they throw.
- **The token goes to the page's own origin only.** Correlation headers (`x-request-id`, `x-session-id`, `traceparent`) go to the page's origin and to exact allowlisted origins.
- **Retries** apply only to safe methods (or when asked): on timeouts, network errors, 429 and 502–504, honouring `Retry-After`. Every `POST` carries an `Idempotency-Key`.
- **A 401** joins the tab's single token refresh and retries once. Identical concurrent `GET`s share one request.
- **Errors** are always one of `ProblemError`, `TimeoutError`, `NetworkError`, `AbortedError` (from the [foundation](foundation.md)).

It depends on the foundation and observability areas, and gets tokens from [identity & access](identity-access.md) through the `TokenSource` port (it never imports `/auth`).

Design doc: §C1 `/http`.
