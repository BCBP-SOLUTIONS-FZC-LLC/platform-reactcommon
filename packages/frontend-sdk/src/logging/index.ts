/**
 * Structured browser logging over OTLP, redacted with platform-gincommon's rules and joined with
 * backend logs on trace_id and request_id. Design contract: docs/design/frontend-sdk-design.md §C1 `/logging`.
 *
 * @packageDocumentation
 */
export { getLogger, initializeLogging, setRouteTemplate, type LogLevel, type Logger } from './logging.ts';
export { serializeError } from './redact.ts';
