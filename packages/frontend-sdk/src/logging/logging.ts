// Structured browser logging over OTLP (design doc §C1 /logging). Field names match gincommon's
// request logs (snake_case trace_id, request_id), so one Loki query joins frontend and backend lines.
import { context as otelContext, isSpanContextValid, trace } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { LoggerProvider, type LogRecordExporter } from '@opentelemetry/sdk-logs';
import { NotInitializedError, getIdentity, getSessionId, hasConsent, type MfeScope } from '../core/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { collectorUrl } from '../internal/urls.ts';
import { DropOldestLogProcessor, type LogQueueOptions, type LoggingStats } from './processor.ts';
import { cleanString, redactAttributes, serializeError, type LogValue } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * A structured logger. Attributes are redacted (sensitive keys, control characters, JWTs, Bearer
 * credentials) before they leave the page. Reserved attributes: `error` (serialised as
 * exception.*), `request_id` (moved into the envelope) and, on warn, `essential: true` (sent
 * without telemetry consent; never sent itself).
 */
export interface Logger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown> & { error?: unknown }): void;
  /** A logger whose records also carry `scope` (e.g. { mfe: 'tenders', feature: 'bids' }). */
  child(scope: Partial<MfeScope> & Record<string, string>): Logger;
}

interface LoggingState {
  provider: LoggerProvider;
  logger: ReturnType<LoggerProvider['getLogger']>;
  processor: DropOldestLogProcessor;
  level: LogLevel;
  stats: LoggingStats & { droppedNoConsent: number };
  removeListeners: () => void;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
// OTel severity numbers: DEBUG 5, INFO 9, WARN 13, ERROR 17.
const SEVERITY: Record<LogLevel, number> = { debug: 5, info: 9, warn: 13, error: 17 };
/** Envelope fields the SDK sets; a caller attribute of the same name is dropped. */
const ENVELOPE = ['trace_id', 'span_id', 'request_id', 'session_id', 'mfe', 'page_route'] as const;
const PAGE_ROUTE = /^(unknown|\/[A-Za-z0-9_./:*~-]*)$/;
const MAX_ROUTE_TEMPLATES = 1000;
const SHELL = 'shell';

// Test seam: tests replace the exporter; the shell never touches this.
let exporterFactory: (url: string) => LogRecordExporter = (url) => new OTLPLogExporter({ url, timeoutMillis: 10_000, concurrencyLimit: 2 });
export function setLoggingInternalsForTests(o: { exporter?: (url: string) => LogRecordExporter }): void {
  if (o.exporter) exporterFactory = o.exporter;
}

function state(): LoggingState | undefined {
  return getRuntime().logging as LoggingState | undefined;
}

function isDev(): boolean {
  const env = getIdentity()?.environment;
  return env === undefined || env === 'local' || env === 'dev';
}

function intOption(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  const v = value ?? fallback;
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${v}`);
  return v;
}

/**
 * Shell only: starts OTLP logging to `${otlpBaseUrl}/v1/logs`. Requires initializeCore (the
 * identity becomes the resource). A second call is a no-op. Loggers obtained earlier start sending.
 */
export function initializeLogging(o: { otlpBaseUrl: string; level?: LogLevel; batchSize?: number; flushMs?: number }): void {
  const identity = getIdentity();
  if (!identity) throw new NotInitializedError('initializeLogging requires initializeCore first');
  if (state()) return;
  const level = o.level ?? 'info';
  if (!(level in LEVEL_ORDER)) throw new RangeError(`level must be debug, info, warn or error, got ${String(level)}`);
  const url = collectorUrl(o.otlpBaseUrl, 'logs');
  const queue: LogQueueOptions = {
    batchSize: intOption('batchSize', o.batchSize, 50, 1, 512),
    flushMs: intOption('flushMs', o.flushMs, 5_000, 100, 60_000),
    maxQueueSize: 1_000,
  };

  const stats = { exported: 0, droppedQueueFull: 0, exportFailures: 0, beacons: 0, droppedNoConsent: 0 };
  const processor = new DropOldestLogProcessor(exporterFactory(url), url, stats, queue);
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': identity.serviceName,
      'service.version': identity.buildVersion,
      'service.namespace': identity.domain,
      'deployment.environment.name': identity.environment,
    }),
    processors: [processor],
  });

  const onPageHide = () => processor.drainOnHide();
  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') processor.drainOnHide();
  };
  globalThis.addEventListener?.('pagehide', onPageHide);
  globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
  const removeListeners = () => {
    globalThis.removeEventListener?.('pagehide', onPageHide);
    globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
  };

  getRuntime().logging = {
    provider,
    logger: provider.getLogger('@platform/frontend-sdk'),
    processor,
    level,
    stats,
    removeListeners,
  } satisfies LoggingState;
}

/** Internal: flushes and stops logging (tests; a future shutdown API). */
export async function shutdownLogging(): Promise<void> {
  const s = state();
  if (!s) return;
  getRuntime().logging = undefined;
  s.removeListeners();
  await s.provider.shutdown().catch(() => {});
}

/** Internal: counters for exports, drops and failures. */
export function loggingStats(): Readonly<LoggingStats & { droppedNoConsent: number }> | undefined {
  return state()?.stats;
}

function needsTelemetryConsent(level: LogLevel, essential: boolean): boolean {
  if (level === 'error') return false;
  if (level === 'warn') return !essential;
  return true;
}

function emit(level: LogLevel, msg: string, attrs: Record<string, unknown> | undefined, scope: Record<string, string>): void {
  const { essential, error, request_id: requestId, ...rest } = attrs ?? {};
  const s = state();
  if (s && LEVEL_ORDER[level] < LEVEL_ORDER[s.level]) return;

  const { mfe, ...scopeAttrs } = scope;
  const attributes: Record<string, LogValue> = redactAttributes({ ...scopeAttrs, ...rest });
  for (const k of ENVELOPE) delete attributes[k];
  if (error !== undefined) {
    const e = serializeError(error);
    attributes['exception.type'] = e.name;
    attributes['exception.message'] = e.message;
    if (e.stack !== undefined) attributes['exception.stacktrace'] = e.stack;
  }
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (spanContext && isSpanContextValid(spanContext)) {
    attributes.trace_id = spanContext.traceId;
    attributes.span_id = spanContext.spanId;
  }
  if (typeof requestId === 'string' && requestId !== '') attributes.request_id = cleanString(requestId);
  attributes.session_id = getSessionId();
  attributes.mfe = mfe ? cleanString(mfe) : SHELL;
  attributes.page_route = getRuntime().pageRoute ?? 'unknown';
  const body = cleanString(typeof msg === 'string' ? msg : String(msg));

  if (isDev()) console[level](`[${attributes.mfe}] ${body}`, attributes);
  if (!s) return;
  if (needsTelemetryConsent(level, essential === true) && !hasConsent('telemetry')) {
    s.stats.droppedNoConsent++;
    return;
  }
  s.logger.emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body,
    attributes,
    context: otelContext.active(),
    timestamp: Date.now(),
  });
}

function makeLogger(scope: Record<string, string>): Logger {
  return {
    debug: (msg, attrs) => emit('debug', msg, attrs, scope),
    info: (msg, attrs) => emit('info', msg, attrs, scope),
    warn: (msg, attrs) => emit('warn', msg, attrs, scope),
    error: (msg, attrs) => emit('error', msg, attrs, scope),
    child: (extra) => makeLogger({ ...scope, ...extra }),
  };
}

/**
 * A logger tagged with `scope.mfe` (default 'shell'). Before initializeLogging it writes to the
 * console in local/dev (or when no identity is set, e.g. a remote run standalone) and is a no-op
 * elsewhere; once logging starts, the same logger sends.
 */
export function getLogger(scope?: Partial<MfeScope>): Logger {
  return makeLogger(scope?.mfe ? { mfe: scope.mfe } : {});
}

/**
 * Called by the /react router glue on every navigation with the matched route template (e.g.
 * '/tenders/:id'): logs carry it as page_route, and /metrics bounds page_route by the set of
 * templates seen. A value that is not a template is recorded as 'unknown'.
 */
export function setRouteTemplate(template: string): void {
  const rt = getRuntime();
  if (typeof template !== 'string' || !PAGE_ROUTE.test(template)) {
    rt.pageRoute = 'unknown';
    return;
  }
  rt.pageRoute = template;
  if (template !== 'unknown' && rt.routeTemplates.size < MAX_ROUTE_TEMPLATES) rt.routeTemplates.add(template);
}
