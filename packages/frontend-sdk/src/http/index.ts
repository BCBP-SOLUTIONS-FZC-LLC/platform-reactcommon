/**
 * The platform HTTP client: one fixed pipeline (offline check, URL, forbidden headers, request id,
 * trace context, session id, token, idempotency key, deadline, 401 refresh, retries, problems),
 * contract-compatible with platform-gincommon. Design contract: docs/design/frontend-sdk-design.md §C1 `/http`.
 *
 * @packageDocumentation
 */
export {
  FORBIDDEN_REQUEST_HEADERS,
  createApiClient,
  setTokenSource,
  type ApiClient,
  type ApiResponse,
  type RequestOptions,
  type RouteTemplate,
  type TokenSource,
} from './client.ts';
export { isOnline, subscribeOnline } from '../internal/online.ts';
