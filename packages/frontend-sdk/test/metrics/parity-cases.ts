// Metric definitions and data points judged by both the SDK's registration checks and gincommon's
// metricslint. test/metrics/parity.test.ts asserts the SDK's verdicts; scripts/metrics-parity.ts
// runs every case through the real metricslint binary and fails when the two disagree.
import {
  InvalidMetricError,
  allowsValue,
  checkDomainMetric,
  checkServiceMetric,
  type MetricRule,
  type MetricType,
} from '../../src/metrics/checks.ts';

export interface ParityCase {
  name: string;
  tier: 'service' | 'domain';
  type: MetricType;
  metric: string;
  labels: Record<string, string>;
  domain: string;
  service: string;
  /** The SDK's verdict: 'ok' or the InvalidMetricError rule. */
  sdk: 'ok' | MetricRule;
  /**
   * Set when metricslint, judging a scrape, legitimately differs from the SDK, which applies
   * gincommon's construction-time CheckCustom: the reason is recorded, and the script skips the
   * comparison. 'skip' marks a case that cannot be expressed as a scrape.
   */
  lintDiffers?: string;
}

const svc = (c: Omit<ParityCase, 'tier' | 'domain' | 'service'> & Partial<ParityCase>): ParityCase => ({
  tier: 'service',
  domain: 'tender_management',
  service: 'web-app',
  ...c,
});
const dom = (c: Omit<ParityCase, 'tier' | 'domain' | 'service'> & Partial<ParityCase>): ParityCase => ({
  tier: 'domain',
  domain: 'iam',
  service: 'iam-admin',
  ...c,
});

export const PARITY_CASES: readonly ParityCase[] = [
  // Tier 3: valid
  svc({ name: 'counter', type: 'counter', metric: 'tender_management_web_app_draft_saves_total', labels: { kind: 'draft' }, sdk: 'ok' }),
  svc({ name: 'histogram', type: 'histogram', metric: 'tender_management_web_app_render_seconds', labels: {}, sdk: 'ok' }),
  svc({ name: 'remote prefix', type: 'counter', metric: 'tender_management_tenders_editor_saves_total', labels: {}, service: 'tenders-editor', sdk: 'ok' }),
  svc({ name: 'service already starting with its domain', type: 'counter', metric: 'iam_admin_clicks_total', labels: {}, domain: 'iam', service: 'iam-admin', sdk: 'ok' }),
  svc({ name: 'registry label with an allowed value', type: 'counter', metric: 'tender_management_web_app_exports_total', labels: { outcome: 'success' }, sdk: 'ok' }),
  svc({ name: 'registry label with a pattern', type: 'counter', metric: 'tender_management_web_app_calls_total', labels: { route: '/tenders/:id' }, sdk: 'ok' }),
  // Tier 3: names
  svc({ name: 'wrong service prefix', type: 'counter', metric: 'tender_management_other_app_saves_total', labels: {}, sdk: 'namespace' }),
  svc({ name: 'another domain', type: 'counter', metric: 'billing_web_app_saves_total', labels: {}, sdk: 'namespace' }),
  svc({ name: 'unclassified name', type: 'counter', metric: 'web_app_saves_total', labels: {}, sdk: 'namespace' }),
  svc({ name: 'unratified platform name', type: 'counter', metric: 'platform_web_custom_total', labels: {}, sdk: 'namespace' }),
  svc({ name: 'not snake_case', type: 'counter', metric: 'tender_management_web_app_Saves_total', labels: {}, sdk: 'namespace' }),
  svc({ name: 'counter without _total', type: 'counter', metric: 'tender_management_web_app_saves', labels: {}, sdk: 'suffix' }),
  svc({ name: 'histogram without _seconds', type: 'histogram', metric: 'tender_management_web_app_render_ms', labels: {}, sdk: 'suffix' }),
  svc({ name: 'service histogram in bytes', type: 'histogram', metric: 'tender_management_web_app_upload_bytes', labels: {}, sdk: 'suffix' }),
  svc({
    name: 'runtime prefix',
    type: 'counter',
    metric: 'go_tender_total',
    labels: {},
    sdk: 'namespace',
    lintDiffers: 'metricslint exempts go_* runtime collectors on a scrape; CheckCustom refuses to create one',
  }),
  svc({
    name: 'removed legacy name',
    type: 'counter',
    metric: 'http_requests_total',
    labels: {},
    sdk: 'registry',
  }),
  svc({
    name: 'domain registry name as a service metric',
    type: 'counter',
    metric: 'iam_tenant_resolution_total',
    labels: { strategy: 'slug', outcome: 'success' },
    domain: 'iam',
    service: 'iam-admin',
    sdk: 'registry',
    lintDiffers: 'metricslint accepts the registry metric itself; CheckCustom refuses to create it outside the registry path (getDomainMeter)',
  }),
  // Tier 3: labels
  svc({ name: 'prohibited label', type: 'counter', metric: 'tender_management_web_app_logins_total', labels: { user_id: '1' }, sdk: 'prohibited_label' }),
  svc({ name: 'prohibited suffix', type: 'counter', metric: 'tender_management_web_app_orders_total', labels: { order_id: '1' }, sdk: 'prohibited_label' }),
  svc({ name: 'label not snake_case', type: 'counter', metric: 'tender_management_web_app_tabs_total', labels: { tabName: 'x' }, sdk: 'label_vocabulary' }),
  svc({ name: 'registry label outside its vocabulary', type: 'counter', metric: 'tender_management_web_app_jobs_total', labels: { outcome: 'maybe' }, sdk: 'label_vocabulary' }),
  svc({ name: 'registry label outside its pattern', type: 'counter', metric: 'tender_management_web_app_hits_total', labels: { route: 'tenders' }, sdk: 'label_vocabulary' }),
  svc({
    name: 'declaring an injected label',
    type: 'counter',
    metric: 'tender_management_web_app_views_total',
    labels: { environment: 'dev' },
    sdk: 'required_labels',
    lintDiffers: 'skip: a scrape cannot tell a declared environment label from the injected one',
  }),
  // Tier 2
  dom({ name: 'domain metric', type: 'counter', metric: 'iam_tenant_resolution_total', labels: { strategy: 'slug', outcome: 'success' }, sdk: 'ok' }),
  dom({ name: 'domain histogram', type: 'histogram', metric: 'iam_lifecycle_event_lag_seconds', labels: { event_type: 'TenantCreated' }, sdk: 'ok' }),
  dom({ name: 'narrowed label value', type: 'counter', metric: 'iam_auth_session_revoke_failed_total', labels: { reason: 'transport' }, sdk: 'ok' }),
  dom({ name: 'value outside the narrowed vocabulary', type: 'counter', metric: 'iam_auth_session_revoke_failed_total', labels: { reason: 'timeout' }, sdk: 'label_vocabulary' }),
  dom({ name: 'from another domain', type: 'counter', metric: 'iam_tenant_resolution_total', labels: { strategy: 'slug', outcome: 'success' }, domain: 'tender_management', service: 'web-app', sdk: 'namespace' }),
  dom({ name: 'missing registry label', type: 'counter', metric: 'iam_tenant_resolution_total', labels: { strategy: 'slug' }, sdk: 'label_vocabulary' }),
  dom({ name: 'extra label', type: 'counter', metric: 'iam_tenant_resolution_total', labels: { strategy: 'slug', outcome: 'success', extra: 'x' }, sdk: 'label_vocabulary' }),
  dom({ name: 'wrong type', type: 'histogram', metric: 'iam_tenant_resolution_total', labels: { strategy: 'slug', outcome: 'success' }, sdk: 'registry' }),
  dom({ name: 'not in the registry', type: 'counter', metric: 'iam_made_up_total', labels: {}, sdk: 'registry', lintDiffers: 'metricslint reads an unregistered iam_* name as a Tier 3 candidate (and fails its prefix); the SDK reports it as not a registry metric' }),
];

/** The SDK's verdict on a case, from the same checks getServiceMeter/getDomainMeter and record() apply. */
export function sdkVerdict(c: ParityCase): 'ok' | MetricRule {
  try {
    const names = Object.keys(c.labels);
    let entry;
    if (c.tier === 'service') {
      checkServiceMetric(c.type, c.metric, names, c.domain, c.service);
    } else {
      entry = checkDomainMetric(c.type, c.metric, c.domain);
      const declared = [...entry.labels].sort();
      if (JSON.stringify(declared) !== JSON.stringify([...names].sort())) return 'label_vocabulary';
    }
    for (const [k, v] of Object.entries(c.labels)) if (!allowsValue(entry, k, v)) return 'label_vocabulary';
    return 'ok';
  } catch (e) {
    if (e instanceof InvalidMetricError) return e.rule;
    throw e;
  }
}
