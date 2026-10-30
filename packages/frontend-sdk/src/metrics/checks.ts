// The Enterprise Platform Observability Standard's registration rules, mirrored from gincommon's
// obsregistry (CheckCustom for Tier 3, SharedMetric for Tier 2, suffixError, ServicePrefix) over
// the generated registry contract. scripts/metrics-parity.ts checks these against metricslint.
import { METRIC_REGISTRY } from '../internal/generated/metric-registry.ts';

export type MetricType = 'counter' | 'histogram';
export type MetricRule =
  | 'namespace'
  | 'suffix'
  | 'required_labels'
  | 'registry'
  | 'label_vocabulary'
  | 'prohibited_label'
  | 'cardinality';

/** A metric definition or data point breaks the observability standard. `rule` names which one. */
export class InvalidMetricError extends Error {
  override readonly name = 'InvalidMetricError';
  constructor(
    readonly rule: MetricRule,
    message: string,
  ) {
    super(message);
  }
}

export interface RegistryMetric {
  readonly name: string;
  readonly tier: string;
  readonly type: string;
  readonly unit?: string;
  readonly buckets?: string;
  readonly status: string;
  readonly help: string;
  readonly labels: readonly string[];
  readonly domain?: string;
  readonly label_values?: Readonly<Record<string, readonly string[]>>;
}

interface RegistryLabel {
  readonly values?: readonly string[];
  readonly pattern?: string;
  readonly max_values?: number;
}

const REG = METRIC_REGISTRY;
const NAME_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const BY_NAME = new Map<string, RegistryMetric>(REG.metrics.map((m) => [m.name, m as RegistryMetric]));
const LEGACY = new Set<string>(REG.legacyNames as readonly string[]);
const LABELS = REG.labels as Readonly<Record<string, RegistryLabel>>;
const LABEL_RE = new Map<string, RegExp>(
  Object.entries(LABELS)
    .filter(([, l]) => l.pattern !== undefined)
    .map(([k, l]) => [k, new RegExp(l.pattern!)]),
);

export const CONST_LABELS: readonly string[] = REG.constLabels;
export const DOMAINS: readonly string[] = (LABELS.domain?.values ?? []) as readonly string[];

export function labelDefinition(name: string): RegistryLabel | undefined {
  return LABELS[name];
}

/** gincommon ServicePrefix: <domain>_<service>_ with non-alphanumerics as '_', not doubling the domain. */
export function servicePrefix(domain: string, service: string): string {
  let s = service.toLowerCase().replace(/[^a-z0-9]/g, '_');
  s = s.replace(/^_+|_+$/g, '').replace(/_{2,}/g, '_');
  if (s.startsWith(`${domain}_`)) s = s.slice(domain.length + 1);
  return `${domain}_${s}_`;
}

/** gincommon suffixError: counters _total; histograms _seconds (or _bytes with unit bytes). */
export function suffixProblem(type: MetricType, name: string, unit = ''): string | undefined {
  if (type === 'counter') return name.endsWith('_total') ? undefined : 'counters must end in _total';
  const want = unit === 'bytes' ? '_bytes' : '_seconds';
  if (unit !== '' && unit !== 'seconds' && unit !== 'bytes') return `histogram unit ${JSON.stringify(unit)} is not supported (want seconds or bytes)`;
  return name.endsWith(want) ? undefined : `histograms must end in ${want}`;
}

export function isProhibitedLabel(name: string): boolean {
  return (REG.prohibitedLabels as readonly string[]).includes(name) || REG.prohibitedLabelSuffixes.some((s) => name.endsWith(s));
}

function isExempt(name: string): boolean {
  return (REG.exemptPrefixes as readonly string[]).some((p) => name.startsWith(p));
}

/**
 * gincommon CheckCustom: a service-owned (Tier 3) metric. Its name must be snake_case, not a
 * registry or legacy name, not platform_*, not a runtime prefix, have the right suffix and start
 * with the service prefix; its labels must be snake_case, not prohibited and not centrally injected.
 */
export function checkServiceMetric(type: MetricType, name: string, labelNames: readonly string[], domain: string, service: string): void {
  checkServiceMetricShape(type, name, labelNames);
  checkServicePrefix(name, domain, service);
}

/** checkServiceMetric's rules that need no scope identity: everything but the service prefix. */
export function checkServiceMetricShape(type: MetricType, name: string, labelNames: readonly string[]): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new InvalidMetricError('namespace', `metric ${JSON.stringify(name)}: name must be snake_case [a-z0-9_]`);
  if (LEGACY.has(name)) throw new InvalidMetricError('registry', `metric "${name}" is a legacy name; emit its replacement instead`);
  const entry = BY_NAME.get(name);
  if (entry) throw new InvalidMetricError('registry', `metric "${name}" is a ${entry.tier} registry metric; create it with getDomainMeter (domain) or let the SDK record it (platform)`);
  if (name.startsWith('platform_')) throw new InvalidMetricError('namespace', `metric "${name}": platform_* metrics must be ratified in the Platform Observability Registry before use`);
  if (isExempt(name)) throw new InvalidMetricError('namespace', `metric "${name}": prefix is reserved for runtime collectors`);
  const suffix = suffixProblem(type, name);
  if (suffix) throw new InvalidMetricError('suffix', `metric "${name}": ${suffix}`);
  for (const l of labelNames) {
    if (typeof l !== 'string' || !NAME_RE.test(l)) throw new InvalidMetricError('label_vocabulary', `metric "${name}": label ${JSON.stringify(l)} must be snake_case`);
    if (isProhibitedLabel(l)) throw new InvalidMetricError('prohibited_label', `metric "${name}": label "${l}" is prohibited (unbounded cardinality)`);
    if (CONST_LABELS.includes(l)) throw new InvalidMetricError('required_labels', `metric "${name}": label "${l}" is injected centrally and must not be declared`);
  }
  if (new Set(labelNames).size !== labelNames.length) throw new InvalidMetricError('label_vocabulary', `metric "${name}": duplicate label names`);
}

/** checkServiceMetric's last rule: the name starts with the scope's service prefix. */
export function checkServicePrefix(name: string, domain: string, service: string): void {
  const prefix = servicePrefix(domain, service);
  if (!name.startsWith(prefix)) {
    throw new InvalidMetricError('namespace', `metric "${name}": service-specific metrics must be named ${prefix}<metric>; domain-shared ${domain}_* metrics must be ratified in the registry`);
  }
}

/** gincommon SharedMetric for a domain (Tier 2) metric: it must be the scope domain's registry entry, of this type. */
export function checkDomainMetric(type: MetricType, name: string, domain: string): RegistryMetric {
  return checkDomainMetricOwner(checkDomainMetricEntry(type, name), domain);
}

/** checkDomainMetric's rules that need no scope identity: a domain registry entry of this type. */
export function checkDomainMetricEntry(type: MetricType, name: string): RegistryMetric {
  const entry = BY_NAME.get(name);
  if (!entry) throw new InvalidMetricError('registry', `metric "${name}" is not in the Platform Observability Registry`);
  if (entry.tier !== 'domain') throw new InvalidMetricError('registry', `metric "${name}" is a ${entry.tier} metric, not a domain one`);
  if (entry.type !== type) throw new InvalidMetricError('registry', `metric "${name}" is a ${entry.type}, not a ${type}`);
  return entry;
}

/** checkDomainMetric's last rule: the entry belongs to the scope's domain. */
export function checkDomainMetricOwner(entry: RegistryMetric, domain: string): RegistryMetric {
  const name = entry.name;
  if (entry.domain !== domain) throw new InvalidMetricError('namespace', `metric "${name}" belongs to domain "${entry.domain}"; this scope is in domain "${domain}"`);
  return entry;
}

/** gincommon Registry.allows: a value in the metric's narrowed vocabulary, else the label's own. */
export function allowsValue(entry: RegistryMetric | undefined, label: string, value: string): boolean {
  const narrowed = entry?.label_values?.[label];
  if (narrowed) return narrowed.includes(value);
  const def = LABELS[label];
  if (!def) return true; // a service-owned label
  if (def.values) return def.values.includes(value);
  const re = LABEL_RE.get(label);
  return re ? re.test(value) : true;
}

/** Buckets for a registry preset. */
export function bucketPreset(name: string): readonly number[] | undefined {
  return (REG.bucketPresets as Readonly<Record<string, readonly number[]>>)[name];
}
