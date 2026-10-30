// Regenerates the `exports` map of packages/frontend-sdk/package.json: one entry per implemented
// subpath (src/<name>/index.ts exists) plus the throwing root "." (design doc §C1 "Build").
// `--check` fails instead of writing when the map is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SDK_DIR, implementedSubpaths } from './lib/subpaths.ts';

export type ExportsMap = Record<string, string | { types: string; import: string }>;

export function buildExportsMap(subpaths: readonly string[]): ExportsMap {
  const map: ExportsMap = { '.': { types: './dist/root.d.ts', import: './dist/root.js' } };
  for (const name of subpaths) {
    map[`./${name}`] = { types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js` };
  }
  map['./package.json'] = './package.json';
  return map;
}

function main(): void {
  const check = process.argv.includes('--check');
  const file = join(SDK_DIR, 'package.json');
  const text = readFileSync(file, 'utf8');
  const pkg = JSON.parse(text) as { exports?: ExportsMap };
  const want = buildExportsMap(implementedSubpaths());
  if (JSON.stringify(pkg.exports) === JSON.stringify(want)) return;
  if (check) {
    console.error('packages/frontend-sdk/package.json exports map is stale: run `pnpm exports:sync`.');
    process.exit(1);
  }
  pkg.exports = want;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`exports map updated (${Object.keys(want).length - 2} subpaths)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
