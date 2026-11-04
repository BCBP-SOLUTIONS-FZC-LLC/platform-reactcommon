// What a packed package.json must say before it is published to GitHub Packages (VERSIONING.md,
// "Publishing"). Pure; scripts/check-publish.ts reads the manifests out of the tarballs.

export const SCOPE = '@bcbp-solutions-fzc-llc';
export const REGISTRY = 'https://npm.pkg.github.com';
export const REPOSITORY = 'git+https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon.git';
export const PACKAGES: Readonly<Record<string, string>> = {
  [`${SCOPE}/frontend-sdk`]: 'packages/frontend-sdk',
  [`${SCOPE}/webpack-preset`]: 'packages/webpack-preset',
  [`${SCOPE}/eslint-plugin`]: 'packages/eslint-plugin',
};

/** The Node range every package declares (`.nvmrc` 22; the build and the preset use Node 22 APIs). */
export const ENGINES_NODE = '>=22';
/** Files every tarball must ship besides its package.json and dist/: the registry page shows the README. */
export const REQUIRED_FILES = ['README.md'] as const;

export interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  engines?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string } | string;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Problems with the packed manifests of one release: each package's own, and the set as a whole. */
export function publishProblems(manifests: readonly Manifest[]): string[] {
  const problems: string[] = [];
  for (const m of manifests) {
    const id = m.name ?? '(no name)';
    const dir = m.name ? PACKAGES[m.name] : undefined;
    if (!dir) problems.push(`${id}: not one of ${Object.keys(PACKAGES).join(', ')} (GitHub Packages needs the ${SCOPE} scope)`);
    if (m.private) problems.push(`${id}: private: true would refuse the publish`);
    if (!m.license) problems.push(`${id}: no license field (UNLICENSED until a license is chosen: VERSIONING.md)`);
    if (m.engines?.node !== ENGINES_NODE) problems.push(`${id}: engines.node must be ${ENGINES_NODE} (it is ${m.engines?.node ?? 'missing'})`);
    const repo = typeof m.repository === 'string' ? { url: m.repository } : (m.repository ?? {});
    if (repo.url !== REPOSITORY) problems.push(`${id}: repository.url must be ${REPOSITORY}, so GitHub links the package to this repository`);
    if (dir && repo.directory !== dir) problems.push(`${id}: repository.directory must be ${dir}`);
    const pc = m.publishConfig ?? {};
    if (pc.registry !== REGISTRY) problems.push(`${id}: publishConfig.registry must be ${REGISTRY}`);
    for (const k of Object.keys(pc)) if (k !== 'registry') problems.push(`${id}: publishConfig.${k} is not used by GitHub Packages (visibility follows the repository)`);
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [dep, spec] of Object.entries(m[field] ?? {})) {
        if (/^(workspace|link|file|portal):/.test(spec)) problems.push(`${id}: ${field}.${dep} is ${spec}, which a consumer cannot install`);
      }
    }
  }
  const names = manifests.map((m) => m.name);
  for (const want of Object.keys(PACKAGES)) if (!names.includes(want)) problems.push(`${want}: no tarball`);
  const versions = new Set(manifests.map((m) => m.version));
  if (versions.size > 1) problems.push(`versions differ (${[...versions].join(', ')}): the three packages release under one version (changesets fixed group)`);
  return problems;
}

/** Problems with a tarball's contents (`entries`: its paths, as `tar -tzf` lists them, under package/). */
export function tarballProblems(name: string, entries: readonly string[]): string[] {
  const have = new Set(entries.map((e) => e.replace(/^package\//, '')));
  return REQUIRED_FILES.filter((f) => !have.has(f)).map((f) => `${name}: the tarball has no ${f} (add it to "files")`);
}

/** The npm dist-tag for a version: its prerelease identifier (alpha, rc), else latest. */
export function distTag(version: string): string {
  const pre = /^\d+\.\d+\.\d+-([0-9A-Za-z]+)/.exec(version)?.[1];
  if (pre && /^\d+$/.test(pre)) return 'next';
  return pre ?? 'latest';
}
