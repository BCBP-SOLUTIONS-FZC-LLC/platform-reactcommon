// The gateway's allowlists (examples/collector/gateway.yaml) are the metric registry's vocabulary: the
// domains and the service pattern of contracts/metric-registry.json, and the Tier 1 browser labels of
// monitoring/registry/platform-web.proposal.json. A domain added to the registry, or a label value
// ratified, must reach the gateway too, or its points are dropped there. No Docker: test/collector runs
// the configuration itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_REGISTRY } from '../../../packages/frontend-sdk/src/internal/generated/metric-registry.ts';
import { MAX_SERVICE_LABELS } from '../../../packages/frontend-sdk/src/metrics/checks.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const gateway = readFileSync(join(ROOT, 'examples/collector/gateway.yaml'), 'utf8');
const proposal = JSON.parse(readFileSync(join(ROOT, 'monitoring/registry/platform-web.proposal.json'), 'utf8')) as {
  labels: Record<string, { pattern?: string; values?: string[] }>;
  metrics: { name: string }[];
};
/** Tier 1 (the proposal) and Tier 2 (registry domain metrics): the names whose label keys the registry fixes. */
const tier1 = proposal.metrics.map((m) => m.name);
const registered = [...tier1, ...(METRIC_REGISTRY.metrics as readonly { name: string; tier: string }[]).filter((m) => m.tier === 'domain').map((m) => m.name)];
const labels = METRIC_REGISTRY.labels as Record<string, { pattern?: string; values?: readonly string[] }>;

/** The regex the gateway's filter (filter/browser-allowlist) matches `subject` against (a metric name, or attributes["<label>"]). */
const allowlist = gateway.slice(gateway.indexOf('  filter/browser-allowlist:'), gateway.indexOf('  transform/browser-labels:'));
function gatewayPattern(subject: string): string[] {
  const escaped = subject.replace(/[[\]"]/g, (c) => `\\${c}`);
  return [...allowlist.matchAll(new RegExp(`IsMatch\\(${escaped}, "([^"]+)"\\)`, 'g'))].map((m) => m[1]!.replace(/\\\\/g, '\\'));
}
const alternation = (values: readonly string[]) => `(${values.join('|')})`;

describe('examples/collector/gateway.yaml allowlists', () => {
  const domains = labels.domain!.values!;

  it('accepts exactly the registry domains, as the domain label and as the metric-name prefix', () => {
    expect(domains.length).toBeGreaterThan(0);
    expect(gatewayPattern('attributes["domain"]')).toEqual([`^${alternation(domains)}$`]);
    expect(gatewayPattern('name')).toEqual([`^${alternation(['platform_web', ...domains])}_[a-z0-9_]+_(total|seconds|bytes)$`, '^platform_web_', `^${alternation(tier1)}$`]);
  });

  // Review 2: any platform_web_<x>_total minted series.
  it('accepts only the proposal\'s platform_web_* names', () => {
    expect(tier1.length).toBeGreaterThan(0);
    expect(allowlist).toContain(`- IsMatch(name, "^platform_web_") and not IsMatch(name, "^${alternation(tier1)}$")`);
  });

  it('uses the registry pattern for service, and the Tier 1 proposal for the browser labels', () => {
    expect(gatewayPattern('attributes["service"]')).toEqual([labels.service!.pattern]);
    for (const label of ['page_route', 'mfe']) expect(gatewayPattern(`attributes["${label}"]`), label).toEqual([proposal.labels[label]!.pattern]);
    for (const label of ['vital', 'rating']) expect(gatewayPattern(`attributes["${label}"]`), label).toEqual([`^${alternation(proposal.labels[label]!.values!)}$`]);
  });

  it('checks every label the proposal defines', () => {
    for (const label of Object.keys(proposal.labels)) expect(gatewayPattern(`attributes["${label}"]`), label).toHaveLength(1);
  });

  // Review 2: extra label keys passed the gateway, so anyone POSTing to /otel could mint series.
  it('keeps exactly the registry and Tier 1 proposal label keys on a Tier 1 or Tier 2 metric point', () => {
    const m = /context: datapoint\n\s+statements:\n\s+- keep_keys\(attributes, \[([^\]]+)\]\) where IsMatch\(metric\.name, "([^"]+)"\)/.exec(gateway);
    expect(m).not.toBeNull();
    const keys = m![1];
    expect(m![2]).toBe(`^${alternation(registered)}$`);
    const want = [...new Set([...Object.keys(labels), ...Object.keys(proposal.labels)])].sort();
    expect(JSON.parse(`[${keys!}]`)).toEqual(want);
    for (const constLabel of METRIC_REGISTRY.constLabels) expect(want).toContain(constLabel);
  });

  it('bounds a Tier 3 point\'s keys: snake_case, not prohibited, the const labels and at most 8 others', () => {
    const notRegistered = ` where not IsMatch(metric.name, "^${alternation(registered)}$")`;
    expect(gateway).toContain(`- keep_matching_keys(attributes, "^[a-z][a-z0-9_]{0,63}$")${notRegistered}`);
    const prohibited = `^${alternation(METRIC_REGISTRY.prohibitedLabels)}$|${alternation(METRIC_REGISTRY.prohibitedLabelSuffixes)}$`;
    expect(gateway).toContain(`- delete_matching_keys(attributes, "${prohibited}")${notRegistered}`);
    const consts = METRIC_REGISTRY.constLabels.map((l) => `"${l}"`).join(', ');
    // The SDK sets no cap on a Tier 3 metric's label count; 8 is the gateway's.
    expect(gateway).toContain(`- limit(attributes, ${METRIC_REGISTRY.constLabels.length + MAX_SERVICE_LABELS}, [${consts}])${notRegistered}`);
    const prohibitedRe = new RegExp(prohibited);
    for (const k of ['user_id', 'email', 'order_uuid', 'api_token']) expect(prohibitedRe.test(k), k).toBe(true);
    for (const k of ['kind', 'operation', 'domain', 'service', 'environment']) expect(prohibitedRe.test(k), k).toBe(false);
  });

  it('keeps only the resource attributes the SDK sets on traces and logs, and none on metrics (review 3)', () => {
    const sdkResource = ['service.name', 'service.version', 'service.namespace', 'deployment.environment.name'];
    for (const signal of ['tracing/tracing.ts', 'logging/logging.ts', 'metrics/metrics.ts']) {
      const src = readFileSync(join(ROOT, 'packages/frontend-sdk/src', signal), 'utf8');
      const set = /resourceFromAttributes\(\{([^}]+)\}\)/.exec(src)![1]!;
      expect([...set.matchAll(/'([a-z.]+)':/g)].map((m) => m[1]), signal).toEqual(sdkResource);
    }
    const kept = [...gateway.matchAll(/context: resource\n\s+statements:\n\s+- keep_keys\(attributes, \[([^\]]*)\]\)/g)].map((m) => JSON.parse(`[${m[1]!}]`) as string[]);
    // Metrics: domain, service and environment are labels; a resource attribute would split or mint series.
    expect(kept).toEqual([sdkResource, sdkResource, []]);
    for (const pipeline of ['traces/browser', 'logs/browser', 'metrics/browser']) {
      expect(new RegExp(`${pipeline}:\\n.*\\n\\s+processors: \\[memory_limiter, transform/browser-resource,`).test(gateway), pipeline).toBe(true);
    }
  });

  it('caps page_route at 64 characters of the proposal pattern, after the allowlist', () => {
    const cap = [...gateway.matchAll(/set\(attributes\["page_route"\], "unknown"\) where .*IsMatch\(attributes\["page_route"\], "([^"]+)"\)/g)].map((m) => m[1]!);
    expect(cap).toEqual([proposal.labels.page_route!.pattern!.replace(']*)$', ']{0,63})$')]);
    const route = new RegExp(cap[0]!);
    expect(route.test(`/${'a'.repeat(63)}`)).toBe(true);
    expect(route.test(`/${'a'.repeat(64)}`)).toBe(false);
    expect(gateway).toContain('processors: [memory_limiter, transform/browser-resource, filter/browser-allowlist, transform/browser-labels, transform/browser-truncate, batch]');
  });

  it('tells operators to set Mimir per-tenant series limits', () => {
    expect(readFileSync(join(ROOT, 'examples/collector/README.md'), 'utf8')).toMatch(/max_global_series_per_user/);
  });
});
