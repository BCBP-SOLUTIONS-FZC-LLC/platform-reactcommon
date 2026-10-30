// Regenerates the generated documentation and keeps ARCHITECTURE.md's diagrams equal to their
// .mmd sources (the counterpart of platform-gincommon's `make metrics-inventory` drift gate):
//
//   pnpm docs:sync    write docs/observability/metric-registry.md, docs/problem-details/registry.md
//                     and the diagram blocks of ARCHITECTURE.md
//   pnpm docs:check   fail if any of them is stale (CI, Validate / Quality)
//
// Every .mmd under docs/architecture/mermaid/ must be embedded in ARCHITECTURE.md and listed in
// docs/architecture/README.md.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineDiagrams, renderMetricRegistry, renderProblemRegistry, renderSubpathGraph, type SubpathsContract } from './lib/docs.ts';
import { REPO_ROOT, SDK_DIR } from './lib/subpaths.ts';

const CONTRACTS = join(SDK_DIR, 'contracts');
const json = <T>(file: string): T => JSON.parse(readFileSync(join(CONTRACTS, file), 'utf8')) as T;

function main(): void {
  const check = process.argv.includes('--check');
  const files = new Map<string, string>();

  files.set(
    'docs/observability/metric-registry.md',
    renderMetricRegistry(json('metric-registry.json'), 'packages/frontend-sdk/contracts/metric-registry.json'),
  );
  files.set(
    'docs/problem-details/registry.md',
    renderProblemRegistry(json('problem-types.json'), json('gateway-deny-codes.json'), [
      'packages/frontend-sdk/contracts/problem-types.json',
      'packages/frontend-sdk/contracts/gateway-deny-codes.json',
    ]),
  );

  // The subpath dependency graph is generated (the counterpart of gincommon's go-list graph); write
  // it before ARCHITECTURE.md embeds it.
  const graphRel = 'docs/architecture/mermaid/package-dependencies.mmd';
  const graph = renderSubpathGraph(JSON.parse(readFileSync(join(SDK_DIR, 'subpaths.json'), 'utf8')) as SubpathsContract);
  files.set(graphRel, graph);
  const readMmd = (p: string): string | undefined =>
    p === graphRel ? graph : existsSync(join(REPO_ROOT, p)) ? readFileSync(join(REPO_ROOT, p), 'utf8') : undefined;

  const mmdDir = join(REPO_ROOT, 'docs/architecture/mermaid');
  const all = [...new Set([...readdirSync(mmdDir).filter((f) => f.endsWith('.mmd')), 'package-dependencies.mmd'])].sort();
  const arch = readFileSync(join(REPO_ROOT, 'ARCHITECTURE.md'), 'utf8');
  const { text, diagrams } = inlineDiagrams(arch, readMmd);
  files.set('ARCHITECTURE.md', text);

  const problems: string[] = [];
  const index = readFileSync(join(REPO_ROOT, 'docs/architecture/README.md'), 'utf8');
  for (const f of all) {
    if (!diagrams.includes(`docs/architecture/mermaid/${f}`)) problems.push(`docs/architecture/mermaid/${f} is not embedded in ARCHITECTURE.md`);
    if (!index.includes(`(mermaid/${f})`)) problems.push(`docs/architecture/mermaid/${f} is not listed in docs/architecture/README.md`);
  }

  for (const [rel, want] of files) {
    const path = join(REPO_ROOT, rel);
    const have = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (have === want) continue;
    if (check) problems.push(`${rel} is stale`);
    else {
      writeFileSync(path, want);
      console.log(`updated ${rel}`);
    }
  }
  if (problems.length > 0) {
    console.error(`Documentation drift:\n  ${problems.join('\n  ')}\nRun \`pnpm docs:sync\` (and embed/list any new diagram), then commit.`);
    process.exit(1);
  }
}

main();
