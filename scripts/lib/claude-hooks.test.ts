// .claude/hooks: the PreToolUse guards (generated files and sibling repositories are never hand-edited; release
// tags only on a merged, green release commit; tokens never printed or read from .env) and the PostToolUse
// formatter, run as Claude Code runs them: the tool call as JSON on stdin, CLAUDE_PROJECT_DIR set,
// exit 2 = blocked / shown to Claude.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const hook = (name: string) => join(ROOT, '.claude', 'hooks', name);

function run(name: string, filePath: string | undefined, tool = 'Edit', projectDir = ROOT): { code: number; stderr: string } {
  const input = JSON.stringify({ tool_name: tool, tool_input: filePath === undefined ? {} : { file_path: filePath } });
  const r = spawnSync('bash', [hook(name)], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir } });
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

  it('where the sibling directories do not exist (CI): files elsewhere stay editable, sibling paths are still blocked', () => {
    // Regression: the sibling roots were resolved with `cd`; a missing one became "" and its pattern "/*" matched
    // every path outside the project, Claude's memory and scratch files included.
    const project = '/nonexistent/work/react/platform-reactcommon';
    expect(run('guard-generated.sh', '/tmp/scratch/notes.md', 'Edit', project).code).toBe(0);
    expect(run('guard-generated.sh', '/home/someone/.claude/projects/x/memory/m.md', 'Edit', project).code).toBe(0);
    expect(run('guard-generated.sh', '/nonexistent/work/go/platform-gincommon/go.mod', 'Edit', project).code).toBe(2);
    expect(run('guard-generated.sh', '/nonexistent/XPertPMS/IAM/iam-org-membership/go.mod', 'Edit', project).code).toBe(2);
    expect(run('guard-generated.sh', `${project}/packages/frontend-sdk/src/http/client.ts`, 'Edit', project).code).toBe(0);
    // A project near the filesystem root has no workspace above it: nothing outside it is treated as a sibling.
    expect(run('guard-generated.sh', '/tmp/x.md', 'Edit', '/repo').code).toBe(0);
  });

  it('ignores calls without a path', () => {
    expect(run('guard-generated.sh', undefined).code).toBe(0);
  });
});

/** Runs a Bash-matcher hook on `command`, with extra environment (e.g. a fake `gh` first on PATH). */
function runBash(name: string, command: string, projectDir = ROOT, env: Record<string, string> = {}): { code: number; stderr: string } {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const r = spawnSync('bash', [hook(name)], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env } });
  return { code: r.status ?? -1, stderr: r.stderr };
}

describe('guard-secrets.sh', () => {
  it.each([
    ['gh auth token', 'gh auth token prints a token'],
    ['gh auth token | pbcopy', 'gh auth token prints a token'],
    ['pnpm build && gh auth token', 'gh auth token prints a token'],
    ['echo $GO_PRIVATE_TOKEN', 'printing a token variable'],
    ['printf "%s" "${NODE_AUTH_TOKEN}" > token.txt', 'printing a token variable'],
    ['printenv GH_TOKEN', 'printing the environment'],
    ['env | grep PATH', 'printing the environment'],
    ['cat .env', '.env holds local credentials'],
    ['grep -n KEY ./.env', '.env holds local credentials'],
  ])('blocks %s', (command, reason) => {
    const r = runBash('guard-secrets.sh', command);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(reason);
  });

  it.each([
    'GO_PRIVATE_TOKEN="$(gh auth token)" pnpm run stack-up > stack.log 2>&1', // stack-up's own pattern: captured, never shown
    'cat .env.example',
    'echo hello > out.txt',
    'pnpm verify && git status',
    'grep -n NODE_AUTH_TOKEN README.md', // naming a variable is not reading it
    "python3 - <<'EOF'\ndoc = 'refuses `gh auth token` outside a capture, and `printenv` / `env` dumps'\nEOF", // a doc being written (regression: blocked a docs edit)
  ])('allows %s', (command) => {
    expect(runBash('guard-secrets.sh', command)).toEqual({ code: 0, stderr: '' });
  });
});

describe('guard-release-tag.sh', () => {
  let repo: string;
  let bin: string;
  let released: string; // on origin/main, packages at 1.0.0-alpha.6
  let ahead: string; // after origin/main, packages at 1.0.0-alpha.7
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const version = (v: string) => {
    for (const p of ['frontend-sdk', 'webpack-preset', 'eslint-plugin']) {
      mkdirSync(join(repo, 'packages', p), { recursive: true });
      writeFileSync(join(repo, 'packages', p, 'package.json'), JSON.stringify({ version: v }));
    }
    git('add', '-A');
    git('commit', '-q', '-m', v);
    return git('rev-parse', 'HEAD');
  };
  /** The hook in the scratch repository, with a fake gh whose `run list` prints `ci` (or fails). */
  const tag = (command: string, ci: string | null = 'completed success') =>
    runBash('guard-release-tag.sh', command, repo, { PATH: `${bin}:${process.env.PATH}`, FAKE_GH: ci ?? '', FAKE_GH_FAIL: ci === null ? '1' : '' });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));
  // A fresh repository per test: the tags a test creates never leak into the next.
  const setup = () => {
    repo = mkdtempSync(join(tmpdir(), 'release-tag-'));
    bin = join(repo, '.bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\n[ -n "$FAKE_GH_FAIL" ] && { echo "gh: not logged in" >&2; exit 1; }\necho "$FAKE_GH"\n');
    chmodSync(join(bin, 'gh'), 0o755);
    git('init', '-q');
    released = version('1.0.0-alpha.6');
    git('update-ref', 'refs/remotes/origin/main', released);
    ahead = version('1.0.0-alpha.7');
  };

  it('allows a tag on the merged release commit whose CI passed, by sha or at HEAD', () => {
    setup();
    expect(tag(`git tag -a v1.0.0-alpha.6 -m "v1.0.0-alpha.6" ${released}`).code).toBe(0);
    git('checkout', '-q', released);
    expect(tag('git switch main && git tag -a v1.0.0-alpha.6 -m "v1.0.0-alpha.6"').code).toBe(0);
  });

  it('blocks a tag whose version the packages do not have (alpha.4: tagged before the release PR merged)', () => {
    setup();
    const r = tag(`git tag -a v1.0.0-alpha.7 -m "v1.0.0-alpha.7" ${released}`);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('packages/frontend-sdk is 1.0.0-alpha.6, not 1.0.0-alpha.7');
  });

  it('blocks a tag on a commit that is not on origin/main', () => {
    setup();
    const r = tag('git tag -a v1.0.0-alpha.7 -m "v1.0.0-alpha.7"'); // HEAD: the versions match, but unmerged
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not on origin/main');
  });

  it("blocks while main's CI has not passed, and fails closed when gh cannot tell", () => {
    setup();
    const running = tag(`git tag -a v1.0.0-alpha.6 -m v1.0.0-alpha.6 ${released}`, 'in_progress ');
    expect(running.code).toBe(2);
    expect(running.stderr).toContain('has not passed');
    expect(tag(`git tag -a v1.0.0-alpha.6 -m v1.0.0-alpha.6 ${released}`, 'completed failure').code).toBe(2);
    const noGh = tag(`git tag -a v1.0.0-alpha.6 -m v1.0.0-alpha.6 ${released}`, null);
    expect(noGh.code).toBe(2);
    expect(noGh.stderr).toContain('could not check');
  });

  it('checks the commit a pushed tag points to', () => {
    setup();
    git('tag', 'v1.0.0-alpha.6', released);
    git('tag', 'v1.0.0-alpha.7', ahead);
    expect(tag('git push origin v1.0.0-alpha.6 2>&1 | tail -1').code).toBe(0);
    expect(tag('git push origin refs/tags/v1.0.0-alpha.7').code).toBe(2);
  });

  it('refuses pushing every tag; allows branches named after a version, deleting and listing tags', () => {
    setup();
    expect(tag('git push --tags').stderr).toContain('push a release tag by name');
    expect(tag('git push origin main --follow-tags').code).toBe(2);
    for (const ok of [
      'git push -u origin release/v1.0.0-alpha.7',
      'git push origin :refs/tags/v1.0.0-alpha.7',
      'git push origin --delete v1.0.0-alpha.7',
      'git tag -d v1.0.0-alpha.7',
      "git tag -l 'v1*'",
      'git status && pnpm verify',
    ]) {
      expect(tag(ok, null), ok).toEqual({ code: 0, stderr: '' }); // gh is never needed for these
    }
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
