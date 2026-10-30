// The SDK's emitted metric inventory as a Prometheus text exposition (design doc §C5 drift item 4):
// every instrument registered on the page, one sample per label set recorded, with the injected
// domain/service/environment. CI pipes it to gincommon's `metricslint check`, the validator every
// backend service uses. Exposed to remote repos through /testing.
import { metricsState } from './metrics.ts';

function escapeValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeHelp(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

function labelText(labels: Readonly<Record<string, string>>, extra?: [string, string]): string {
  const pairs = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (extra) pairs.push(extra);
  return pairs.length === 0 ? '' : `{${pairs.map(([k, v]) => `${k}="${escapeValue(v)}"`).join(',')}}`;
}

/** One metric family in Prometheus text exposition (0.0.4): HELP, TYPE and one sample per label set. */
export function renderFamily(f: {
  name: string;
  type: 'counter' | 'histogram';
  help: string;
  buckets?: readonly number[] | undefined;
  labelSets: Iterable<Readonly<Record<string, string>>>;
}): string[] {
  const out = [`# HELP ${f.name} ${escapeHelp(f.help)}`, `# TYPE ${f.name} ${f.type}`];
  for (const labels of f.labelSets) {
    if (f.type === 'counter') {
      out.push(`${f.name}${labelText(labels)} 1`);
      continue;
    }
    for (const le of [...(f.buckets ?? []).map(String), '+Inf']) out.push(`${f.name}_bucket${labelText(labels, ['le', le])} 1`);
    out.push(`${f.name}_sum${labelText(labels)} 0`, `${f.name}_count${labelText(labels)} 1`);
  }
  return out;
}

/** Prometheus text exposition (0.0.4) of every instrument registered so far. */
export function renderMetricInventory(): string {
  const instruments = [...metricsState().instruments.values()].sort((a, b) => a.name.localeCompare(b.name));
  const out = instruments.flatMap((rec) =>
    renderFamily({ name: rec.name, type: rec.type, help: rec.help, buckets: rec.buckets, labelSets: rec.seen.values() }),
  );
  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
