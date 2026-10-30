// Checks the SDK's metric rules against gincommon's metricslint (design doc §C5 drift item 4).
//
//   pnpm metrics:parity
//
// 1. Every case in packages/frontend-sdk/test/metrics/parity-cases.ts is rendered as a one-family
//    Prometheus exposition (with the injected domain/service/environment) and judged by the real
//    metricslint; its verdict (any error or none) must match the SDK's, except where a case
//    records why the construction-time and scrape-time rules legitimately differ.
// 2. A sample of real SDK instruments is rendered with renderMetricInventory and must pass
//    `metricslint check -strict -allow-proposed-owner platform-reactcommon`.
// Needs `go` and the gincommon checkout under PLATFORM_ROOT (as contracts:sync does).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REPO_ROOT, SDK_DIR } from './lib/subpaths.ts';

// The SDK's build-time constant (tsup/Vitest `define`), set before any SDK module loads.
(globalThis as { __SDK_VERSION__?: string }).__SDK_VERSION__ = (
  JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { version: string }
).version;
const { initializeCore } = await import('../packages/frontend-sdk/src/core/index.ts');
const { bucketPreset } = await import('../packages/frontend-sdk/src/metrics/checks.ts');
const { renderFamily, renderMetricInventory } = await import('../packages/frontend-sdk/src/metrics/inventory.ts');
const { getServiceMeter } = await import('../packages/frontend-sdk/src/metrics/index.ts');
const { PARITY_CASES, sdkVerdict } = await import('../packages/frontend-sdk/test/metrics/parity-cases.ts');

function buildMetricslint(dir: string): string {
  const gincommon = join(resolve(process.env.PLATFORM_ROOT ?? join(REPO_ROOT, '../..')), 'go/platform-gincommon');
  const bin = join(dir, 'metricslint');
  execFileSync('go', ['build', '-o', bin, './cmd/metricslint'], {
    cwd: gincommon,
    env: { ...process.env, GOTOOLCHAIN: 'local' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return bin;
}

function lint(bin: string, text: string, args: string[] = []): { ok: boolean; output: string } {
  const r = spawnSync(bin, ['check', ...args], { input: text, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) throw new Error(`metricslint failed (${r.status}): ${r.stderr}`);
  return { ok: r.status === 0, output: `${r.stdout}${r.stderr}`.trim() };
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-metricslint-'));
  const failures: string[] = [];
  try {
    const bin = buildMetricslint(dir);

    let compared = 0;
    for (const c of PARITY_CASES) {
      const sdk = sdkVerdict(c);
      if (c.lintDiffers) continue;
      const text = `${renderFamily({
        name: c.metric,
        type: c.type,
        help: 'Parity case.',
        buckets: bucketPreset('request_duration'),
        labelSets: [{ ...c.labels, domain: c.domain, service: c.service, environment: 'dev' }],
      }).join('\n')}\n`;
      const result = lint(bin, text);
      compared++;
      if (result.ok !== (sdk === 'ok')) {
        failures.push(`${c.name}: SDK says ${sdk}, metricslint says ${result.ok ? 'ok' : `error\n    ${result.output.replace(/\n/g, '\n    ')}`}`);
      }
    }
    console.log(`metrics parity: ${compared} cases compared with metricslint, ${PARITY_CASES.length - compared} recorded differences`);

    // Real instruments, through the SDK's own registration and inventory.
    initializeCore({ serviceName: 'web-app', domain: 'tender_management', environment: 'dev', buildVersion: '1.0.0' });
    const meter = getServiceMeter();
    meter.counter('tender_management_web_app_draft_saves_total', 'Drafts saved from the tender editor.', ['kind', 'outcome']).add(1, { kind: 'draft', outcome: 'success' });
    meter.histogram('tender_management_web_app_render_seconds', 'Time to first render of a tender page.', ['route']).record(0.42, { route: '/tenders/:id' });
    const inventory = lint(bin, renderMetricInventory(), ['-strict', '-allow-proposed-owner', 'platform-reactcommon']);
    if (!inventory.ok) failures.push(`SDK inventory fails metricslint -strict:\n    ${inventory.output.replace(/\n/g, '\n    ')}`);
    else console.log('metrics parity: SDK inventory passes metricslint -strict');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`metrics parity failed:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
}

main();
