// Validates the Tier 1 registry proposal (monitoring/registry/platform-web.proposal.json) with
// platform-gincommon's own metricslint, the way governance will judge it:
//
//   pnpm metrics:proposal                 validate (CI: Validate / Contracts)
//   pnpm metrics:proposal --emit <file>   also write the candidate registry.json for the registry PR
//
// 1. The candidate = gincommon's registry.json at the pinned commit + the proposal must be a valid
//    registry document (`metricslint registry`).
// 2. A sample scrape of every proposed metric (every allowed label value, the injected domain, service
//    and environment) must pass `metricslint check -strict` under the candidate, and fail under the
//    pinned registry (the names are new: nothing here is already ratified).
// 3. Every metric the dashboards and rules under monitoring/ reference must be registered in the
//    candidate (`metricslint refs`), and every one the pinned registry does not know must be proposed here.
// Needs `go` and the gincommon checkout under PLATFORM_ROOT (as metrics:parity does).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mergeProposal, sampleLabelSets, type GincommonRegistry, type Proposal } from './lib/proposal.ts';
import { REPO_ROOT, SDK_DIR } from './lib/subpaths.ts';

(globalThis as { __SDK_VERSION__?: string }).__SDK_VERSION__ = (
  JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { version: string }
).version;
const { renderFamily } = await import('../packages/frontend-sdk/src/metrics/inventory.ts');

const PROPOSAL = join(REPO_ROOT, 'monitoring/registry/platform-web.proposal.json');
const MONITORING = join(REPO_ROOT, 'monitoring');
const IDENTITY = { domain: 'portal', service: 'web-app', environment: 'prod' };

function gincommon(): { dir: string; sha: string } {
  const sources = JSON.parse(readFileSync(join(SDK_DIR, 'contracts/sources.json'), 'utf8')) as { platform: Record<string, { path: string; sha: string }> };
  const pin = sources.platform['platform-gincommon']!;
  return { dir: join(resolve(process.env.PLATFORM_ROOT ?? join(REPO_ROOT, '../..')), pin.path), sha: pin.sha };
}

function run(bin: string, args: string[], input?: string): { code: number; output: string } {
  const r = spawnSync(bin, args, { input, encoding: 'utf8' });
  if (r.status === null || r.status > 1) throw new Error(`metricslint ${args[0]} failed (${r.status}): ${r.stderr}`);
  return { code: r.status, output: `${r.stdout}${r.stderr}`.trim() };
}

const indent = (s: string) => s.replace(/\n/g, '\n    ');

function main(): void {
  const emitAt = process.argv.indexOf('--emit');
  const g = gincommon();
  const base = JSON.parse(execFileSync('git', ['-C', g.dir, 'show', `${g.sha}:internal/obsregistry/registry.json`], { encoding: 'utf8' })) as GincommonRegistry;
  const proposal = JSON.parse(readFileSync(PROPOSAL, 'utf8')) as Proposal;
  const candidate = mergeProposal(base, proposal);

  const dir = mkdtempSync(join(tmpdir(), 'sdk-proposal-'));
  const failures: string[] = [];
  try {
    const bin = join(dir, 'metricslint');
    execFileSync('go', ['build', '-o', bin, './cmd/metricslint'], { cwd: g.dir, env: { ...process.env, GOTOOLCHAIN: 'local' }, stdio: ['ignore', 'ignore', 'inherit'] });
    const basePath = join(dir, 'registry.base.json');
    const candidatePath = join(dir, 'registry.candidate.json');
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    // 1. The candidate document.
    const doc = run(bin, ['registry', '-registry', candidatePath]);
    if (doc.code !== 0) failures.push(`the candidate registry is invalid:\n    ${indent(doc.output)}`);
    else console.log(`metrics proposal: candidate registry valid (${doc.output.replace(/^registry OK: /, '')})`);

    // 2. A sample scrape of every proposed metric, plus the amended overflow counter.
    const families = proposal.metrics.flatMap((m) =>
      renderFamily({
        name: m.name,
        type: m.type as 'counter' | 'histogram',
        help: 'Proposal sample.',
        buckets: m.buckets ? candidate.bucket_presets[m.buckets] : undefined,
        labelSets: sampleLabelSets(candidate, m, m.labels).map((l) => ({ ...l, ...IDENTITY })),
      }),
    );
    const overflow = candidate.metrics.find((m) => m.name === 'platform_telemetry_label_overflow_total')!;
    families.push(
      ...renderFamily({ name: overflow.name, type: 'counter', help: 'Proposal sample.', labelSets: sampleLabelSets(candidate, overflow, overflow.labels).map((l) => ({ ...l, ...IDENTITY })) }),
    );
    const scrape = `${families.join('\n')}\n`;
    const owners = [...new Set([...proposal.metrics.map((m) => m.owner), overflow.owner as string])].join(',');
    const checked = run(bin, ['check', '-registry', candidatePath, '-strict', '-allow-proposed-owner', owners], scrape);
    if (checked.code !== 0) failures.push(`the sample scrape fails metricslint check -strict:\n    ${indent(checked.output)}`);
    else console.log(`metrics proposal: sample scrape of ${proposal.metrics.length} metrics passes metricslint check -strict`);
    const unknown = run(bin, ['check', '-registry', basePath], scrape);
    const notNew = proposal.metrics.filter((m) => !unknown.output.includes(m.name)).map((m) => m.name);
    if (unknown.code === 0 || notNew.length > 0) failures.push(`expected the pinned registry to reject every proposed name; it accepted ${notNew.join(', ') || 'the scrape'}`);

    // 3. Dashboards and rules reference only registered (or proposed) metrics.
    const refs = run(bin, ['refs', '-registry', candidatePath, MONITORING]);
    if (refs.code !== 0) failures.push(`monitoring/ references metrics outside the candidate registry:\n    ${indent(refs.output)}`);
    const refsBase = run(bin, ['refs', '-registry', basePath, MONITORING]);
    const proposed = new Set(proposal.metrics.map((m) => m.name));
    const strays = [...refsBase.output.matchAll(/platform_[a-z0-9_]+/g)].map((m) => m[0].replace(/_(bucket|sum|count)$/, '')).filter((n) => !proposed.has(n));
    if (strays.length > 0) failures.push(`monitoring/ uses unregistered names that are not in the proposal: ${[...new Set(strays)].join(', ')}`);
    if (refs.code === 0 && strays.length === 0) console.log('metrics proposal: monitoring/ references only registered or proposed metrics (metricslint refs)');

    if (emitAt > 0) {
      const out = resolve(process.argv[emitAt + 1] ?? 'registry.json');
      writeFileSync(out, `${JSON.stringify(candidate, null, 2)}\n`);
      console.log(`metrics proposal: candidate registry written to ${out}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`metrics proposal failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
}

main();
