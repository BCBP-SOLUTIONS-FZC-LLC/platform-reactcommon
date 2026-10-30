import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpack from 'webpack';
import { afterAll, describe, expect, it } from 'vitest';
import { containerGlobal } from '../../frontend-sdk/src/mfe/remote.ts';
import { containerName, platformShared, platformWebpackConfig, sharedFor } from '../src/index.ts';
import { SDK_SUBPATHS } from '../src/generated/sdk.ts';

const require = createRequire(import.meta.url);
// webpack's own range matcher, the one share negotiation uses.
const { parseRange, satisfy } = require(join(require.resolve('webpack'), '../sharing/semver.js')) as {
  parseRange(r: string): unknown;
  satisfy(range: unknown, version: string): boolean;
};
const sdkPkg = JSON.parse(readFileSync(join(import.meta.dirname, '../../frontend-sdk/package.json'), 'utf8')) as {
  version: string;
  peerDependencies: Record<string, string>;
};
const reactVersion = (JSON.parse(readFileSync(require.resolve('react/package.json', { paths: [join(import.meta.dirname, '../../frontend-sdk')] }), 'utf8')) as { version: string }).version;

describe('platformShared', () => {
  it('shares React, OTel API and every SDK subpath but /testing as strict singletons', () => {
    expect(Object.keys(platformShared)).toEqual([
      'react',
      'react-dom',
      '@opentelemetry/api',
      '@platform/frontend-sdk',
      ...SDK_SUBPATHS.filter((s) => s !== 'testing').map((s) => `@platform/frontend-sdk/${s}`),
    ]);
    for (const c of Object.values(platformShared)) expect(c).toMatchObject({ singleton: true, strictVersion: true });
    expect(platformShared['@platform/frontend-sdk']!.requiredVersion).toBe('^1.0.0-0');
  });

  it('pins agree with the SDK peer ranges, under webpack semver', () => {
    expect(platformShared.react!.requiredVersion).toBe(sdkPkg.peerDependencies.react);
    expect(platformShared['react-dom']!.requiredVersion).toBe(sdkPkg.peerDependencies['react-dom']);
    const otel = parseRange(platformShared['@opentelemetry/api']!.requiredVersion);
    expect(['1.10.0', '1.10.9'].map((v) => satisfy(otel, v))).toEqual([true, true]);
    expect(['1.9.0', '1.11.0'].map((v) => satisfy(otel, v))).toEqual([false, false]);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), reactVersion)).toBe(true);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), '18.3.1')).toBe(true);
    expect(satisfy(parseRange(platformShared.react!.requiredVersion), '17.0.2')).toBe(false);
  });

  it('the SDK share range accepts the alpha pre-releases and later 1.x, never 2.x', () => {
    const r = parseRange(platformShared['@platform/frontend-sdk']!.requiredVersion);
    expect([sdkPkg.version, '1.0.0-alpha.7', '1.0.0', '1.4.2'].map((v) => satisfy(r, v))).toEqual([true, true, true, true]);
    expect(satisfy(r, '2.0.0')).toBe(false);
  });
});

describe('sharedFor', () => {
  it('shell: eager false everywhere', () => {
    for (const c of Object.values(sharedFor('shell'))) expect(c.eager).toBe(false);
  });

  it('remote: the SDK is never bundled (import: false); React is', () => {
    const r = sharedFor('remote');
    expect(r['@platform/frontend-sdk/http']!.import).toBe(false);
    expect(r['@platform/frontend-sdk']!.import).toBe(false);
    expect(r.react!.import).toBeUndefined();
  });
});

describe('containerName', () => {
  it.each(['tenders', 'iam-admin', 'a-b-c', 'x_y'])('%s matches the SDK loadRemote rule', (name) => {
    expect(containerName(name)).toBe(containerGlobal(name));
    expect(containerName(name)).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it.each(['shell', 'Tenders', '9lives', '', 'a/b'])('refuses %j', (name) => {
    expect(() => containerName(name)).toThrow(TypeError);
  });
});

describe('platformWebpackConfig', () => {
  it('sets CSP-safe output for both modes', () => {
    for (const mode of ['production', 'development'] as const) {
      const c = platformWebpackConfig({ role: 'shell', mode });
      expect(String(c.devtool)).not.toMatch(/eval/);
      expect(c.output).toMatchObject({ publicPath: 'auto', trustedTypes: { policyName: 'platform-webpack' }, crossOriginLoading: false });
    }
    const prod = platformWebpackConfig({ role: 'shell', mode: 'production' });
    expect(prod.devtool).toBe('hidden-source-map');
    expect(prod.output?.filename).toContain('[contenthash]');
  });

  it('refuses a remote without a valid name', () => {
    expect(() => platformWebpackConfig({ role: 'remote', mode: 'production' })).toThrow(TypeError);
    expect(() => platformWebpackConfig({ role: 'remote', name: 'shell', mode: 'production' })).toThrow(TypeError);
  });
});

describe('a real build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'preset-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function compile(config: webpack.Configuration): Promise<webpack.Stats> {
    return new Promise((resolve, reject) =>
      webpack(config, (err, stats) => {
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
        resolve(stats!);
      }),
    );
  }

  it('a remote exposes window.<containerName>, keeps the SDK out of its bundle, and emits no eval', async () => {
    writeFileSync(join(dir, 'Edit.js'), "import { getLogger } from '@platform/frontend-sdk/logging';\nexport default function Edit() { getLogger().info('edit'); return 'edit'; }\n");
    writeFileSync(join(dir, 'remote.js'), '// remote entry for standalone runs\n');
    const out = join(dir, 'remote-dist');
    const preset = platformWebpackConfig({ role: 'remote', name: 'iam-admin', exposes: { './Edit': './Edit.js' }, mode: 'production' });
    await compile({ ...preset, context: dir, entry: { main: './remote.js' }, output: { ...preset.output, path: out } });
    const entry = readFileSync(join(out, 'remoteEntry.js'), 'utf8');
    expect(entry).toMatch(/\biam_admin\b/);
    expect(entry).toContain('platform-webpack');
    const all = readdirSync(out)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(out, f), 'utf8'))
      .join('\n');
    expect(all).not.toMatch(/\beval\(|new Function\(/);
    expect(all).not.toContain('PlatformRuntime'); // the SDK came from nowhere but the shell
    expect(readdirSync(out).some((f) => f.endsWith('.map'))).toBe(true); // hidden maps: emitted, not referenced
    expect(all).not.toContain('sourceMappingURL');
  });

  it('a shell builds with the same shared map', async () => {
    writeFileSync(join(dir, 'bootstrap.js'), "export const ready = 'shell';\n");
    writeFileSync(join(dir, 'shell.js'), "import('./bootstrap.js');\n");
    const out = join(dir, 'shell-dist');
    const preset = platformWebpackConfig({ role: 'shell', mode: 'development' });
    await compile({ ...preset, context: dir, entry: { main: './shell.js' }, output: { ...preset.output, path: out } });
    expect(readdirSync(out)).toContain('main.js');
    expect(readFileSync(join(out, 'main.js'), 'utf8')).not.toMatch(/\beval\(/);
  });
});
