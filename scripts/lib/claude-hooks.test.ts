// .claude/hooks: the PreToolUse guard (generated files and sibling repositories are never hand-edited) and
// the PostToolUse formatter, run as Claude Code runs them: the tool call as JSON on stdin,
// CLAUDE_PROJECT_DIR set, exit 2 = blocked / shown to Claude.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const hook = (name: string) => join(ROOT, '.claude', 'hooks', name);

function run(name: string, filePath: string | undefined, tool = 'Edit'): { code: number; stderr: string } {
  const input = JSON.stringify({ tool_name: tool, tool_input: filePath === undefined ? {} : { file_path: filePath } });
  const r = spawnSync('bash', [hook(name)], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });
  return { code: r.status ?? -1, stderr: r.stderr };
}

describe('guard-generated.sh', () => {
  const at = (rel: string) => join(ROOT, rel);

  it.each([
    ['packages/frontend-sdk/contracts/headers.json', 'pnpm contracts:sync'],
    ['packages/frontend-sdk/contracts/fixtures/identity_cases.json', 'pnpm contracts:sync'],
    ['packages/frontend-sdk/src/internal/generated/forbidden-headers.ts', 'pnpm contracts:sync'],
    ['packages/eslint-plugin/src/generated/forbidden-headers.ts', 'pnpm contracts:sync'],
    ['packages/webpack-preset/src/generated/sdk.ts', 'pnpm exports:sync'],
    ['packages/eslint-plugin/src/generated/sdk.ts', 'pnpm exports:sync'],
    ['packages/frontend-sdk/api/http.api.md', 'pnpm api'],
    ['docs/observability/metric-registry.md', 'pnpm docs:sync'],
    ['docs/observability/tier1-proposal.md', 'pnpm docs:sync'],
    ['docs/problem-details/registry.md', 'pnpm docs:sync'],
    ['docs/architecture/mermaid/package-dependencies.mmd', 'pnpm docs:sync'],
    ['.env', 'local, untracked config'],
  ])('blocks %s and names how to regenerate it', (rel, how) => {
    const r = run('guard-generated.sh', at(rel));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`Blocked: ${rel}`);
    expect(r.stderr).toContain(how);
  });

  it.each([
    'packages/frontend-sdk/contracts/sources.json', // the pins: edited by hand
    'packages/frontend-sdk/contracts/README.md',
    'packages/frontend-sdk/src/http/client.ts',
    'docs/architecture/mermaid/telemetry-pipeline.mmd', // a hand-written diagram source
    'ARCHITECTURE.md',
    '.claude/CLAUDE.md',
  ])('allows %s', (rel) => {
    expect(run('guard-generated.sh', at(rel))).toEqual({ code: 0, stderr: '' });
  });

  it('blocks the sibling repositories (the workspace and the IAM services), allows files elsewhere', () => {
    const go = run('guard-generated.sh', resolve(ROOT, '../../go/platform-gincommon/go.mod'));
    expect(go.code).toBe(2);
    expect(go.stderr).toContain('sibling repository');
    expect(run('guard-generated.sh', resolve(ROOT, '../../../XPertPMS/IAM/iam-org-membership/go.mod')).code).toBe(2);
    expect(run('guard-generated.sh', '/tmp/scratch/notes.md').code).toBe(0); // scratch space, Claude's memory
  });

  it('ignores calls without a path', () => {
    expect(run('guard-generated.sh', undefined).code).toBe(0);
  });
});

describe('post-edit.sh', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('shows Claude the ESLint problems --fix leaves, and passes a clean file', () => {
    dir = mkdtempSync(join(ROOT, 'scripts', 'lib', 'zz-hook-test-'));
    const bad = join(dir, 'bad.ts');
    writeFileSync(bad, 'export const f = (a: any) => a;\n'); // no-explicit-any: --fix cannot fix it
    const r = run('post-edit.sh', bad, 'Write');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('ESLint problems left in');
    expect(r.stderr).toContain('no-explicit-any');
    const good = join(dir, 'good.ts');
    writeFileSync(good, 'export const g = (n: number): number => n + 1;\n');
    expect(run('post-edit.sh', good, 'Write').code).toBe(0);
  }, 60_000);

  it('skips generated, built and outside files', () => {
    expect(run('post-edit.sh', join(ROOT, 'packages/webpack-preset/src/generated/sdk.ts')).code).toBe(0);
    expect(run('post-edit.sh', join(ROOT, 'packages/frontend-sdk/dist/core/index.js')).code).toBe(0);
    expect(run('post-edit.sh', '/tmp/elsewhere.ts').code).toBe(0);
    expect(run('post-edit.sh', join(ROOT, 'README.md')).code).toBe(0);
  });
});

describe('skills/release/release-changelog.mjs', () => {
  const load = () => import('../../.claude/skills/release/release-changelog.mjs');
  const URL = 'https://github.com/BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon';

  it('first release: [Unreleased] becomes the version under a new empty [Unreleased]; links to the release', async () => {
    const { releaseChangelog } = await load();
    const before = `# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a thing\n\n[Unreleased]: ${URL}/commits/main\n`;
    const after = releaseChangelog(before, '1.0.0-alpha.1', '2026-11-03');
    expect(after).toBe(
      `# Changelog\n\n## [Unreleased]\n\n## [1.0.0-alpha.1] - 2026-11-03\n\n### Added\n\n- a thing\n\n` +
        `[Unreleased]: ${URL}/compare/v1.0.0-alpha.1...HEAD\n[1.0.0-alpha.1]: ${URL}/releases/tag/v1.0.0-alpha.1\n`,
    );
  });

  it('a later release: compares with the previous tag; keeps the older sections and links', async () => {
    const { releaseChangelog } = await load();
    const before =
      `## [Unreleased]\n\n### Fixed\n\n- b\n\n## [1.0.0-alpha.1] - 2026-11-03\n\n- a\n\n` +
      `[Unreleased]: ${URL}/compare/v1.0.0-alpha.1...HEAD\n[1.0.0-alpha.1]: ${URL}/releases/tag/v1.0.0-alpha.1\n`;
    const after = releaseChangelog(before, '1.0.0-alpha.2', '2026-11-10');
    expect(after).toContain('## [Unreleased]\n\n## [1.0.0-alpha.2] - 2026-11-10\n\n### Fixed\n\n- b\n\n## [1.0.0-alpha.1] - 2026-11-03');
    expect(after).toContain(`[Unreleased]: ${URL}/compare/v1.0.0-alpha.2...HEAD\n[1.0.0-alpha.2]: ${URL}/compare/v1.0.0-alpha.1...v1.0.0-alpha.2\n[1.0.0-alpha.1]: ${URL}/releases/tag/v1.0.0-alpha.1`);
  });

  it('refuses an empty [Unreleased], a version already released, and a malformed version', async () => {
    const { releaseChangelog } = await load();
    expect(() => releaseChangelog(`## [Unreleased]\n\n## [1.0.0-alpha.1] - 2026-11-03\n\n- a\n`, '1.0.0-alpha.2', '2026-11-10')).toThrow('is empty');
    expect(() => releaseChangelog(`## [Unreleased]\n\n- b\n\n## [1.0.0-alpha.1] - x\n`, '1.0.0-alpha.1', 'd')).toThrow('already has');
    expect(() => releaseChangelog('## [Unreleased]\n\n- b\n', 'v1.0.0', 'd')).toThrow('not a version');
  });

  it('turns the real CHANGELOG as it was before v1.0.0-alpha.1 into what that release committed', async () => {
    const { releaseChangelog } = await load();
    const { execFileSync } = await import('node:child_process');
    const git = (ref: string) => execFileSync('git', ['show', `${ref}:CHANGELOG.md`], { cwd: ROOT, encoding: 'utf8' });
    let before: string;
    let after: string;
    try {
      before = git('7c0993a^'); // main just before chore(release): v1.0.0-alpha.1 (#31)
      after = git('7c0993a');
    } catch {
      return; // a shallow clone without that history
    }
    const out = releaseChangelog(before, '1.0.0-alpha.1', '2026-11-03');
    // The release also reworded the "First release" note by hand; everything else is the script's.
    const norm = (s: string) => s.replace(/> \*\*First release[^\n]*\n/, '');
    expect(norm(out)).toBe(norm(after));
  });
});
