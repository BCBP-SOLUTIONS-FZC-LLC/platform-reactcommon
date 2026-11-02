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

/** The regex the gateway's filter matches `subject` against (a metric name, or attributes["<label>"]). */
function gatewayPattern(subject: string): string[] {
  const escaped = subject.replace(/[[\]"]/g, (c) => `\\${c}`);
  return [...gateway.matchAll(new RegExp(`IsMatch\\(${escaped}, "([^"]+)"\\)`, 'g'))].map((m) => m[1]!.replace(/\\\\/g, '\\'));
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
});
