import { describe, expect, it } from 'vitest';
import { mergeProposal, sampleLabelSets, type GincommonRegistry, type Proposal } from './proposal.ts';

const base = (): GincommonRegistry => ({
  schema_version: 1,
  bucket_presets: { request_duration: [0.1, 1] },
  labels: {
    reason: { description: 'Reason', pattern: '^[a-z_]+$', max_values: 50 },
    label: { description: 'Replaced label', values: ['event_type'] },
    route: { description: 'Gin route template', pattern: '^/.*$' },
  },
  metrics: [{ name: 'platform_telemetry_label_overflow_total', labels: ['label'], label_values: { label: ['event_type'] }, owner: 'platform-events' }],
});

const proposal = (): Proposal => ({
  bucket_presets: { web_vitals: [0.1, 2.5] },
  labels: { mfe: { description: 'Micro-frontend', pattern: '^[a-z]+$', max_values: 100 } },
  metrics: [{ name: 'platform_web_errors_total', type: 'counter', labels: ['reason', 'mfe'], label_values: { reason: ['timeout', 'network'] }, owner: 'platform-reactcommon' }],
  amendments: [
    { kind: 'label_values', metric: 'platform_telemetry_label_overflow_total', label: 'label', add: ['page_route', 'mfe'], governance_notes: '' },
    { kind: 'label_description', label: 'route', description: 'Route template (server or browser)', governance_notes: '' },
  ],
});

describe('mergeProposal', () => {
  it('adds presets, labels and metrics, applies amendments, keeps unknown fields and never mutates the base', () => {
    const b = base();
    const merged = mergeProposal(b, proposal());
    expect(merged.schema_version).toBe(1);
    expect(merged.bucket_presets.web_vitals).toEqual([0.1, 2.5]);
    expect(merged.labels.mfe?.max_values).toBe(100);
    expect(merged.metrics.map((m) => m.name)).toEqual(['platform_telemetry_label_overflow_total', 'platform_web_errors_total']);
    expect(merged.labels.label?.values).toEqual(['event_type', 'page_route', 'mfe']);
    expect(merged.metrics[0]!.label_values).toEqual({ label: ['event_type', 'page_route', 'mfe'] });
    expect(merged.labels.route?.description).toBe('Route template (server or browser)');
    expect(b).toEqual(base());
  });

  it('refuses entries that already exist and amendments whose target does not', () => {
    const b = mergeProposal(base(), proposal()); // as if ratified already
    expect(() => mergeProposal(b, proposal())).toThrow(/bucket preset web_vitals is already[\s\S]*label mfe is already[\s\S]*metric platform_web_errors_total is already/);
    const p = proposal();
    p.amendments = [
      { kind: 'label_values', metric: 'platform_nope_total', label: 'label', add: ['x'], governance_notes: '' },
      { kind: 'label_description', label: 'nope', description: 'x', governance_notes: '' },
    ];
    expect(() => mergeProposal(base(), p)).toThrow(/metric platform_nope_total is not in the registry[\s\S]*label nope is not in the registry/);
  });
});

describe('sampleLabelSets', () => {
  it('tries every value of every label once, others at their first value', () => {
    const reg = mergeProposal(base(), proposal());
    const m = reg.metrics.find((x) => x.name === 'platform_web_errors_total')!;
    expect(sampleLabelSets(reg, m, ['reason', 'mfe'])).toEqual([
      { reason: 'timeout', mfe: 'shell' },
      { reason: 'network', mfe: 'shell' },
      { reason: 'timeout', mfe: 'tenders' },
    ]);
  });

  it('fails for a pattern label with no sample values', () => {
    expect(() => sampleLabelSets(base(), { label_values: {} }, ['reason'])).toThrow('no sample values for label reason');
  });
});
