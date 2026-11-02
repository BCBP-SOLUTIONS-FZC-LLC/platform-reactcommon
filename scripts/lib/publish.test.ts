import { describe, expect, it } from 'vitest';
import { distTag, PACKAGES, publishProblems, REGISTRY, REPOSITORY, type Manifest } from './publish.ts';

const good = (): Manifest[] =>
  Object.entries(PACKAGES).map(([name, directory]) => ({
    name,
    version: '1.0.0-alpha.1',
    license: 'UNLICENSED',
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
      { ...preset!, version: '1.0.0-alpha.2', repository: 'https://example.com/x.git', dependencies: { '@bcbp-solutions-fzc-llc/frontend-sdk': 'workspace:^' } },
    ];
    expect(publishProblems(bad)).toEqual([
      '@platform/frontend-sdk: not one of @bcbp-solutions-fzc-llc/frontend-sdk, @bcbp-solutions-fzc-llc/webpack-preset, @bcbp-solutions-fzc-llc/eslint-plugin (GitHub Packages needs the @bcbp-solutions-fzc-llc scope)',
      '@platform/frontend-sdk: private: true would refuse the publish',
      '@platform/frontend-sdk: no license field (UNLICENSED until a license is chosen: VERSIONING.md)',
      '@platform/frontend-sdk: publishConfig.registry must be https://npm.pkg.github.com',
      '@platform/frontend-sdk: publishConfig.access is not used by GitHub Packages (visibility follows the repository)',
      `@bcbp-solutions-fzc-llc/webpack-preset: repository.url must be ${REPOSITORY}, so GitHub links the package to this repository`,
      '@bcbp-solutions-fzc-llc/webpack-preset: repository.directory must be packages/webpack-preset',
      '@bcbp-solutions-fzc-llc/webpack-preset: dependencies.@bcbp-solutions-fzc-llc/frontend-sdk is workspace:^, which a consumer cannot install',
      '@bcbp-solutions-fzc-llc/frontend-sdk: no tarball',
      '@bcbp-solutions-fzc-llc/eslint-plugin: no tarball',
      'versions differ (1.0.0-alpha.1, 1.0.0-alpha.2): the three packages release under one version (changesets fixed group)',
    ]);
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
