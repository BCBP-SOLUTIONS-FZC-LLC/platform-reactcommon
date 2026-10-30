// Pure renderers for the generated documentation (scripts/sync-docs.ts does the I/O; everything here
// is unit-tested):
// - docs/observability/metric-registry.md   from contracts/metric-registry.json
// - docs/problem-details/registry.md          from contracts/problem-types.json + gateway-deny-codes.json
// - ARCHITECTURE.md                           each `> Source:` diagram block = its .mmd file
import { pascalCase } from './contracts.ts';

/** The marker every generated page carries, naming its sources. */
export function generatedNote(sources: readonly string[], command = 'pnpm docs:sync'): string {
  return `<!-- Generated from ${sources.join(', ')} by \`${command}\`. Do not edit. -->`;
}

const cell = (v: unknown): string => String(v ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
const code = (v: string): string => `\`${v}\``;
const codes = (vs: readonly string[] | undefined): string => (vs && vs.length > 0 ? vs.map(code).join(', ') : '—');

// ---------------------------------------------------------------------------------------------
// Metric registry

interface RegistryMetric {
  name: string;
  tier: string;
  type: string;
  status: string;
  owner?: string;
  domain?: string;
  help?: string;
  labels?: string[];
  unit?: string;
  buckets?: string;
  aggregation?: string;
}
interface RegistryLabel {
  description?: string;
  values?: string[];
  pattern?: string;
  max_values?: number;
  cardinality?: string;
}
export interface MetricRegistryContract {
  constLabels: string[];
  requiredLabels: Record<string, string[]>;
  prohibitedLabels: string[];
  prohibitedLabelSuffixes: string[];
  exemptPrefixes: string[];
  bucketPresets: Record<string, number[]>;
  labels: Record<string, RegistryLabel>;
  metrics: RegistryMetric[];
  legacyNames?: string[];
}

/** The registry the SDK validates against, as Markdown (same sections as gincommon's metric-registry.md). */
export function renderMetricRegistry(reg: MetricRegistryContract, source: string): string {
  const live = reg.metrics.filter((m) => m.tier !== 'legacy');
  const byTier = (tier: string) => live.filter((m) => m.tier === tier).sort((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [
    '# Platform Observability Registry (as the SDK validates it)',
    '',
    generatedNote([source]),
    '',
    'The SDK checks every Tier 2 and Tier 3 metric it registers against this registry (`/metrics`), the same document platform-gincommon\'s `metricslint` enforces. It is a generated copy of gincommon\'s `internal/obsregistry/registry.json` at the commit pinned in `contracts/sources.json`; change it there, by registry PR, then run `pnpm contracts:sync`.',
    '',
    `Every metric carries the centrally injected const labels ${codes(reg.constLabels)}. Required labels: ${Object.entries(reg.requiredLabels)
      .map(([tier, ls]) => `${tier} tier ${codes(ls)}`)
      .join('; ')}.`,
    '',
    'The SDK\'s own browser metrics (`platform_web_*`) are **not** in this registry yet: they are proposed for ratification (design doc §D5, §D6 K) and listed in [README.md](README.md#tier-1-browser-metrics-proposed).',
    '',
  ];
  const table = (title: string, ms: RegistryMetric[], withDomain: boolean) => {
    out.push(`## ${title}`, '');
    if (ms.length === 0) {
      out.push('None.', '');
      return;
    }
    out.push(
      withDomain ? '| Metric | Domain | Owner | Type | Status | Labels | Meaning |' : '| Metric | Owner | Type | Status | Labels | Meaning |',
      withDomain ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|',
    );
    for (const m of ms) {
      const cols = [code(m.name), ...(withDomain ? [code(m.domain ?? '')] : []), cell(m.owner), m.type, m.status, codes(m.labels), cell(m.help)];
      out.push(`| ${cols.join(' | ')} |`);
    }
    out.push('');
  };
  table('Tier 1: platform-shared metrics', byTier('platform'), false);
  table('Tier 2: domain-shared metrics', byTier('domain'), true);

  out.push('## Labels', '', '| Label | Values or pattern | Max values | Cardinality | Meaning |', '|---|---|---|---|---|');
  for (const [name, l] of Object.entries(reg.labels).sort(([a], [b]) => a.localeCompare(b))) {
    const vp = l.values ? codes(l.values) : l.pattern ? code(l.pattern) : '—';
    out.push(`| ${code(name)} | ${vp} | ${l.max_values ?? '—'} | ${cell(l.cardinality)} | ${cell(l.description)} |`);
  }
  out.push('', '## Rules', '');
  out.push(`- Prohibited labels: ${codes(reg.prohibitedLabels)}.`);
  out.push(`- Prohibited label suffixes: ${codes(reg.prohibitedLabelSuffixes)}.`);
  out.push(`- Exempt prefixes (runtime collectors, not validated): ${codes(reg.exemptPrefixes)}.`);
  out.push('', '## Bucket presets', '', '| Preset | Buckets |', '|---|---|');
  for (const [name, bs] of Object.entries(reg.bucketPresets).sort(([a], [b]) => a.localeCompare(b))) out.push(`| ${code(name)} | ${bs.join(', ')} |`);
  out.push('');
  if (reg.legacyNames && reg.legacyNames.length > 0) {
    out.push('## Legacy names', '', `${reg.legacyNames.length} removed pre-standard names may not be reused by a new metric: ${codes(reg.legacyNames)}.`, '');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Problem type registry

export interface ProblemContract {
  contentType: string;
  defaultTypeBase: string;
  types: { domain: string; name: string; id: string; title: string; status: number; code: string }[];
  rules: { standardMembers: string[]; extensionNamePattern: string; maxClientBodyBytes: number; slugPattern: string; codePattern: string };
}
export interface DenyCodesContract {
  codes: { code: string; status: number }[];
}


export function renderProblemRegistry(p: ProblemContract, deny: DenyCodesContract, sources: readonly string[]): string {
  const out: string[] = [
    '# Error type registry (as the SDK reads it)',
    '',
    generatedNote(sources),
    '',
    `Every platform HTTP error is \`${p.contentType}\` with a \`type\` URI \`${p.defaultTypeBase}/{domain}/{error}\`. The SDK never matches the full URI: it derives \`typeId\` (\`{domain}/{error}\`) and matches on that, so a different type base changes nothing.`,
    '',
    '## Platform types (`platform/*`)',
    '',
    'From platform-gincommon `pkg/problem` (`go-probe contracts-export`). In the SDK: `PlatformProblemTypes.<Key>` (`/problem`), `e.is(PlatformProblemTypes.<Key>)` on a `ProblemError`, and `problemMessage(e)` (`/i18n`: in the `platform` namespace, `problem.<typeId>.<errorCode>`, then `problem.<typeId>`, in the current then the default locale, else the title).',
    '',
    '| Type | Status | Default `errorCode` | Title | `PlatformProblemTypes` key |',
    '|---|---|---|---|---|',
  ];
  for (const t of p.types) out.push(`| ${code(t.id)} | ${t.status} | ${code(t.code)} | ${cell(t.title)} | ${code(pascalCase(t.name))} |`);
  out.push(
    '',
    '## Gateway deny codes',
    '',
    'Sent by IAM AuthZ Enrichment as `errorCode` on its `platform/unauthorized`, `platform/forbidden` or `platform/service-unavailable` problems. `gatewayDenyCode(e)` returns one of these, else `undefined`. See [README.md](README.md#gateway-denials) for how the UI reacts to each.',
    '',
    '| `errorCode` | Status |',
    '|---|---|',
  );
  for (const c of deny.codes) out.push(`| ${code(c.code)} | ${c.status} |`);
  out.push(
    '',
    '## Wire rules',
    '',
    `- Standard members: ${codes(p.rules.standardMembers)}. Every other top-level member is an extension (\`ProblemDetails.extensions\`).`,
    `- Extension member names match ${code(p.rules.extensionNamePattern)}.`,
    `- A problem body larger than ${p.rules.maxClientBodyBytes} bytes is not parsed (a synthetic problem is returned instead).`,
    `- Domain and error slugs match ${code(p.rules.slugPattern)}; error codes match ${code(p.rules.codePattern)}.`,
    '',
    '## Domain types (`{domain}/*`)',
    '',
    'Defined by each domain\'s services; the SDK accepts any type and exposes `defineProblemType(domain, name, title, status, code)` so remotes can match their own (for example `tender/deadline-passed`). Domain types are not listed here.',
    '',
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// ARCHITECTURE.md: every diagram block equals its .mmd source

const SOURCE = /^> Source: \[`(docs\/architecture\/mermaid\/[A-Za-z0-9_-]+\.mmd)`\]\([^)]*\)\s*$/;

/**
 * Replaces the ```mermaid block after each `> Source: [`docs/architecture/mermaid/x.mmd`](…)` line with
 * that file's contents. Fails on a Source line with no following mermaid block, or an unknown file.
 */
export function inlineDiagrams(markdown: string, readMmd: (path: string) => string | undefined): { text: string; diagrams: string[] } {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const diagrams: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SOURCE.exec(lines[i]!);
    out.push(lines[i]!);
    if (!m) continue;
    const path = m[1]!;
    const body = readMmd(path);
    if (body === undefined) throw new Error(`ARCHITECTURE.md line ${i + 1}: ${path} does not exist`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() === '') out.push(lines[j++]!);
    if (lines[j]?.trim() !== '```mermaid') throw new Error(`ARCHITECTURE.md line ${i + 1}: no \`\`\`mermaid block after the Source line for ${path}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trim() !== '```') k++;
    if (k >= lines.length) throw new Error(`ARCHITECTURE.md line ${j + 1}: unterminated mermaid block`);
    out.push('```mermaid', ...body.replace(/\n+$/, '').split('\n'), '```');
    diagrams.push(path);
    i = k;
  }
  return { text: out.join('\n'), diagrams };
}

// ---------------------------------------------------------------------------------------------
// docs/architecture/mermaid/package-dependencies.mmd from subpaths.json

export interface SubpathsContract {
  subpaths: { name: string; layer: number; imports: string[] }[];
  packageImports: Record<string, unknown>;
}

/** The allowed-imports graph of the SDK's subpaths (subpaths.json), one subgraph per layer. */
export function renderSubpathGraph(cfg: SubpathsContract): string {
  const names = cfg.subpaths.map((s) => s.name);
  const id = (n: string) => `sp_${n}`;
  const lines = ['%% Generated from packages/frontend-sdk/subpaths.json by `pnpm docs:sync`. Do not edit.', 'graph BT'];
  const layers = [...new Set(cfg.subpaths.map((s) => s.layer))].sort((a, b) => a - b);
  for (const layer of layers) {
    lines.push(`    subgraph L${layer}["Layer ${layer}"]`);
    for (const s of cfg.subpaths.filter((x) => x.layer === layer)) lines.push(`        ${id(s.name)}["/${s.name}"]`);
    lines.push('    end');
  }
  lines.push('    internal["src/internal<br/>(runtime registry · events · generated contracts)"]');
  for (const s of cfg.subpaths) {
    if (s.imports.includes('*')) {
      lines.push(`    ${id(s.name)} -.->|"any subpath (dev only)"| ${id('react')}`);
      continue;
    }
    for (const dep of s.imports) if (names.includes(dep)) lines.push(`    ${id(s.name)} --> ${id(dep)}`);
  }
  const packages = Object.entries(cfg.packageImports).filter(([k]) => !k.startsWith('_'));
  for (const [pkg, owners] of packages) {
    const pid = `pkg_${pkg.replace(/[^a-z0-9]/gi, '_')}`;
    lines.push(`    ${pid}(["${pkg}${pkg.endsWith('/') ? '*' : ''}"])`);
    for (const o of owners as string[]) if (names.includes(o)) lines.push(`    ${id(o)} -.-> ${pid}`);
  }
  lines.push('    classDef pkg fill:#eef,stroke:#88a');
  lines.push(`    class ${packages.map(([pkg]) => `pkg_${pkg.replace(/[^a-z0-9]/gi, '_')}`).join(',')} pkg`);
  return `${lines.join('\n')}\n`;
}
