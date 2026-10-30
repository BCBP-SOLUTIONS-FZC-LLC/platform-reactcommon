/**
 * Browser tracing over OTLP/HTTP with platform-gincommon's resource attributes and sampler, and
 * W3C trace context propagation limited to the page's origin and an exact-origin allowlist.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/tracing`.
 *
 * @packageDocumentation
 */
export {
  currentTraceId,
  getTracer,
  initializeTracing,
  injectTraceHeaders,
  shutdownTracing,
  withSpan,
  type Span,
  type Tracer,
  type TracingOptions,
} from './tracing.ts';
