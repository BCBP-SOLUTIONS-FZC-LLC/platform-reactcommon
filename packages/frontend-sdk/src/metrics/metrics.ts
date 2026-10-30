// Browser metrics under the Enterprise Platform Observability Standard (design doc §C1 /metrics):
// Tier 2 (domain) and Tier 3 (service) meters for shell and remote code, central injection of
// domain/service/environment, the standard's registration and label rules, and a delta OTLP
// exporter gated on telemetry consent. Tier 1 (platform_web_*) names are bound in a later step,
// after governance ratifies them (§D6 K); until then the SDK records none.
import type { Counter as OtelCounter, Histogram as OtelHistogram } from '@opentelemetry/api';
import { AggregationTemporalityPreference, OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { tryGetConfig } from '../config/index.ts';
import { NotInitializedError, getIdentity, hasConsent, sanitizeString, type MfeScope } from '../core/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { collectorUrl } from '../internal/urls.ts';
import {
  CONST_LABELS,
  InvalidMetricError,
  allowsValue,
  bucketPreset,
  checkDomainMetricEntry,
  checkDomainMetricOwner,
  checkServiceMetricShape,
  checkServicePrefix,
  labelDefinition,
  type MetricType,
  type RegistryMetric,
} from './checks.ts';

export { InvalidMetricError } from './checks.ts';

export interface Counter {
  add(v: number, labels?: Record<string, string>): void;
}
export interface Histogram {
  record(v: number, labels?: Record<string, string>): void;
}

/** Where a meter's metrics belong: the page (shell code) or a remote's owning domain and name. */
interface ScopeIdentity {
  readonly domain: string;
  readonly service: string;
  readonly environment: string;
}

export interface InstrumentRecord {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly buckets: readonly number[] | undefined;
  readonly entry: RegistryMetric | undefined;
  readonly identity: ScopeIdentity;
  /** Label sets recorded so far, injected labels included (for the inventory). */
  readonly seen: Map<string, Readonly<Record<string, string>>>;
  readonly distinct: Map<string, Set<string>>;
  otel: OtelCounter | OtelHistogram | undefined;
}

export interface MetricsStats {
  /** Data points dropped because they broke a label or value rule. */
  droppedInvalid: number;
  /** Label values replaced or points dropped at a cardinality bound. */
  labelOverflow: number;
  /** Export intervals skipped because telemetry consent was not granted. */
  droppedNoConsent: number;
}

interface MetricsState {
  provider: MeterProvider | undefined;
  meter: ReturnType<MeterProvider['getMeter']> | undefined;
  instruments: Map<string, InstrumentRecord>;
  stats: MetricsStats;
  warned: Set<string>;
  removeListeners: () => void;
}

const SHELL = 'shell';
const MAX_SEEN_LABEL_SETS = 1000;
/** Distinct values kept per service-owned (Tier 3) label; beyond it the value becomes OVERFLOW. */
const MAX_SERVICE_LABEL_VALUES = 100;
const OVERFLOW = '__other__';
const MAX_BUCKETS = 50;

let exporterFactory: (url: string) => PushMetricExporter = (url) =>
  new OTLPMetricExporter({ url, temporalityPreference: AggregationTemporalityPreference.DELTA, timeoutMillis: 10_000 });
export function setMetricsInternalsForTests(o: { exporter?: (url: string) => PushMetricExporter }): void {
  if (o.exporter) exporterFactory = o.exporter;
}

/** The page's metrics state; instruments exist before initializeMetrics (they record once it runs). */
export function metricsState(): MetricsState {
  const rt = getRuntime();
  rt.metrics ??= {
    provider: undefined,
    meter: undefined,
    instruments: new Map(),
    stats: { droppedInvalid: 0, labelOverflow: 0, droppedNoConsent: 0 },
    warned: new Set(),
    removeListeners: () => {},
  } satisfies MetricsState;
  return rt.metrics as MetricsState;
}

function warnOnce(key: string, message: string): void {
  const s = metricsState();
  if (s.warned.has(key)) return;
  s.warned.add(key);
  const env = getIdentity()?.environment;
  if (env === undefined || env === 'local' || env === 'dev') console.warn(`@platform/frontend-sdk/metrics: ${message}`);
}

function resolveScope(scope?: Partial<MfeScope>): ScopeIdentity | undefined {
  const identity = getIdentity();
  if (!identity) return undefined; // before initializeCore, or a standalone remote
  const mfe = scope?.mfe;
  if (!mfe || mfe === SHELL) return { domain: identity.domain, service: identity.serviceName, environment: identity.environment };
  const ownerDomain = getRuntime().remotes[mfe];
  if (!ownerDomain) {
    throw new InvalidMetricError('namespace', `remote "${mfe}" is not in the remote manifest, so it has no owning domain for its metrics`);
  }
  return { domain: ownerDomain, service: mfe, environment: identity.environment };
}

function checkBuckets(name: string, buckets: readonly number[]): readonly number[] {
  const ok =
    Array.isArray(buckets) &&
    buckets.length > 0 &&
    buckets.length <= MAX_BUCKETS &&
    buckets.every((b, i) => Number.isFinite(b) && b >= 0 && (i === 0 || b > buckets[i - 1]!));
  if (!ok) throw new InvalidMetricError('registry', `metric "${name}": buckets must be 1-${MAX_BUCKETS} ascending, finite, non-negative bounds`);
  return Object.freeze([...buckets]);
}

function defaultBuckets(name: string): readonly number[] {
  return bucketPreset(name.endsWith('_bytes') ? 'payload_size' : 'request_duration')!; // _bytes: registry metrics only
}

function register(def: Omit<InstrumentRecord, 'seen' | 'distinct' | 'otel'>): InstrumentRecord {
  const s = metricsState();
  const existing = s.instruments.get(def.name);
  if (existing) {
    const same =
      existing.type === def.type &&
      existing.help === def.help &&
      JSON.stringify(existing.labelNames) === JSON.stringify(def.labelNames) &&
      JSON.stringify(existing.buckets) === JSON.stringify(def.buckets) &&
      JSON.stringify(existing.identity) === JSON.stringify(def.identity);
    if (!same) throw new InvalidMetricError('registry', `metric "${def.name}" is already registered with a different definition`);
    return existing;
  }
  const rec: InstrumentRecord = { ...def, seen: new Map(), distinct: new Map(), otel: undefined };
  s.instruments.set(def.name, rec);
  return rec;
}

function otelInstrument(rec: InstrumentRecord): OtelCounter | OtelHistogram | undefined {
  const meter = metricsState().meter;
  if (!meter) return undefined;
  if (!rec.otel) {
    rec.otel =
      rec.type === 'counter'
        ? meter.createCounter(rec.name, { description: rec.help, unit: '' })
        : meter.createHistogram(rec.name, {
            description: rec.help,
            unit: rec.name.endsWith('_bytes') ? 'By' : 's',
            advice: { explicitBucketBoundaries: [...(rec.buckets ?? [])] },
          });
  }
  return rec.otel;
}

/** Validates one data point; returns its full label set (injected labels added) or undefined to drop it. */
function pointLabels(rec: InstrumentRecord, value: number, labels: Record<string, string> | undefined): Record<string, string> | undefined {
  const s = metricsState();
  const drop = (reason: string) => {
    s.stats.droppedInvalid++;
    warnOnce(`${rec.name}:${reason}`, `dropped a ${rec.name} data point: ${reason}`);
    return undefined;
  };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return drop(`value ${String(value)} is not a finite, non-negative number`);
  const given = labels ?? {};
  const keys = Object.keys(given);
  for (const k of keys) {
    if (CONST_LABELS.includes(k)) return drop(`label "${k}" is injected centrally and must not be passed`);
    if (!rec.labelNames.includes(k)) return drop(`label "${k}" is not declared`);
  }
  const out: Record<string, string> = {};
  for (const k of rec.labelNames) {
    const raw = given[k];
    if (typeof raw !== 'string') return drop(`label "${k}" is missing or not a string`);
    let v = sanitizeString(raw);
    const def = labelDefinition(k);
    if (k === 'page_route' && v !== 'unknown' && !getRuntime().routeTemplates.has(v)) {
      s.stats.labelOverflow++;
      v = 'unknown';
    }
    if (k === 'mfe' && v !== SHELL && !getRuntime().remotes[v]) return drop(`mfe "${v}" is not in the remote manifest`);
    if (!allowsValue(rec.entry, k, v)) return drop(`label ${k}="${v}" is outside the registry vocabulary`);
    const seenValues = rec.distinct.get(k) ?? new Set<string>();
    if (!seenValues.has(v)) {
      const limit = def ? def.max_values : MAX_SERVICE_LABEL_VALUES;
      if (limit !== undefined && seenValues.size >= limit) {
        s.stats.labelOverflow++;
        if (def) return drop(`label "${k}" reached its ${limit}-value bound`);
        v = OVERFLOW;
      }
      seenValues.add(v);
      rec.distinct.set(k, seenValues);
    }
    out[k] = v;
  }
  out.domain = rec.identity.domain;
  out.service = rec.identity.service;
  out.environment = rec.identity.environment;
  return out;
}

function record(rec: InstrumentRecord, value: number, labels: Record<string, string> | undefined): void {
  const attrs = pointLabels(rec, value, labels);
  if (!attrs) return;
  const key = JSON.stringify(Object.entries(attrs).sort(([a], [b]) => a.localeCompare(b)));
  if (!rec.seen.has(key) && rec.seen.size < MAX_SEEN_LABEL_SETS) rec.seen.set(key, Object.freeze({ ...attrs }));
  const inst = otelInstrument(rec);
  if (!inst) return;
  if (rec.type === 'counter') (inst as OtelCounter).add(value, attrs);
  else (inst as OtelHistogram).record(value, attrs);
}

/**
 * Binds an instrument to its scope identity and returns its recording function. With a page
 * identity, `define` (the scope-dependent checks and registration) runs now, so its errors throw at
 * creation. Without one (a meter created at module scope before bootstrap's initializeCore, or a
 * remote run standalone) it runs on the first data point after initializeCore; until then points
 * are no-ops, and a definition that fails then drops its points (counted, warned) instead of throwing.
 */
function bind(scope: Partial<MfeScope> | undefined, name: string, define: (id: ScopeIdentity) => InstrumentRecord) {
  let rec = getIdentity() ? define(resolveScope(scope)!) : undefined;
  return (value: number, labels?: Record<string, string>): void => {
    if (!rec) {
      if (!getIdentity()) return; // still no page identity
      try {
        rec = define(resolveScope(scope)!); // retried on the next point, e.g. once the manifest loads
      } catch (e) {
        metricsState().stats.droppedInvalid++;
        warnOnce(`${name}:define`, `dropped a ${name} data point: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    record(rec, value, labels);
  };
}

/**
 * Tier 2: domain-shared metrics. Only names the registry lists as `tier: "domain"` for the scope's
 * domain, with exactly that entry's labels; help and buckets come from the entry. A remote's
 * scope uses its manifest ownerDomain. Without a page identity (a remote run standalone, or shell
 * code before initializeCore) the name is checked now and the domain once the identity exists;
 * until then the instruments are no-ops.
 */
export function getDomainMeter(scope?: Partial<MfeScope>): { counter(name: string): Counter; histogram(name: string): Histogram } {
  const make = (type: MetricType, name: string) => {
    const entry = checkDomainMetricEntry(type, name);
    return bind(scope, name, (id) => {
      checkDomainMetricOwner(entry, id.domain);
      return register({
        name,
        type,
        help: entry.help,
        labelNames: [...entry.labels],
        buckets: type === 'histogram' ? (bucketPreset(entry.buckets ?? '') ?? defaultBuckets(name)) : undefined,
        entry,
        identity: id,
      });
    });
  };
  return {
    counter: (name) => ({ add: make('counter', name) }),
    histogram: (name) => ({ record: make('histogram', name) }),
  };
}

/**
 * Tier 3: service-specific metrics, named `<domain>_<service>_<metric>` (gincommon ServicePrefix).
 * Counters end in _total; histograms in _seconds (`_bytes` is only for registry metrics with
 * `unit: bytes`, as in gincommon's CheckCustom). Labels are snake_case, not prohibited and not
 * domain/service/environment, which the SDK injects. Default buckets: the request_duration preset.
 * Before initializeCore, every rule but the service prefix is checked at creation (see getDomainMeter).
 */
export function getServiceMeter(scope?: Partial<MfeScope>): {
  counter(name: string, help: string, labels: readonly string[]): Counter;
  histogram(name: string, help: string, labels: readonly string[], buckets?: readonly number[]): Histogram;
} {
  const make = (type: MetricType, name: string, help: string, labels: readonly string[], buckets?: readonly number[]) => {
    checkServiceMetricShape(type, name, labels);
    if (typeof help !== 'string' || help.trim() === '') throw new InvalidMetricError('registry', `metric "${name}": help text is required`);
    const bounds = type === 'histogram' ? (buckets ? checkBuckets(name, buckets) : defaultBuckets(name)) : undefined;
    const labelNames = [...labels];
    return bind(scope, name, (id) => {
      checkServicePrefix(name, id.domain, id.service);
      return register({ name, type, help, labelNames, buckets: bounds, entry: undefined, identity: id });
    });
  };
  return {
    counter: (name, help, labels) => ({ add: make('counter', name, help, labels) }),
    histogram: (name, help, labels, buckets) => ({ record: make('histogram', name, help, labels, buckets) }),
  };
}

/** Wraps the exporter so nothing leaves the page without telemetry consent. */
function consentGated(inner: PushMetricExporter, stats: MetricsStats): PushMetricExporter {
  return {
    export: (metrics, cb) => {
      if (!hasConsent('telemetry')) {
        stats.droppedNoConsent++;
        cb({ code: 0 }); // delta: the interval is discarded, not retried
        return;
      }
      try {
        inner.export(metrics, cb);
      } catch {
        cb({ code: 1 });
      }
    },
    forceFlush: () => inner.forceFlush(),
    shutdown: () => inner.shutdown(),
    ...(inner.selectAggregationTemporality ? { selectAggregationTemporality: inner.selectAggregationTemporality.bind(inner) } : {}),
    ...(inner.selectAggregation ? { selectAggregation: inner.selectAggregation.bind(inner) } : {}),
  };
}

/**
 * Shell only: starts exporting to `${otlpBaseUrl}/v1/metrics` every `exportIntervalMs`
 * (default 60 s), with delta temporality. Requires initializeCore. A second call is a no-op. With
 * `telemetry.enabled: false` in the runtime config it is a no-op: nothing is exported.
 */
export function initializeMetrics(o: { otlpBaseUrl: string; exportIntervalMs?: number }): void {
  const identity = getIdentity();
  if (!identity) throw new NotInitializedError('initializeMetrics requires initializeCore first');
  const s = metricsState();
  if (s.provider) return;
  const interval = o.exportIntervalMs ?? 60_000;
  if (!Number.isInteger(interval) || interval < 1_000 || interval > 3_600_000) {
    throw new RangeError(`exportIntervalMs must be an integer in [1000, 3600000], got ${interval}`);
  }
  const url = collectorUrl(o.otlpBaseUrl, 'metrics');
  if (tryGetConfig()?.telemetry.enabled === false) return; // the runtime config's off switch
  const reader = new PeriodicExportingMetricReader({
    exporter: consentGated(exporterFactory(url), s.stats),
    exportIntervalMillis: interval,
    exportTimeoutMillis: Math.min(interval, 10_000),
  });
  const provider = new MeterProvider({
    resource: resourceFromAttributes({
      'service.name': identity.serviceName,
      'service.version': identity.buildVersion,
      'service.namespace': identity.domain,
      'deployment.environment.name': identity.environment,
    }),
    readers: [reader],
  });
  s.provider = provider;
  s.meter = provider.getMeter('@platform/frontend-sdk');
  const flush = () => void provider.forceFlush().catch(() => {});
  const onVisibility = () => {
    if (globalThis.document?.visibilityState === 'hidden') flush();
  };
  globalThis.addEventListener?.('pagehide', flush);
  globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
  s.removeListeners = () => {
    globalThis.removeEventListener?.('pagehide', flush);
    globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
  };
}

/** Internal: flushes and stops exporting; instruments go back to recording only the inventory. */
export async function shutdownMetrics(): Promise<void> {
  const s = metricsState();
  const provider = s.provider;
  if (!provider) return;
  s.removeListeners();
  s.provider = undefined;
  s.meter = undefined;
  for (const rec of s.instruments.values()) rec.otel = undefined;
  await provider.shutdown().catch(() => {});
}

/**
 * Shell only: Core Web Vitals. They are recorded as platform_web_vitals_seconds and
 * platform_web_vital_ratings_total, Tier 1 names that await governance ratification (design doc
 * §D5, §D6 K). Until the Tier 1 binding ships this records nothing.
 */
export function startWebVitals(): void {}

/** Internal: counters for drops and overflow. */
export function metricsStats(): Readonly<MetricsStats> {
  return metricsState().stats;
}
