/**
 * RFC 9457 problem details: the platform type registry, the SDK's error model and the parser for
 * error responses, contract-compatible with platform-gincommon and platform-fastapicommon.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/problem`.
 *
 * @packageDocumentation
 */
export {
  DEFAULT_TYPE_BASE,
  PROBLEM_CONTENT_TYPE,
  PlatformProblemTypes,
  defineProblemType,
  typeForStatus,
  type ProblemType,
} from './types.ts';
export {
  AbortedError,
  NetworkError,
  ProblemError,
  TimeoutError,
  isProblemError,
  toFieldErrorMap,
  type ApiError,
  type FieldError,
  type ProblemDetails,
} from './errors.ts';
export { GATEWAY_DENY_CODES, gatewayDenyCode, parseProblemResponse, type GatewayDenyCode } from './parse.ts';
