import { describe, expect, it } from 'vitest';
import { inlineDiagrams, renderMetricRegistry, renderProblemRegistry, renderSubpathGraph, renderTier1Proposal, type MetricRegistryContract, type Tier1Proposal } from './docs.ts';

const registry: MetricRegistryContract = {
  constLabels: ['domain', 'service', 'environment'],
  requiredLabels: { platform: ['domain', 'service', 'environment'], domain: ['service', 'environment'] },
  prohibitedLabels: ['user_id'],
  prohibitedLabelSuffixes: ['_id'],
  exemptPrefixes: ['go_'],
  bucketPresets: { request_duration: [0.1, 1] },
  labels: {
    route: { description: 'Route | template', pattern: '^/.*$', max_values: 1000, cardinality: 'bounded' },
    status_class: { description: 'Status class', values: ['2xx', '5xx'], cardinality: 'fixed' },
  },
  metrics: [
    { name: 'platform_http_requests_total', tier: 'platform', type: 'counter', status: 'proposed', owner: 'platform-gincommon', labels: ['route'], help: 'Requests.' },
    { name: 'iam_logins_total', tier: 'domain', domain: 'iam', type: 'counter', status: 'approved', owner: 'iam', labels: [], help: 'Logins.\nTwo lines.' },
    { name: 'http_requests_total', tier: 'legacy', type: 'counter', status: 'removed' },
  ],
  legacyNames: ['http_requests_total'],
};

describe('renderMetricRegistry', () => {
  const md = renderMetricRegistry(registry, 'contracts/metric-registry.json');

  it('marks the page generated and names its source', () => {
    expect(md).toContain('<!-- Generated from contracts/metric-registry.json by `pnpm docs:sync`. Do not edit. -->');
  });

  it('lists live metrics by tier, never legacy ones', () => {
    expect(md).toMatch(/## Tier 1[\s\S]*platform_http_requests_total[\s\S]*## Tier 2[\s\S]*iam_logins_total/);
    expect(md).not.toMatch(/\| `http_requests_total` \|/);
    expect(md).toContain('1 removed pre-standard names');
  });

  it('escapes table cells (pipes, newlines)', () => {
    expect(md).toContain('Route \\| template');
    expect(md).toContain('Logins. Two lines.');
  });

  it('renders labels, rules and presets', () => {
    expect(md).toContain('| `status_class` | `2xx`, `5xx` | — | fixed | Status class |');
    expect(md).toContain('| `request_duration` | 0.1, 1 |');
    expect(md).toContain('Prohibited label suffixes: `_id`.');
  });
});

describe('renderProblemRegistry', () => {
  const md = renderProblemRegistry(
    {
      contentType: 'application/problem+json',
      defaultTypeBase: 'https://errors.company.com',
      types: [{ domain: 'platform', name: 'not-found', id: 'platform/not-found', title: 'Not Found', status: 404, code: 'NOT_FOUND' }],
      rules: { standardMembers: ['type', 'title'], extensionNamePattern: '^[a-zA-Z]+$', maxClientBodyBytes: 1048576, slugPattern: '^[a-z]+$', codePattern: '^[A-Z_]+$' },
    },
    { codes: [{ code: 'DENY_MFA_STALE', status: 403 }] },
    ['a.json', 'b.json'],
  );

  it('lists types with their PlatformProblemTypes key, deny codes and wire rules', () => {
    expect(md).toContain('| `platform/not-found` | 404 | `NOT_FOUND` | Not Found | `NotFound` |');
    expect(md).toContain('| `DENY_MFA_STALE` | 403 |');
    expect(md).toContain('larger than 1048576 bytes');
    expect(md).toContain('Generated from a.json, b.json');
  });
});

describe('inlineDiagrams', () => {
  const files: Record<string, string> = { 'docs/architecture/mermaid/a.mmd': 'graph TD\n  A --> B\n' };
  const read = (p: string) => files[p];

  it('replaces the block after each Source line with the file, keeping everything else', () => {
    const md = 'intro\n\n> Source: [`docs/architecture/mermaid/a.mmd`](docs/architecture/mermaid/a.mmd)\n\n```mermaid\nstale\n```\n\noutro';
    const { text, diagrams } = inlineDiagrams(md, read);
    expect(text).toBe('intro\n\n> Source: [`docs/architecture/mermaid/a.mmd`](docs/architecture/mermaid/a.mmd)\n\n```mermaid\ngraph TD\n  A --> B\n```\n\noutro');
    expect(diagrams).toEqual(['docs/architecture/mermaid/a.mmd']);
    expect(inlineDiagrams(text, read).text).toBe(text); // idempotent
  });

  it('fails on a missing file, a missing block and an unterminated block', () => {
    expect(() => inlineDiagrams('> Source: [`docs/architecture/mermaid/x.mmd`](x)\n```mermaid\n```', read)).toThrow('does not exist');
    expect(() => inlineDiagrams('> Source: [`docs/architecture/mermaid/a.mmd`](a)\n\ntext', read)).toThrow('no ```mermaid block');
    expect(() => inlineDiagrams('> Source: [`docs/architecture/mermaid/a.mmd`](a)\n```mermaid\nA', read)).toThrow('unterminated');
  });
});

describe('renderSubpathGraph', () => {
  it('draws layers, allowed imports and restricted packages', () => {
    const mmd = renderSubpathGraph({
      subpaths: [
        { name: 'core', layer: 0, imports: [] },
        { name: 'http', layer: 3, imports: ['core'] },
        { name: 'react', layer: 5, imports: ['core', 'http'] },
        { name: 'testing', layer: 5, imports: ['*'] },
      ],
      packageImports: { _comment: 'x', react: ['react', 'testing'], '@opentelemetry/': ['http'] },
    });
    expect(mmd.startsWith('%% Generated from packages/frontend-sdk/subpaths.json')).toBe(true);
    expect(mmd).toContain('subgraph L3["Layer 3"]');
    expect(mmd).toContain('sp_http --> sp_core');
    expect(mmd).toContain('sp_react --> sp_http');
    expect(mmd).toContain('sp_testing -.->|"any subpath (dev only)"| sp_react');
    expect(mmd).toContain('pkg__opentelemetry_(["@opentelemetry/*"])');
    expect(mmd).toContain('sp_react -.-> pkg_react');
    expect(mmd).not.toContain('_comment');
  });
});

describe('renderTier1Proposal', () => {
  const proposal: Tier1Proposal = {
    submitted_by: 'platform-reactcommon',
    bucket_presets: { web_vitals: [0.1, 2.5] },
    labels: { mfe: { description: 'Micro-frontend', pattern: '^[a-z]|x$', max_values: 100, cardinality: 'manifest' } },
    metrics: [
      {
        name: 'platform_web_http_client_duration_seconds',
        tier: 'platform',
        type: 'histogram',
        unit: 'seconds',
        buckets: 'request_duration',
        status: 'proposed',
        owner: 'platform-reactcommon',
        help: 'Browser API calls.',
        labels: ['route', 'status_class', 'mfe'],
        label_values: { status_class: ['5xx'] },
        aggregation: 'p95 per route.',
        cardinality: 'route x mfe.',
        governance_notes: 'New name.',
      },
    ],
    amendments: [
      { kind: 'label_values', metric: 'platform_telemetry_label_overflow_total', label: 'label', add: ['page_route'], governance_notes: 'SDK as an emitter.' },
      { kind: 'label_description', label: 'route', description: 'Route template', governance_notes: 'Widened.' },
    ],
  };
  const md = renderTier1Proposal(proposal, registry, ['proposal.json']);

  it('marks the page generated and lists every metric with its required labels', () => {
    expect(md).toContain('<!-- Generated from proposal.json by `pnpm docs:sync`. Do not edit. -->');
    expect(md).toContain('| `platform_web_http_client_duration_seconds` | histogram (seconds, `request_duration` buckets) | `route`, `status_class`, `mfe` | proposed |');
    expect(md).toContain('- **Required labels:** `domain`, `service`, `environment`');
  });

  it("gives each label's allowed values: the per-metric enum, else the vocabulary or pattern, new or existing", () => {
    expect(md).toContain('  - `route` (existing): pattern `^/.*$`, at most 1000 values');
    expect(md).toContain('  - `status_class` (existing): `5xx`');
    expect(md).toContain('  - `mfe` (new): pattern `^[a-z]|x$`, at most 100 values');
  });

  it('escapes table pipes in new labels, and lists presets and amendments', () => {
    expect(md).toContain('| `mfe` | Micro-frontend | pattern `^[a-z]\\|x$`, at most 100 values | manifest |');
    expect(md).toContain('- `web_vitals`: 0.1, 2.5 (seconds)');
    expect(md).toContain('- `platform_telemetry_label_overflow_total`: label `label` gains `page_route`. SDK as an emitter.');
    expect(md).toContain('- Label `route`: description becomes "Route template" Widened.');
  });
});
