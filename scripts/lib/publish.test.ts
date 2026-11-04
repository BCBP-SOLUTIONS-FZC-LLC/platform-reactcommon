import { describe, expect, it } from 'vitest';
import { distTag, ENGINES_NODE, PACKAGES, publishProblems, REGISTRY, REPOSITORY, tarballProblems, type Manifest } from './publish.ts';

const good = (): Manifest[] =>
  Object.entries(PACKAGES).map(([name, directory]) => ({
    name,
    version: '1.0.0-alpha.1',
    license: 'UNLICENSED',
    engines: { node: ENGINES_NODE },
    repository: { type: 'git', url: REPOSITORY, directory },
    publishConfig: { registry: REGISTRY },
    peerDependencies: { react: '^19.0.0' },
  }));

describe('publishProblems', () => {
  it('accepts the three packages as configured', () => {
    expect(publishProblems(good())).toEqual([]);
  });

  it('names every problem: scope, private, license, repository, registry, access, workspace specs, versions, a missing tarball', () => {
    const [sdk, preset] = good();
    const { license: _drop, ...unlicensed } = sdk!;
    const bad: Manifest[] = [
      { ...unlicensed, name: '@platform/frontend-sdk', private: true, publishConfig: { access: 'restricted' } },
      { ...preset!, version: '1.0.0-alpha.2', engines: { node: '>=18' }, repository: 'https://example.com/x.git', dependencies: { '@bcbp-solutions-fzc-llc/frontend-sdk': 'workspace:^' } },
    ];
    expect(publishProblems(bad)).toEqual([
      '@platform/frontend-sdk: not one of @bcbp-solutions-fzc-llc/frontend-sdk, @bcbp-solutions-fzc-llc/webpack-preset, @bcbp-solutions-fzc-llc/eslint-plugin (GitHub Packages needs the @bcbp-solutions-fzc-llc scope)',
      '@platform/frontend-sdk: private: true would refuse the publish',
      '@platform/frontend-sdk: no license field (UNLICENSED until a license is chosen: VERSIONING.md)',
      '@platform/frontend-sdk: publishConfig.registry must be https://npm.pkg.github.com',
      '@platform/frontend-sdk: publishConfig.access is not used by GitHub Packages (visibility follows the repository)',
      '@bcbp-solutions-fzc-llc/webpack-preset: engines.node must be >=22 (it is >=18)',
      `@bcbp-solutions-fzc-llc/webpack-preset: repository.url must be ${REPOSITORY}, so GitHub links the package to this repository`,
      '@bcbp-solutions-fzc-llc/webpack-preset: repository.directory must be packages/webpack-preset',
      '@bcbp-solutions-fzc-llc/webpack-preset: dependencies.@bcbp-solutions-fzc-llc/frontend-sdk is workspace:^, which a consumer cannot install',
      '@bcbp-solutions-fzc-llc/frontend-sdk: no tarball',
      '@bcbp-solutions-fzc-llc/eslint-plugin: no tarball',
      'versions differ (1.0.0-alpha.1, 1.0.0-alpha.2): the three packages release under one version (changesets fixed group)',
    ]);
  });
});

describe('publishProblems: engines', () => {
  it('names a missing engines field', () => {
    const [sdk, ...rest] = good();
    const { engines: _drop, ...noEngines } = sdk!;
    expect(publishProblems([noEngines, ...rest])).toEqual(['@bcbp-solutions-fzc-llc/frontend-sdk: engines.node must be >=22 (it is missing)']);
  });
});

describe('tarballProblems', () => {
  it('accepts a tarball with its README', () => {
    expect(tarballProblems('p', ['package/package.json', 'package/README.md', 'package/dist/index.js'])).toEqual([]);
  });

  it('names a missing README', () => {
    expect(tarballProblems('p', ['package/package.json', 'package/dist/index.js', 'package/docs/README.md'])).toEqual(['p: the tarball has no README.md (add it to "files")']);
  });
});

describe('distTag', () => {
  it.each([
    ['1.0.0', 'latest'],
    ['1.2.3', 'latest'],
    ['1.0.0-alpha.1', 'alpha'],
    ['1.0.0-rc.2', 'rc'],
    ['1.0.0-0', 'next'],
  ])('%s → %s', (v, tag) => expect(distTag(v)).toBe(tag));
});
