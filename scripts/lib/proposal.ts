// The Tier 1 registry proposal (monitoring/registry/platform-web.proposal.json) against platform-gincommon's
// registry.json: the candidate registry governance would ratify, and a sample scrape of every proposed
// metric for metricslint to judge. Pure; scripts/metrics-proposal.ts does the I/O.

/** gincommon's registry.json, as far as the merge needs it (unknown fields are kept as they are). */
export interface GincommonRegistry {
  bucket_presets: Record<string, number[]>;
  labels: Record<string, { description?: string; values?: string[]; pattern?: string; max_values?: number; cardinality?: string }>;
  metrics: { name: string; labels: string[]; label_values?: Record<string, string[]>; [k: string]: unknown }[];
  [k: string]: unknown;
}

export interface Proposal {
  bucket_presets: Record<string, number[]>;
  labels: GincommonRegistry['labels'];
  metrics: { name: string; type: string; buckets?: string; labels: string[]; label_values?: Record<string, string[]>; owner?: string; [k: string]: unknown }[];
  amendments: (
    | { kind: 'label_values'; metric: string; label: string; add: string[]; governance_notes: string }
    | { kind: 'label_description'; label: string; description: string; governance_notes: string }
  )[];
}

/**
 * The registry with the proposal applied: new presets, labels and metrics added, amendments applied.
 * Throws when an entry already exists (ratified meanwhile, or a name clash) or an amendment's target
 * does not, so the proposal never silently overwrites the registry.
 */
export function mergeProposal(base: GincommonRegistry, p: Proposal): GincommonRegistry {
  const reg = structuredClone(base);
  const problems: string[] = [];
  for (const [name, buckets] of Object.entries(p.bucket_presets)) {
    if (reg.bucket_presets[name]) problems.push(`bucket preset ${name} is already in the registry`);
    else reg.bucket_presets[name] = buckets;
  }
  for (const [name, label] of Object.entries(p.labels)) {
    if (reg.labels[name]) problems.push(`label ${name} is already in the registry`);
    else reg.labels[name] = label;
  }
  const names = new Set(reg.metrics.map((m) => m.name));
  for (const m of p.metrics) {
    if (names.has(m.name)) problems.push(`metric ${m.name} is already in the registry`);
    else reg.metrics.push(structuredClone(m));
  }
  for (const a of p.amendments) {
    if (a.kind === 'label_description') {
      const l = reg.labels[a.label];
      if (!l) problems.push(`amendment: label ${a.label} is not in the registry`);
      else l.description = a.description;
      continue;
    }
    const m = reg.metrics.find((x) => x.name === a.metric);
    const l = reg.labels[a.label];
    if (!m || !l) {
      problems.push(`amendment: ${!m ? `metric ${a.metric}` : `label ${a.label}`} is not in the registry`);
      continue;
    }
    if (l.values) l.values = [...new Set([...l.values, ...a.add])];
    m.label_values = { ...m.label_values, [a.label]: [...new Set([...(m.label_values?.[a.label] ?? l.values ?? []), ...a.add])] };
  }
  if (problems.length > 0) throw new Error(`the proposal does not apply to the registry:\n  ${problems.join('\n  ')}`);
  return reg;
}

/** Values to put in a sample series for `label` on `m`: its enum, else representative pattern values. */
const SAMPLE_VALUES: Record<string, string[]> = {
  page_route: ['/t/:slug/tenders/:id/edit', 'unknown'],
  mfe: ['shell', 'tenders'],
  route: ['/tenders/:id', 'unknown'],
};

export function sampleValues(reg: GincommonRegistry, metric: { label_values?: Record<string, string[]> }, label: string): string[] {
  const values = metric.label_values?.[label] ?? reg.labels[label]?.values ?? SAMPLE_VALUES[label];
  if (!values) throw new Error(`no sample values for label ${label}: add it to SAMPLE_VALUES`);
  return values;
}

/** Every combination of the sample values of `labels` (each label's values tried at least once). */
export function sampleLabelSets(reg: GincommonRegistry, metric: { label_values?: Record<string, string[]> }, labels: readonly string[]): Record<string, string>[] {
  // One series per value of each label, others at their first value: covers every value without the
  // full product (which is what the dashboards see anyway, and what metricslint checks per value).
  const first = Object.fromEntries(labels.map((l) => [l, sampleValues(reg, metric, l)[0]!]));
  const sets = [first];
  for (const l of labels) for (const v of sampleValues(reg, metric, l).slice(1)) sets.push({ ...first, [l]: v });
  return sets;
}
