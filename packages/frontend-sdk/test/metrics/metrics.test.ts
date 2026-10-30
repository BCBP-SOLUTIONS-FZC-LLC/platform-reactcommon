import { AggregationTemporality, InMemoryMetricExporter, type PushMetricExporter } from '@opentelemetry/sdk-metrics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeCore, setConsentProvider, type ConsentCategory } from '../../src/core/index.ts';
import { getRuntime, resetRuntimeForTests } from '../../src/internal/runtime.ts';
import { servicePrefix, suffixProblem } from '../../src/metrics/checks.ts';
import { InvalidMetricError, getDomainMeter, getServiceMeter, initializeMetrics, startWebVitals } from '../../src/metrics/index.ts';
import { renderMetricInventory } from '../../src/metrics/inventory.ts';
import { metricsStats, setMetricsInternalsForTests, shutdownMetrics } from '../../src/metrics/metrics.ts';
import { PARITY_CASES, sdkVerdict } from './parity-cases.ts';

let exporter: InMemoryMetricExporter;
let exportedUrl: string | undefined;
const consent = (granted: ConsentCategory[]) => setConsentProvider({ has: (c) => granted.includes(c), subscribe: () => () => {} });
const core = (domain = 'tender_management') => initializeCore({ serviceName: 'web-app', domain, environment: 'dev', buildVersion: '1.0.0' });

/** Exported data points of `name`, after a flush. */
async function points(name: string) {
  await shutdownMetrics();
  return exporter
    .getMetrics()
    .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
    .filter((m) => m.descriptor.name === name)
    .flatMap((m) => m.dataPoints.map((p) => ({ attributes: p.attributes, value: p.value, unit: m.descriptor.unit, temporality: m.aggregationTemporality })));
}

beforeEach(() => {
  resetRuntimeForTests();
  exporter = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  exportedUrl = undefined;
  setMetricsInternalsForTests({
    exporter: (url) => {
      exportedUrl = url;
      return exporter as PushMetricExporter;
    },
  });
  core();
  consent(['telemetry']);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  await shutdownMetrics();
  vi.restoreAllMocks();
});

describe('parity cases (also run against metricslint by scripts/metrics-parity.ts)', () => {
  it.each(PARITY_CASES.map((c) => [`${c.tier}: ${c.name}`, c] as const))('%s', (_, c) => {
    expect(sdkVerdict(c)).toBe(c.sdk);
  });
});

describe('rules', () => {
  it('builds the service prefix like gincommon ServicePrefix', () => {
    expect(servicePrefix('tender_management', 'web-app')).toBe('tender_management_web_app_');
    expect(servicePrefix('iam', 'iam-admin')).toBe('iam_admin_');
    expect(servicePrefix('iam', '--Odd..Name--')).toBe('iam_odd_name_');
  });

  it('checks suffixes like gincommon suffixError', () => {
    expect(suffixProblem('counter', 'x_total')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_bytes', 'bytes')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_seconds', 'seconds')).toBeUndefined();
    expect(suffixProblem('histogram', 'x_ms', 'milliseconds')).toContain('not supported');
  });
});

describe('initializeMetrics', () => {
  it('exports delta points with the injected identity labels to <otlpBaseUrl>/v1/metrics', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', ['kind']).add(2, { kind: 'draft' });
    const [p] = await points('tender_management_web_app_saves_total');
    expect(exportedUrl).toBe('http://localhost/otel/v1/metrics');
    expect(p).toEqual({
      attributes: { kind: 'draft', domain: 'tender_management', service: 'web-app', environment: 'dev' },
      value: 2,
      unit: '',
      temporality: AggregationTemporality.DELTA,
    });
  });

  it('starts recording instruments created before it', async () => {
    const c = getServiceMeter().counter('tender_management_web_app_early_total', 'Early.', []);
    c.add(1);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    c.add(5);
    expect((await points('tender_management_web_app_early_total')).map((p) => p.value)).toEqual([5]);
  });

  it('validates its options and needs initializeCore', () => {
    expect(() => initializeMetrics({ otlpBaseUrl: '/otel', exportIntervalMs: 10 })).toThrow(RangeError);
    expect(() => initializeMetrics({ otlpBaseUrl: 'https://collector.example' })).toThrow(TypeError);
    resetRuntimeForTests();
    expect(() => initializeMetrics({ otlpBaseUrl: '/otel' })).toThrow('initializeCore');
  });

  it('exports nothing without telemetry consent', async () => {
    consent([]);
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().counter('tender_management_web_app_saves_total', 'Saves.', []).add(1);
    expect(await points('tender_management_web_app_saves_total')).toEqual([]);
    expect(metricsStats().droppedNoConsent).toBeGreaterThan(0);
  });

  it('records histograms in seconds with the request_duration preset by default', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter().histogram('tender_management_web_app_render_seconds', 'Render.', []).record(0.3);
    const [p] = await points('tender_management_web_app_render_seconds');
    expect(p!.unit).toBe('s');
    expect((p!.value as { count: number }).count).toBe(1);
  });
});

describe('meters', () => {
  it('throw InvalidMetricError with the rule at registration', () => {
    const m = getServiceMeter();
    const rule = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidMetricError);
        return (e as InvalidMetricError).rule;
      }
      return 'ok';
    };
    expect(rule(() => m.counter('tender_management_web_app_x', 'X.', []))).toBe('suffix');
    expect(rule(() => m.counter('tender_management_web_app_x_total', ' ', []))).toBe('registry');
    expect(rule(() => m.counter('tender_management_web_app_x_total', 'X.', ['service']))).toBe('required_labels');
    expect(rule(() => m.histogram('tender_management_web_app_x_seconds', 'X.', [], [1, 0.5]))).toBe('registry');
    expect(rule(() => getDomainMeter().counter('iam_tenant_resolution_total'))).toBe('namespace');
  });

  it('are idempotent for the same definition and reject a different one', () => {
    const a = getServiceMeter().counter('tender_management_web_app_x_total', 'X.', ['kind']);
    const b = getServiceMeter().counter('tender_management_web_app_x_total', 'X.', ['kind']);
    expect(a).not.toBe(b); // handles differ, the instrument is shared
    expect(() => getServiceMeter().counter('tender_management_web_app_x_total', 'Other help.', ['kind'])).toThrow('different definition');
  });

  it('give a remote its owning domain and name as identity', async () => {
    getRuntime().remotes = { 'tenders-editor': 'tender_management', 'iam-admin': 'iam' };
    initializeMetrics({ otlpBaseUrl: '/otel' });
    getServiceMeter({ mfe: 'iam-admin' }).counter('iam_admin_clicks_total', 'Clicks.', []).add(1);
    getDomainMeter({ mfe: 'iam-admin' }).counter('iam_tenant_resolution_total').add(1, { strategy: 'slug', outcome: 'success' });
    expect((await points('iam_admin_clicks_total'))[0]!.attributes).toEqual({ domain: 'iam', service: 'iam-admin', environment: 'dev' });
    expect(() => getServiceMeter({ mfe: 'unknown-remote' })).not.toThrow();
    expect(() => getServiceMeter({ mfe: 'unknown-remote' }).counter('x_total', 'X.', [])).toThrow('remote manifest');
  });

  it('are no-ops without a page identity (a remote run standalone)', () => {
    resetRuntimeForTests();
    expect(() => getServiceMeter().counter('anything', '', []).add(1)).not.toThrow();
    expect(() => getDomainMeter().histogram('anything').record(1)).not.toThrow();
    expect(renderMetricInventory()).toBe('');
  });
});

describe('data points', () => {
  it('are dropped (never thrown) when they break a rule, and counted', async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const c = getServiceMeter().counter('tender_management_web_app_jobs_total', 'Jobs.', ['outcome']);
    c.add(1, { outcome: 'maybe' }); // outside the registry vocabulary
    c.add(1, {}); // missing label
    c.add(1, { outcome: 'success', extra: 'x' }); // undeclared label
    c.add(1, { outcome: 'success', service: 'x' } as Record<string, string>); // injected label
    c.add(-1, { outcome: 'success' }); // negative
    c.add(Number.NaN, { outcome: 'success' });
    c.add(1, { outcome: 'success' });
    expect(metricsStats().droppedInvalid).toBe(6);
    expect((await points('tender_management_web_app_jobs_total')).map((p) => p.value)).toEqual([1]);
  });

  it("record page_route as 'unknown' unless the router registered it", async () => {
    getRuntime().routeTemplates.add('/tenders/:id');
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const h = getServiceMeter().counter('tender_management_web_app_views_total', 'Views.', ['page_route']);
    h.add(1, { page_route: '/tenders/:id' });
    h.add(1, { page_route: '/admin/secret' });
    const routes = (await points('tender_management_web_app_views_total')).map((p) => p.attributes.page_route).sort();
    expect(routes).toEqual(['/tenders/:id', 'unknown']);
    expect(metricsStats().labelOverflow).toBe(1);
  });

  it("cap a service label at 100 values, then record '__other__'", async () => {
    initializeMetrics({ otlpBaseUrl: '/otel' });
    const c = getServiceMeter().counter('tender_management_web_app_tabs_total', 'Tabs.', ['tab']);
    for (let i = 0; i < 105; i++) c.add(1, { tab: `t${i}` });
    const values = new Set((await points('tender_management_web_app_tabs_total')).map((p) => p.attributes.tab));
    expect(values.size).toBe(101);
    expect(values.has('__other__')).toBe(true);
  });

  it('drop points past a registry label bound', () => {
    const c = getServiceMeter().counter('tender_management_web_app_strategies_total', 'S.', ['strategy']); // strategy: max_values 20
    for (let i = 0; i < 25; i++) c.add(1, { strategy: `s${i}` });
    expect(metricsStats().droppedInvalid).toBe(5);
  });

  it('accept the mfe label only for manifest remotes and the shell', () => {
    getRuntime().remotes = { tenders: 'tender_management' };
    const c = getServiceMeter().counter('tender_management_web_app_loads_total', 'Loads.', ['mfe']);
    c.add(1, { mfe: 'shell' });
    c.add(1, { mfe: 'tenders' });
    c.add(1, { mfe: 'evil' });
    expect(metricsStats().droppedInvalid).toBe(1);
  });

  it('warn once per metric and reason in dev', () => {
    const c = getServiceMeter().counter('tender_management_web_app_w_total', 'W.', []);
    c.add(-1);
    c.add(-2);
    expect(console.warn).toHaveBeenCalledTimes(2); // value differs, so two reasons
    c.add(-1);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe('renderMetricInventory', () => {
  it('renders every recorded label set with the injected labels, as Prometheus text', () => {
    const m = getServiceMeter();
    m.counter('tender_management_web_app_saves_total', 'Saves "quoted"\nhelp.', ['kind']).add(1, { kind: 'a"b' });
    m.histogram('tender_management_web_app_render_seconds', 'Render.', [], [0.1, 1]).record(0.5);
    expect(renderMetricInventory()).toBe(
      [
        '# HELP tender_management_web_app_render_seconds Render.',
        '# TYPE tender_management_web_app_render_seconds histogram',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="0.1"} 1',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="1"} 1',
        'tender_management_web_app_render_seconds_bucket{domain="tender_management",environment="dev",service="web-app",le="+Inf"} 1',
        'tender_management_web_app_render_seconds_sum{domain="tender_management",environment="dev",service="web-app"} 0',
        'tender_management_web_app_render_seconds_count{domain="tender_management",environment="dev",service="web-app"} 1',
        '# HELP tender_management_web_app_saves_total Saves "quoted"\\nhelp.',
        '# TYPE tender_management_web_app_saves_total counter',
        'tender_management_web_app_saves_total{domain="tender_management",environment="dev",kind="a\\"b",service="web-app"} 1',
        '',
      ].join('\n'),
    );
  });
});

describe('startWebVitals', () => {
  it('records nothing until the Tier 1 binding (design doc §D6 K)', () => {
    expect(() => startWebVitals()).not.toThrow();
    expect(renderMetricInventory()).toBe('');
  });
});
