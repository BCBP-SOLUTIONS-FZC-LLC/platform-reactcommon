// The gateway's allowlists (examples/collector/gateway.yaml) are the metric registry's vocabulary: the
// domains and the service pattern of contracts/metric-registry.json, and the Tier 1 browser labels of
// monitoring/registry/platform-web.proposal.json. A domain added to the registry, or a label value
// ratified, must reach the gateway too, or its points are dropped there. No Docker: test/collector runs
// the configuration itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { METRIC_REGISTRY } from '../../../packages/frontend-sdk/src/internal/generated/metric-registry.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const gateway = readFileSync(join(ROOT, 'examples/collector/gateway.yaml'), 'utf8');
const proposal = JSON.parse(readFileSync(join(ROOT, 'monitoring/registry/platform-web.proposal.json'), 'utf8')) as {
  labels: Record<string, { pattern?: string; values?: string[] }>;
};
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
    expect(gatewayPattern('name')).toEqual([`^${alternation(['platform_web', ...domains])}_[a-z0-9_]+_(total|seconds|bytes)$`]);
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
  it('keeps exactly the registry and Tier 1 proposal label keys on a metric point', () => {
    const keys = /context: datapoint\n\s+statements:\n\s+- keep_keys\(attributes, \[([^\]]+)\]\)/.exec(gateway)?.[1];
    expect(keys).toBeDefined();
    const want = [...new Set([...Object.keys(labels), ...Object.keys(proposal.labels)])].sort();
    expect(JSON.parse(`[${keys!}]`)).toEqual(want);
    for (const constLabel of METRIC_REGISTRY.constLabels) expect(want).toContain(constLabel);
  });

  it('keeps only the resource attributes the SDK sets, on every signal', () => {
    const sdkResource = ['service.name', 'service.version', 'service.namespace', 'deployment.environment.name'];
    for (const signal of ['tracing/tracing.ts', 'logging/logging.ts', 'metrics/metrics.ts']) {
      const src = readFileSync(join(ROOT, 'packages/frontend-sdk/src', signal), 'utf8');
      const set = /resourceFromAttributes\(\{([^}]+)\}\)/.exec(src)![1]!;
      expect([...set.matchAll(/'([a-z.]+)':/g)].map((m) => m[1]), signal).toEqual(sdkResource);
    }
    const kept = [...gateway.matchAll(/context: resource\n\s+statements:\n\s+- keep_keys\(attributes, \[([^\]]+)\]\)/g)].map((m) => JSON.parse(`[${m[1]!}]`) as string[]);
    expect(kept).toEqual([sdkResource, sdkResource, sdkResource]);
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
