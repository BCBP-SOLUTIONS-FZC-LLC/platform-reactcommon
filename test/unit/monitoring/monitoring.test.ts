// monitoring/ against the registry and the Tier 1 proposal (the counterpart of platform-events'
// TestDashboards_RegistryCompliance and rules_test.go): every metric the dashboard and the rules use is
// registered or proposed, its label matchers stay inside the label vocabulary, rules that depend on a
// proposed metric live in *.proposed groups and say so, every alert has a runbook, every proposed metric
// is used, and the proposal's per-metric enums are the values the SDK's instrument port records.
// metricslint's own verdict on the same files is `pnpm metrics:proposal` (needs Go).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { testenv } from '../../testenv/index.ts';

const ROOT = testenv.root;
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

interface Label { values?: string[]; pattern?: string }
interface Metric { name: string; type: string; labels: string[]; label_values?: Record<string, string[]> }
const registry = JSON.parse(read('packages/frontend-sdk/contracts/metric-registry.json')) as {
  constLabels: string[];
  labels: Record<string, Label>;
  metrics: (Metric & { tier: string })[];
};
const proposal = JSON.parse(read('monitoring/registry/platform-web.proposal.json')) as {
  labels: Record<string, Label>;
  metrics: Metric[];
  amendments: { kind: string; metric?: string; label: string; add?: string[] }[];
};

const proposed = new Map(proposal.metrics.map((m) => [m.name, m]));
const registered = new Map(registry.metrics.filter((m) => m.tier !== 'legacy').map((m) => [m.name, m]));
const labelDef = (name: string): Label | undefined => proposal.labels[name] ?? registry.labels[name];

/** The metric a series name belongs to (histogram series suffixes stripped), if registered or proposed. */
function family(series: string): Metric | undefined {
  for (const name of [series, series.replace(/_(bucket|sum|count)$/, '')]) {
    const m = proposed.get(name) ?? registered.get(name);
    if (m) {
      const amended = proposal.amendments.filter((a) => a.kind === 'label_values' && a.metric === m.name);
      if (amended.length === 0) return m;
      const label_values = { ...m.label_values };
      for (const a of amended) label_values[a.label] = [...(label_values[a.label] ?? labelDef(a.label)?.values ?? []), ...a.add!];
      return { ...m, label_values };
    }
  }
  return undefined;
}

/** Every `platform_…{matchers}` or bare `platform_…` reference in a PromQL expression. */
function references(expr: string): { series: string; matchers: { label: string; op: string; value: string }[] }[] {
  const out: ReturnType<typeof references> = [];
  for (const m of expr.matchAll(/\b(platform_[a-z0-9_]+)\b(?!:)(\{([^}]*)\})?/g)) {
    const matchers = [...(m[3] ?? '').matchAll(/([a-z_]+)\s*(=~|!~|!=|=)\s*"([^"]*)"/g)].map((x) => ({ label: x[1]!, op: x[2]!, value: x[3]! }));
    out.push({ series: m[1]!, matchers });
  }
  return out;
}

/** Problems with one expression: unknown metrics, labels a metric does not have, values outside the vocabulary. */
function problemsIn(expr: string, where: string): string[] {
  const problems: string[] = [];
  for (const ref of references(expr)) {
    const m = family(ref.series);
    if (!m) {
      problems.push(`${where}: ${ref.series} is neither registered nor proposed`);
      continue;
    }
    const allowed = new Set([...registry.constLabels, ...m.labels, ...(ref.series.endsWith('_bucket') ? ['le'] : [])]);
    for (const { label, op, value } of ref.matchers) {
      if (!allowed.has(label)) problems.push(`${where}: ${m.name} has no label ${label}`);
      if (value.includes('$') || registry.constLabels.includes(label) || label === 'le') continue; // Grafana variables, identity
      const vocab = m.label_values?.[label] ?? labelDef(label)?.values;
      if (!vocab) continue; // pattern labels: values are templates or names
      const values = op.endsWith('~') ? value.split('|') : [value];
      for (const v of values) if (!vocab.includes(v)) problems.push(`${where}: ${m.name}{${label}="${v}"} is outside ${label}'s vocabulary`);
    }
  }
  return problems;
}

interface Rule { record?: string; alert?: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }
const ruleFiles = readdirSync(join(ROOT, 'monitoring/prometheus')).filter((f) => f.endsWith('.rules.yml'));
const groups = ruleFiles.flatMap((f) => (parse(read(`monitoring/prometheus/${f}`)) as { groups: { name: string; rules: Rule[] }[] }).groups.map((g) => ({ ...g, file: f })));
const dashboards = readdirSync(join(ROOT, 'monitoring/grafana')).filter((f) => f.endsWith('.json'));

/** Panel and template-variable queries of a dashboard. */
function dashboardQueries(file: string): { where: string; expr: string }[] {
  const d = JSON.parse(read(`monitoring/grafana/${file}`)) as {
    panels: { title: string; targets?: { expr?: string }[] }[];
    templating: { list: { name: string; type: string; query?: string | { query: string } }[] };
  };
  const panels = d.panels.flatMap((p) => (p.targets ?? []).filter((t) => t.expr).map((t) => ({ where: `${file} "${p.title}"`, expr: t.expr! })));
  const vars = d.templating.list
    .filter((v) => v.type === 'query')
    .map((v) => ({ where: `${file} $${v.name}`, expr: typeof v.query === 'string' ? v.query : v.query!.query }));
  return [...panels, ...vars];
}

describe('dashboards', () => {
  it.each(dashboards)('%s queries only registered or proposed metrics, with their own labels and values', (file) => {
    const queries = dashboardQueries(file);
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.flatMap((q) => problemsIn(q.expr, q.where))).toEqual([]);
  });
});

describe('rules', () => {
  // A recording rule from a .proposed group carries its inputs' status.
  const proposedRecordings = new Set(groups.filter((g) => g.name.endsWith('.proposed.recording')).flatMap((g) => g.rules.map((r) => r.record).filter(Boolean)));
  // An amended metric counts when the rule selects a value the amendment adds (page_route, mfe).
  const amendedValues = (series: string) => proposal.amendments.filter((a) => a.kind === 'label_values' && a.metric === series).flatMap((a) => a.add!);
  const dependsOnProposed = (r: Rule) =>
    references(r.expr).some(
      (ref) =>
        proposed.has(ref.series.replace(/_(bucket|sum|count)$/, '')) ||
        ref.matchers.some((m) => m.value.split('|').some((v) => amendedValues(ref.series).includes(v))),
    ) ||
    [...r.expr.matchAll(/\b([a-z_]+:[a-z0-9_:]+)/g)].some((m) => proposedRecordings.has(m[1]!));

  it('query only registered or proposed metrics, with their own labels and values', () => {
    expect(groups.flatMap((g) => g.rules.flatMap((r) => problemsIn(r.expr, `${g.file} ${r.record ?? r.alert}`)))).toEqual([]);
  });

  it('that depend on a proposed metric live in *.proposed groups, and those groups hold only such rules', () => {
    for (const g of groups) {
      for (const r of g.rules) {
        expect(dependsOnProposed(r), `${g.name} ${r.record ?? r.alert}`).toBe(g.name.includes('.proposed'));
        if (r.alert && dependsOnProposed(r)) expect(r.labels?.metric_status, r.alert).toBe('proposed');
      }
    }
  });

  it('every alert has a severity, a summary, a description and a runbook section that exists', () => {
    const runbooks = read('docs/observability/runbooks.md');
    const anchors = new Set([...runbooks.matchAll(/^#{2,4} (.+)$/gm)].map((m) => m[1]!.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')));
    for (const r of groups.flatMap((g) => g.rules).filter((x) => x.alert)) {
      expect(['critical', 'warning', 'info'], r.alert).toContain(r.labels?.severity);
      expect(r.annotations?.summary, r.alert).toBeTruthy();
      expect(r.annotations?.description, r.alert).toBeTruthy();
      const anchor = /runbooks\.md#([a-z0-9-]+)$/.exec(r.annotations?.runbook_url ?? '')?.[1];
      expect(anchor, `${r.alert} runbook_url`).toBe(r.alert!.toLowerCase());
      expect(anchors.has(anchor!), `runbooks.md has no section ${r.alert}`).toBe(true);
    }
  });
});

describe('the proposal', () => {
  it('every proposed metric is on a dashboard and in a rule (its dependants)', () => {
    const dashboardText = dashboards.map((f) => dashboardQueries(f).map((q) => q.expr).join('\n')).join('\n');
    const rulesText = groups.flatMap((g) => g.rules.map((r) => r.expr)).join('\n');
    for (const name of proposed.keys()) {
      expect(dashboardText, `${name} on a dashboard`).toMatch(new RegExp(`\\b${name}(_bucket|_count|_sum)?\\b`));
      expect(rulesText, `${name} in a rule`).toMatch(new RegExp(`\\b${name}(_bucket|_count|_sum)?\\b`));
    }
  });

  it("per-metric enums are exactly the values the SDK's instrument port records", () => {
    const port = read('packages/frontend-sdk/src/internal/instruments.ts');
    /** The string-literal union of `field` inside the port method `method`. */
    const union = (method: string, field: string): string[] => {
      const body = new RegExp(`${method}\\([\\s\\S]*?\\): void;`).exec(port)?.[0] ?? '';
      const type = new RegExp(`\\b${field}\\??:\\s*([^;\\n]+)`).exec(body)?.[1] ?? '';
      return [...type.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
    };
    const enumOf = (metric: string, label: string) => proposed.get(metric)?.label_values?.[label] ?? labelDef(label)?.values;
    expect(union('httpClient', 'reason')).toEqual(enumOf('platform_web_http_client_failures_total', 'reason'));
    expect(union('httpClient', 'status_class')).toEqual(enumOf('platform_web_http_client_duration_seconds', 'status_class'));
    expect(union('httpClient', 'error_class')).toEqual(enumOf('platform_web_http_client_duration_seconds', 'error_class'));
    expect(union('remoteLoad', 'outcome')).toEqual(enumOf('platform_web_remote_load_seconds', 'outcome'));
    expect(union('remoteLoad', 'reason')).toEqual(enumOf('platform_web_remote_load_failures_total', 'reason'));
    expect(union('webError', 'source')).toEqual(enumOf('platform_web_errors_total', 'source'));
  });

  it('new labels are not already in the registry, and every label a proposed metric uses is defined', () => {
    for (const name of Object.keys(proposal.labels)) expect(registry.labels[name], name).toBeUndefined();
    for (const m of proposal.metrics) for (const l of m.labels) expect(labelDef(l), `${m.name} ${l}`).toBeDefined();
  });

  it('flags a metric outside the registry and a value outside a vocabulary (the checks above are not vacuous)', () => {
    expect(problemsIn('rate(platform_web_page_views_total[5m])', 'x')).toEqual(['x: platform_web_page_views_total is neither registered nor proposed']);
    expect(problemsIn('platform_web_errors_total{source="console"}', 'x')).toEqual(['x: platform_web_errors_total{source="console"} is outside source\'s vocabulary']);
    expect(problemsIn('platform_web_errors_total{route="/x"}', 'x')).toEqual(['x: platform_web_errors_total has no label route']);
  });
});
