import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExportsMap } from '../sync-exports.ts';
import { REPO_ROOT, SDK_DIR, allowedImports, implementedSubpaths, loadSubpathConfig, validateAreas, validateSubpathConfig } from './subpaths.ts';

describe('subpaths.json', () => {
  const config = loadSubpathConfig();

  it('lists the 17 subpaths of design doc §C1', () => {
    expect(config.subpaths.map((s) => s.name)).toEqual([
      'core', 'problem', 'authz', 'config', 'security', 'storage', 'tracing', 'logging', 'metrics',
      'http', 'flags', 'i18n', 'auth', 'mfe', 'nav', 'react', 'testing',
    ]);
  });

  it('encodes the §C1 dependency rules', () => {
    expect(allowedImports('core', config)).toEqual([]);
    expect(allowedImports('http', config)).toEqual(['core', 'config', 'problem', 'tracing', 'logging']);
    // /auth never imports /http: it reaches IAM through ports the shell implements.
    expect(allowedImports('auth', config)).not.toContain('http');
    // /metrics reads other modules' data through PlatformRuntime only.
    expect(allowedImports('metrics', config)).toEqual(['core', 'config']);
    expect(allowedImports('testing', config)).toHaveLength(16);
  });

  it('only allows imports downwards, so the subpaths form a DAG', () => {
    const layer = new Map(config.subpaths.map((s) => [s.name, s.layer]));
    for (const s of config.subpaths) {
      for (const dep of allowedImports(s.name, config)) {
        if (s.name !== 'testing') expect(layer.get(dep)!, `${s.name} → ${dep}`).toBeLessThan(s.layer);
      }
    }
  });

  it('restricts React and OpenTelemetry to their subpaths', () => {
    expect(config.packageImports).toEqual({
      react: ['react', 'testing'],
      'react-dom': ['react', 'testing'],
      '@opentelemetry/': ['tracing', 'logging', 'metrics', 'testing'],
    });
  });

  it('rejects malformed configs', () => {
    expect(() => validateSubpathConfig([{ name: 'a', layer: 0, imports: ['b'] }])).toThrow('unknown subpath b');
    expect(() => validateSubpathConfig([{ name: 'a', layer: 0, imports: ['a'] }])).toThrow('lists itself');
    expect(() =>
      validateSubpathConfig([
        { name: 'a', layer: 0, imports: [] },
        { name: 'a', layer: 0, imports: [] },
      ]),
    ).toThrow('duplicate');
    expect(() => validateSubpathConfig([{ name: 'A-b', layer: 0, imports: [] }])).toThrow('invalid subpath name');
  });
});

describe('functional areas', () => {
  const config = loadSubpathConfig();
  const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

  it('groups the 17 subpaths into the seven areas of docs/areas', () => {
    const byArea = Object.fromEntries(config.areas.map((a) => [a.id, config.subpaths.filter((s) => s.area === a.id).map((s) => s.name)]));
    expect(byArea).toEqual({
      foundation: ['core', 'problem', 'config'],
      observability: ['tracing', 'logging', 'metrics'],
      'data-access': ['http'],
      'identity-access': ['authz', 'storage', 'auth'],
      'mfe-platform': ['flags', 'mfe', 'nav'],
      'ui-support': ['security', 'i18n'],
      'developer-surface': ['react', 'testing'],
    });
  });

  it("each area's page names every subpath of the area, and the index lists every page and subpath", () => {
    const index = read('docs/areas/README.md');
    for (const a of config.areas) {
      const page = read(a.page);
      expect(page.startsWith(`# ${a.title}\n`), a.page).toBe(true);
      expect(index, a.id).toContain(`(${a.page.replace('docs/areas/', '')})`);
      for (const s of config.subpaths.filter((x) => x.area === a.id)) {
        expect(page, `${a.page} → /${s.name}`).toContain(`\`/${s.name}\``);
        expect(index, `index → /${s.name}`).toContain(`\`/${s.name}\``);
      }
    }
  });

  it('rejects subpaths without a known area, areas without subpaths, and bad pages', () => {
    const area = { id: 'a', title: 'A', summary: 'S', page: 'docs/areas/a.md' };
    expect(() => validateAreas([area], [{ name: 'x', layer: 0, imports: [] }])).toThrow('no known area');
    expect(() => validateAreas([area], [{ name: 'x', layer: 0, area: 'b', imports: [] }])).toThrow('no known area');
    expect(() => validateAreas([area, { ...area, id: 'b' }], [{ name: 'x', layer: 0, area: 'a', imports: [] }])).toThrow('area b has no subpath');
    expect(() => validateAreas([area, area], [{ name: 'x', layer: 0, area: 'a', imports: [] }])).toThrow('duplicate area');
    expect(() => validateAreas([{ ...area, page: 'README.md' }], [{ name: 'x', layer: 0, area: 'a', imports: [] }])).toThrow('docs/areas');
  });
});

describe('exports map', () => {
  it('has the throwing root plus one entry per implemented subpath', () => {
    expect(buildExportsMap(['core', 'http'])).toEqual({
      '.': { types: './dist/root.d.ts', import: './dist/root.js' },
      './core': { types: './dist/core/index.d.ts', import: './dist/core/index.js' },
      './http': { types: './dist/http/index.d.ts', import: './dist/http/index.js' },
      './package.json': './package.json',
    });
  });

  it('matches packages/frontend-sdk/package.json (pnpm exports:sync keeps them in step)', () => {
    const pkg = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { exports: unknown };
    expect(pkg.exports).toEqual(buildExportsMap(implementedSubpaths()));
  });
});
