#!/usr/bin/env node
// The CHANGELOG step of a release PR (VERSIONING.md, "Maintainer release process"): `## [Unreleased]` becomes
// `## [X.Y.Z] - YYYY-MM-DD` under a new empty `## [Unreleased]`, and the compare links follow.
//   node .claude/skills/release/release-changelog.mjs <version> [date] [file]
// version without the v (1.0.0-alpha.2); date defaults to today (UTC); file defaults to CHANGELOG.md.
// Refuses an empty [Unreleased] or a version that already has a section. Tested by scripts/lib/claude-hooks.test.ts.
import { readFileSync, writeFileSync } from 'node:fs';

const REPO_URL = 'https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon';

export function releaseChangelog(text, version, date) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (text.includes(`## [${version}]`)) throw new Error(`CHANGELOG already has a [${version}] section`);
  const head = '## [Unreleased]\n';
  const at = text.indexOf(head);
  if (at < 0) throw new Error('no "## [Unreleased]" section');
  const next = text.indexOf('\n## [', at + head.length);
  const linksAt = text.search(/^\[Unreleased\]: /m);
  const end = [next < 0 ? text.length : next + 1, linksAt < 0 ? text.length : linksAt].reduce((a, b) => Math.min(a, b));
  if (text.slice(at + head.length, end).trim() === '') throw new Error('[Unreleased] is empty: nothing to release');
  let out = `${text.slice(0, at)}${head}\n## [${version}] - ${date}\n${text.slice(at + head.length)}`;
  // Links: [Unreleased] compares from the new tag; the new version links its release (the first) or its compare.
  const prev = /^\[Unreleased\]: .*\/compare\/v(.+)\.\.\.HEAD$/m.exec(out)?.[1];
  const versionLink = prev ? `${REPO_URL}/compare/v${prev}...v${version}` : `${REPO_URL}/releases/tag/v${version}`;
  out = out.replace(/^\[Unreleased\]: .*$/m, `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD\n[${version}]: ${versionLink}`);
  if (!/^\[Unreleased\]: /m.test(out)) out = `${out.trimEnd()}\n\n[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD\n[${version}]: ${versionLink}\n`;
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, date = new Date().toISOString().slice(0, 10), file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    console.error('usage: release-changelog.mjs <version> [date] [file]');
    process.exit(1);
  }
  writeFileSync(file, releaseChangelog(readFileSync(file, 'utf8'), version, date));
  console.log(`${file}: [Unreleased] → [${version}] - ${date}`);
}
