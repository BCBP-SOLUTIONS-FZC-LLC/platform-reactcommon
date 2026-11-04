// Checks the packed tarballs (dist-packages/, from .github/scripts/pack-packages.sh) are publishable to
// GitHub Packages, reading each package.json out of its tarball: what the registry will receive. Also
// checks each tarball ships the files every package must (its README).
//
//   pnpm publish:check            CI (package job, ci.yml and release.yml)
//   pnpm publish:check --dist-tag print the dist-tag the release publishes under
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { distTag, publishProblems, tarballProblems, type Manifest } from './lib/publish.ts';

const dir = resolve(process.env.PKG_DIR ?? 'dist-packages');
const tarballs = readdirSync(dir).filter((f) => f.endsWith('.tgz'));
const manifests = tarballs.map((t) => JSON.parse(execFileSync('tar', ['-xOzf', join(dir, t), 'package/package.json'], { encoding: 'utf8' })) as Manifest);

if (process.argv.includes('--dist-tag')) {
  console.log(distTag(manifests[0]?.version ?? ''));
  process.exit(0);
}
const problems = [
  ...publishProblems(manifests),
  ...tarballs.flatMap((t, i) => tarballProblems(manifests[i]?.name ?? t, execFileSync('tar', ['-tzf', join(dir, t)], { encoding: 'utf8' }).split('\n').filter(Boolean))),
];
if (problems.length > 0) {
  console.error(`::error title=Publish check::the packed manifests are not publishable:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`publish check: ${tarballs.length} tarballs (${manifests.map((m) => `${m.name}@${m.version}`).join(', ')}) ready for GitHub Packages, dist-tag ${distTag(manifests[0]!.version!)}`);
