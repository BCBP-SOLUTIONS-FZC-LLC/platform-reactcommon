// ESLint flat config. The SDK's dependency rules (design doc §C1) are generated from
// packages/frontend-sdk/subpaths.json, the same source dependency-cruiser uses:
// - boundaries/dependencies: which subpaths each subpath may import;
// - no-restricted-imports: only through another subpath's index.ts, and restricted third-party
//   packages (React only in /react, OpenTelemetry only in /tracing, /logging, /metrics).
import { readFileSync } from 'node:fs';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const { subpaths, packageImports: rawPackageImports } = JSON.parse(
  readFileSync(new URL('./packages/frontend-sdk/subpaths.json', import.meta.url), 'utf8'),
);
const packageImports = Object.entries(rawPackageImports).filter(([key]) => !key.startsWith('_'));
const names = subpaths.map((s) => s.name);
const allowed = (s) => (s.imports.includes('*') ? names.filter((n) => n !== s.name) : s.imports);

const SDK_SRC = 'packages/frontend-sdk/src';

const indexOnly = {
  regex: `^\\.\\./(${names.join('|')})/(?!index\\.ts$).+`,
  message: 'Import another subpath only through its index.ts (design doc §C1).',
};

/** no-restricted-imports patterns for the third-party packages `owner` may not import. */
const packagePatternsFor = (owner) =>
  packageImports
    .filter(([, owners]) => !owners.includes(owner))
    .map(([pkg, owners]) => ({
      regex: pkg.endsWith('/') ? `^${pkg.replace('/', '\\/')}` : `^${pkg}(\\/.*)?$`,
      message: `${pkg}${pkg.endsWith('/') ? '*' : ''} may only be imported by /${owners.join(', /')} (design doc §C1).`,
    }));

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/.build/**', '**/temp/**', '**/test/fixtures/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly', process: 'readonly' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: [`${SDK_SRC}/**/*.{ts,tsx}`],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        ...names.map((name) => ({ type: name, pattern: `${SDK_SRC}/${name}` })),
        { type: 'internal', pattern: `${SDK_SRC}/internal` },
      ],
      'import/resolver': { typescript: { project: 'packages/frontend-sdk/tsconfig.json' }, node: true },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            // Each subpath may import only the subpaths listed for it, plus src/internal.
            ...subpaths.map((s) => ({
              from: { element: { type: s.name } },
              disallow: {
                to: { element: { types: { anyOf: names.filter((n) => n !== s.name && !allowed(s).includes(n)) } } },
              },
            })),
            // src/internal is shared private code: it may use /core only, never a higher subpath.
            {
              from: { element: { type: 'internal' } },
              disallow: { to: { element: { types: { anyOf: names.filter((n) => n !== 'core') } } } },
            },
          ],
        },
      ],
      // Files outside any subpath folder (root.ts, internal/) may not use restricted packages at all.
      'no-restricted-imports': ['error', { patterns: [indexOnly, ...packagePatternsFor('internal')] }],
    },
  },
  // One block per subpath, so each gets its own package restrictions (a later block's
  // no-restricted-imports replaces an earlier one's for the same files).
  ...names.map((name) => ({
    files: [`${SDK_SRC}/${name}/**/*.{ts,tsx}`],
    rules: { 'no-restricted-imports': ['error', { patterns: [indexOnly, ...packagePatternsFor(name)] }] },
  })),
);
