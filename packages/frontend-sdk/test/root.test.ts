import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('root entry point', () => {
  it('throws a helpful error telling the caller to import a subpath', async () => {
    await expect(import('../src/root.ts')).rejects.toThrow(
      "import a subpath such as '@platform/frontend-sdk/core'",
    );
  });

  it('is published as an ESM, side-effect-free package with no root barrel', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')) as {
      type: string;
      sideEffects: boolean;
      version: string;
      exports: Record<string, unknown>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.version).toMatch(/^1\.0\.0-alpha\.\d+$/);
    expect(pkg.exports['.']).toEqual({ types: './dist/root.d.ts', import: './dist/root.js' });
  });
});
