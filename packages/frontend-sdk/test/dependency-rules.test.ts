// The dependency rules (design doc §C1) are enforced twice, by ESLint (boundaries +
// no-restricted-imports) and by dependency-cruiser, both generated from subpaths.json. This test
// runs both against test/fixtures/boundaries, a tree of deliberate violations laid out like the
// SDK, and asserts that each tool reports exactly those violations.
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const REPO = resolve(import.meta.dirname, '../../..');
const FIXTURE = join(import.meta.dirname, 'fixtures/boundaries');
const SRC = 'packages/frontend-sdk/src';

describe('dependency rules', () => {
  it('ESLint reports every forbidden subpath, deep and package import', async () => {
    const eslint = new ESLint({
      cwd: FIXTURE,
      overrideConfigFile: join(REPO, 'eslint.config.js'),
      ignore: false,
    });
    const results = await eslint.lintFiles([`${SRC}/**/*.ts`]);
    const found = results.flatMap((r) =>
      r.messages.map((m) => `${r.filePath.slice(FIXTURE.length + SRC.length + 2)}:${m.line} ${m.ruleId}`),
    );
    expect(found.sort()).toEqual(
      [
        'auth/index.ts:1 boundaries/dependencies', // auth → tracing (not allowed)
        'auth/index.ts:1 no-restricted-imports', // ../tracing/impl.ts (not its index.ts)
        'core/index.ts:1 boundaries/dependencies', // core → http
        'core/index.ts:2 no-restricted-imports', // react outside /react
        'core/index.ts:3 no-restricted-imports', // @opentelemetry outside tracing/logging/metrics
        'http/index.ts:2 boundaries/dependencies', // http → auth
      ].sort(),
    );
  });

  it('dependency-cruiser reports the same violations, plus the cycle', () => {
    let out = '';
    try {
      execFileSync(
        join(REPO, 'node_modules/.bin/depcruise'),
        [SRC, '--config', join(REPO, '.dependency-cruiser.cjs'), '--output-type', 'err'],
        { cwd: FIXTURE, encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (e) {
      out = (e as { stdout: string }).stdout;
    }
    const rules = [...out.matchAll(/error (\S+):/g)].map((m) => m[1]);
    expect(rules.sort()).toEqual(
      [
        'index-only',
        'no-circular',
        'package-opentelemetry',
        'package-react',
        'subpath-auth',
        'subpath-core',
        'subpath-http',
      ].sort(),
    );
  });
});
