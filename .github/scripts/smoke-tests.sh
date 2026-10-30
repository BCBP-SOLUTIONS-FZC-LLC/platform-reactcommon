#!/usr/bin/env bash
# Smoke tests of the packed tarballs (dist-packages/), as a consumer gets them: installs them with
# npm into an empty project (with the peers a shell or remote has), then
#   1. imports every SDK subpath listed in the exports map, and checks the root import throws;
#   2. loads @platform/webpack-preset and checks platformShared lists every shared SDK subpath;
#   3. loads @platform/eslint-plugin and lints a snippet with configs.recommended;
#   4. typechecks a consumer file against the published .d.ts files.
# The counterpart of gincommon's image smoke tests: the artefact itself, not the source tree.
set -euo pipefail

PKG_DIR="$(cd "${PKG_DIR:-dist-packages}" && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "${WORK}"' EXIT
cd "${WORK}"

cat > package.json <<'JSON'
{ "name": "smoke-consumer", "private": true, "type": "module" }
JSON

echo "::group::Install the tarballs and peers"
npm install --no-audit --no-fund --loglevel=error \
  "${PKG_DIR}"/*.tgz \
  react@19 react-dom@19 @types/react@19 @types/react-dom@19 '@opentelemetry/api@~1.10.0' \
  webpack@5 eslint@10 typescript@6 @types/node@22
echo "::endgroup::"

cat > smoke.mjs <<'JS'
import { readFileSync } from 'node:fs';

const fail = (msg) => { console.error(`::error title=Smoke test::${msg}`); process.exitCode = 1; };
const sdkPkg = JSON.parse(readFileSync('node_modules/@platform/frontend-sdk/package.json', 'utf8'));
const subpaths = Object.keys(sdkPkg.exports).filter((k) => k !== '.' && k !== './package.json').map((k) => k.slice(2));
if (subpaths.length === 0) fail('the SDK exports map lists no subpaths');

// 1. Every subpath imports; the root throws (no barrel, design doc §C1).
for (const s of subpaths) {
  try {
    const m = await import(`@platform/frontend-sdk/${s}`);
    if (Object.keys(m).length === 0) fail(`@platform/frontend-sdk/${s} exports nothing`);
  } catch (e) {
    fail(`import @platform/frontend-sdk/${s} failed: ${e?.message ?? e}`);
  }
}
let rootThrew = false;
try { await import('@platform/frontend-sdk'); } catch { rootThrew = true; }
if (!rootThrew) fail('importing the package root must throw');
const core = await import('@platform/frontend-sdk/core');
const identity = core.initializeCore({ serviceName: 'web-app', domain: 'portal', environment: 'prod', buildVersion: sdkPkg.version });
if (identity.domain !== 'portal') fail('initializeCore did not accept the portal domain');

// 2. webpack-preset shares every SDK subpath except /testing.
const preset = await import('@platform/webpack-preset');
const shared = Object.keys(preset.platformShared);
for (const s of subpaths.filter((x) => x !== 'testing')) {
  if (!shared.includes(`@platform/frontend-sdk/${s}`)) fail(`platformShared lacks @platform/frontend-sdk/${s}`);
}
if (preset.containerName('iam-admin') !== 'iam_admin') fail('containerName rule changed');

// 3. eslint-plugin's recommended config runs.
const { Linter } = await import('eslint');
const plugin = (await import('@platform/eslint-plugin')).default;
const messages = new Linter().verify("import x from '@platform/frontend-sdk';\nlocalStorage.setItem('k', 'v');\n", [
  plugin.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
]);
const ids = messages.map((m) => m.ruleId).sort().join(',');
if (ids !== '@platform/no-raw-storage,@platform/no-sdk-root-import') fail(`eslint-plugin reported [${ids}]`);

console.log(`smoke: ${subpaths.length} SDK subpaths import, root throws, preset shares ${shared.length} modules, eslint-plugin rules run`);
JS
node smoke.mjs

# 4. The published types: a consumer importing every subpath typechecks.
node -e "
const s = Object.keys(require('./node_modules/@platform/frontend-sdk/package.json').exports).filter((k) => k !== '.' && k !== './package.json');
require('fs').writeFileSync('types.ts', s.map((k, i) => 'import * as m' + i + \" from '@platform/frontend-sdk\" + k.slice(1) + \"';\").join('\n') + '\nexport const all = [' + s.map((_, i) => 'm' + i).join(', ') + '];\nimport { platformShared } from \'@platform/webpack-preset\';\nimport plugin from \'@platform/eslint-plugin\';\nexport const more = [platformShared, plugin];\n');
"
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "noEmit": true, "skipLibCheck": false, "lib": ["ESNext", "DOM"], "jsx": "react-jsx", "types": ["node"] }, "files": ["types.ts"] }
JSON
if ! npx --no-install tsc -p tsconfig.json; then
  echo "::error title=Smoke test::the published .d.ts files do not typecheck for a consumer"
  exit 1
fi
echo "smoke: consumer typecheck of the published types passed"
