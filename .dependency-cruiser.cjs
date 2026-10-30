// dependency-cruiser CI check for the SDK's dependency rules (design doc §C1). Generated from
// packages/frontend-sdk/subpaths.json, the same source the ESLint boundaries config uses, so the
// two checks cannot disagree.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const { subpaths, packageImports } = JSON.parse(
  readFileSync(join(__dirname, 'packages/frontend-sdk/subpaths.json'), 'utf8'),
);
const names = subpaths.map((s) => s.name);
const allowed = (s) => (s.imports.includes('*') ? names.filter((n) => n !== s.name) : s.imports);
const SRC = '^packages/frontend-sdk/src';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const forbidden = [
  {
    name: 'no-circular',
    severity: 'error',
    comment: 'Subpaths form a DAG (design doc §C1 layers).',
    from: {},
    to: { circular: true },
  },
  // Each subpath may import only the subpaths listed for it (plus itself and src/internal).
  ...subpaths
    .filter((s) => !s.imports.includes('*'))
    .map((s) => ({
      name: `subpath-${s.name}`,
      severity: 'error',
      comment: `/${s.name} may import only: ${allowed(s).map((n) => `/${n}`).join(', ') || 'no other subpath'}.`,
      from: { path: `${SRC}/${s.name}/` },
      to: {
        path: `${SRC}/(${names.join('|')})/`,
        pathNot: `${SRC}/(${[s.name, ...allowed(s)].join('|')})/`,
      },
    })),
  {
    name: 'internal-uses-core-only',
    severity: 'error',
    comment: 'src/internal is shared private code: it may use /core only.',
    from: { path: `${SRC}/internal/` },
    to: { path: `${SRC}/(${names.filter((n) => n !== 'core').join('|')})/` },
  },
  {
    name: 'index-only',
    severity: 'error',
    comment: "Another subpath is imported only through its index.ts (its public surface).",
    from: { path: `${SRC}/([a-z0-9]+)/` },
    // Subpath folders only: src/internal has no index.ts and is shared by every subpath.
    to: { path: `${SRC}/(${names.join('|')})/.+`, pathNot: [`${SRC}/$1/`, `${SRC}/[a-z0-9]+/index\\.ts$`] },
  },
  // Restricted third-party packages (React only in /react, OpenTelemetry only in /tracing, /logging, /metrics).
  ...Object.entries(packageImports)
    .filter(([key]) => !key.startsWith('_'))
    .map(([pkg, owners]) => ({
      name: `package-${pkg.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`,
      severity: 'error',
      comment: `${pkg} may only be imported by /${owners.join(', /')}.`,
      from: { path: `${SRC}/`, pathNot: `${SRC}/(${owners.join('|')})/` },
      to: {
        dependencyTypesNot: ['local'],
        path: pkg.endsWith('/') ? `(^|node_modules/)${esc(pkg)}` : `(^|node_modules/)${esc(pkg)}($|/)`,
      },
    })),
];

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '^packages/[^/]+/(dist|coverage|test)/' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts', '.tsx', '.js'] },
  },
};
