// Checks the example builds against design doc §C3 (run after `pnpm build`):
// - the remote's container is window.tenders (the SDK's loadRemote rule), it bundles no SDK code and it
//   takes react/jsx-runtime from the shared scope;
// - no output can need eval (CSP script-src 'self'): no eval( and no new Function with a body. Zod's
//   capability probe `new Function("")` stays in the bundle but never runs: the SDK sets jitless, which
//   the probe checks first (test/unit/config/schema-csp.test.ts proves no Function is constructed);
// - production source maps are emitted but never referenced (hidden-source-map);
// - index.html loads only external scripts (no inline script);
// - the shell's share scope registers every shared SDK subpath, at the SDK's version, not only those the
//   shell imports (a remote's SDK has no fallback: docs/e2e/integrated-deployment-report.md, Issue 2);
// - every lazily loaded chunk is in its entry's integrity map with its real sha384 (the shell's main
//   bundle, the remote's remoteEntry.js), nothing else is emitted, and the script loader enforces it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_SUBPATHS, SDK_VERSION } from '../packages/webpack-preset/src/generated/sdk.ts';
import { REPO_ROOT } from './lib/subpaths.ts';

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

/** Every file under `dir` (the shell's bundles are under assets/), as paths relative to it. */
function bundle(dir: string): { files: string[]; js: string } {
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => statSync(join(dir, f)).isFile());
  const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  return { files, js };
}

const shellDir = join(REPO_ROOT, 'examples/shell/dist');
const remoteDir = join(REPO_ROOT, 'examples/remote-tenders/dist');
const shell = bundle(shellDir);
const remote = bundle(remoteDir);

for (const [name, b] of [['shell', shell], ['remote-tenders', remote]] as const) {
  check(!/\beval\(|new Function\((?!""\))/.test(b.js), `${name}: output contains eval( or new Function(<code>)`);
  check(!b.js.includes('sourceMappingURL'), `${name}: output references a source map`);
  check(b.files.some((f) => f.endsWith('.js.map')), `${name}: no source maps emitted`);
}
check(remote.files.includes('remoteEntry.js'), 'remote-tenders: no remoteEntry.js');
check(/\bvar tenders\b/.test(readFileSync(join(remoteDir, 'remoteEntry.js'), 'utf8')), 'remote-tenders: remoteEntry.js does not define window.tenders');
check(!remote.js.includes('@bcbp-solutions-fzc-llc/frontend-sdk:session-id'), 'remote-tenders: bundles SDK code (it must come from the shell)');
// The remote's JSX must come from the shell's React (another major's elements fail to render).
check(/"react\/jsx-runtime"/.test(readFileSync(join(remoteDir, 'remoteEntry.js'), 'utf8')), 'remote-tenders: does not consume react/jsx-runtime from the shared scope');
check(shell.js.includes('@bcbp-solutions-fzc-llc/frontend-sdk:session-id'), 'shell: does not bundle the SDK');
// The share-scope registration webpack emits for a provided module: register("<key>","<version>",factory).
const provided = new Set([...shell.js.matchAll(/\("(@bcbp-solutions-fzc-llc\/frontend-sdk\/[a-z0-9]+)","([^"]+)",/g)].filter((m) => m[2] === SDK_VERSION).map((m) => m[1]!));
const missing = SDK_SUBPATHS.filter((s) => s !== 'testing' && !provided.has(`@bcbp-solutions-fzc-llc/frontend-sdk/${s}`));
check(missing.length === 0, `shell: share scope does not provide @bcbp-solutions-fzc-llc/frontend-sdk/{${missing.join(',')}} at ${SDK_VERSION}`);
check(!provided.has('@bcbp-solutions-fzc-llc/frontend-sdk/testing'), 'shell: provides @bcbp-solutions-fzc-llc/frontend-sdk/testing (dev only)');
// Subresource Integrity on lazily loaded chunks (ChunkIntegrityPlugin): the entry's map equals the
// sha384 of exactly the other scripts of the build.
for (const [name, scriptDir, isEntry] of [
  ['shell', join(shellDir, 'assets'), (f: string) => /^main\.[0-9a-f]+\.js$/.test(f)],
  ['remote-tenders', remoteDir, (f: string) => f === 'remoteEntry.js'],
] as const) {
  const scripts = readdirSync(scriptDir).filter((f) => f.endsWith('.js'));
  const entry = scripts.find(isEntry);
  if (!entry) {
    check(false, `${name}: no entry script`);
    continue;
  }
  const runtime = readFileSync(join(scriptDir, entry), 'utf8');
  const map = /sriHashes\s*=\s*(\{[^}]*\})/.exec(runtime)?.[1];
  check(map !== undefined && !runtime.includes('__PLATFORM_CHUNK_INTEGRITY__'), `${name}: ${entry} has no chunk integrity map`);
  check(/\.integrity=\w+\.sriHashes\[\w+\]\|\|"sha384-A{64}"/.test(runtime), `${name}: the script loader does not set integrity (fail-closed)`);
  if (!map) continue;
  const want = Object.values(JSON.parse(map) as Record<string, string>).sort();
  const have = scripts.filter((f) => f !== entry).map((f) => `sha384-${createHash('sha384').update(readFileSync(join(scriptDir, f))).digest('base64')}`).sort();
  check(JSON.stringify(want) === JSON.stringify(have), `${name}: the integrity map (${want.length}) does not match the ${have.length} lazily loaded scripts`);
}
const html = readFileSync(join(shellDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
check(scripts.length > 0 && scripts.every(([, attrs, body]) => /\bsrc=/.test(attrs!) && body!.trim() === ''), 'shell: index.html has an inline script');
check(readdirSync(join(shellDir, 'config')).includes('runtime.json'), 'shell: config/runtime.json not copied');

if (failures.length > 0) {
  console.error(`examples check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('examples: shell and remote-tenders builds pass the §C3 checks');
