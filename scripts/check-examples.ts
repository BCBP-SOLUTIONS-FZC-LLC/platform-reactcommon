// Checks the example builds against design doc §C3 (run after `pnpm build`):
// - the remote's container is window.tenders (the SDK's loadRemote rule), it bundles no SDK code and it
//   takes react/jsx-runtime from the shared scope;
// - no output can need eval (CSP script-src 'self'): no eval( and no new Function with a body. Zod's
//   capability probe `new Function("")` stays in the bundle but never runs: the SDK sets jitless, which
//   the probe checks first (test/config/schema-csp.test.ts proves no Function is constructed);
// - production source maps are emitted but never referenced (hidden-source-map);
// - index.html loads only external scripts (no inline script).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/subpaths.ts';

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};

function bundle(dir: string): { files: string[]; js: string } {
  const files = readdirSync(dir);
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
check(!remote.js.includes('@platform/frontend-sdk:session-id'), 'remote-tenders: bundles SDK code (it must come from the shell)');
// The remote's JSX must come from the shell's React (another major's elements fail to render).
check(/"react\/jsx-runtime"/.test(readFileSync(join(remoteDir, 'remoteEntry.js'), 'utf8')), 'remote-tenders: does not consume react/jsx-runtime from the shared scope');
check(shell.js.includes('@platform/frontend-sdk:session-id'), 'shell: does not bundle the SDK');
const html = readFileSync(join(shellDir, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
check(scripts.length > 0 && scripts.every(([, attrs, body]) => /\bsrc=/.test(attrs!) && body!.trim() === ''), 'shell: index.html has an inline script');
check(readdirSync(join(shellDir, 'config')).includes('runtime.json'), 'shell: config/runtime.json not copied');

if (failures.length > 0) {
  console.error(`examples check failed:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('examples: shell and remote-tenders builds pass the §C3 checks');
