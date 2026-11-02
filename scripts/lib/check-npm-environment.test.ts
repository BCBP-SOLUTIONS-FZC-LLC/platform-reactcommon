// .github/scripts/check-npm-environment.sh, run as release.yml runs it, against a fake `gh` that answers
// each API path from fixtures: either gate passes (required reviewers, or release tags only plus a tag
// ruleset), and every way of having neither refuses to publish.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', '.github', 'scripts', 'check-npm-environment.sh');
const REPO = 'acme/sdk';

type Api = Record<string, unknown>;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Runs the script with a fake gh answering `api` (path → JSON body; a missing path is a 404). */
function run(api: Api): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'npm-env-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'api.json'), JSON.stringify(api));
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const api = require(${JSON.stringify(join(dir, 'api.json'))});
const [cmd, path] = process.argv.slice(2);
if (cmd !== 'api' || !(path in api)) { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(api[path]));
`,
  );
  chmodSync(gh, 0o755);
  try {
    const out = execFileSync('bash', [SCRIPT], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REPO, GITHUB_REPOSITORY: '' }, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: err.stdout + err.stderr };
  }
}

const ENV = `repos/${REPO}/environments/npm`;
const POLICIES = `${ENV}/deployment-branch-policies`;
const RULESETS = `repos/${REPO}/rulesets?targets=tag&includes_parents=true`;
type Bypass = { actor_type: string; actor_id: number | null; bypass_mode: string };
const ruleset = (o: { id?: number; enforcement?: string; include?: string[]; exclude?: string[]; rules?: string[]; bypass?: Bypass[] } = {}) => ({
  id: o.id ?? 7,
  name: 'release tags',
  target: 'tag',
  enforcement: o.enforcement ?? 'active',
  conditions: { ref_name: { include: o.include ?? ['refs/tags/v*'], exclude: o.exclude ?? [] } },
  rules: (o.rules ?? ['creation', 'update', 'deletion']).map((type) => ({ type })),
  // GitHub returns bypass_actors only to admins; release.yml's token sees the ruleset without it.
  ...(o.bypass ? { bypass_actors: o.bypass } : {}),
});
const ADMIN: Bypass = { actor_type: 'RepositoryRole', actor_id: 5, bypass_mode: 'always' };
/** The tag gate: the environment limited to release tags, and one ruleset. */
const tagGate = (rs = ruleset(), policies = [{ id: 1, name: 'v*.*.*', type: 'tag' }]): Api => ({
  [ENV]: { name: 'npm', protection_rules: [{ type: 'branch_policy' }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
  [POLICIES]: { total_count: policies.length, branch_policies: policies },
  [RULESETS]: [{ id: rs.id, name: rs.name, target: rs.target, enforcement: rs.enforcement }],
  [`repos/${REPO}/rulesets/${rs.id}`]: rs,
});

describe('check-npm-environment.sh', () => {
  it('passes with required reviewers', () => {
    const r = run({ [ENV]: { protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'a' } }] }] } });
    expect(r).toMatchObject({ code: 0 });
    expect(r.out).toContain("environment 'npm' requires approval (1 reviewer(s))");
  });

  it('passes with release tags only and an active ruleset over creating, moving and deleting them; warns that the bypass list is not visible', () => {
    const r = run(tagGate());
    expect(r.code).toBe(0);
    expect(r.out).toContain("ruleset 'release tags' (7) restricts who may create, move or delete them");
    expect(r.out).toContain("::warning title=npm environment::ruleset 'release tags' (7) protects release tags, but this token cannot see its bypass list");
  });

  it('as an admin (the bypass list visible): passes when only admins and named teams bypass', () => {
    const r = run(tagGate(ruleset({ bypass: [ADMIN, { actor_type: 'OrganizationAdmin', actor_id: null, bypass_mode: 'always' }, { actor_type: 'Team', actor_id: 42, bypass_mode: 'always' }] })));
    expect(r.code).toBe(0);
    expect(r.out).toContain("lets only admins and named teams create, move or delete them");
    expect(r.out).not.toContain('::warning');
    expect(run(tagGate(ruleset({ bypass: [] }))).code).toBe(0); // nobody bypasses: tags are pushed by no one, safe
  });

  it('as an admin: refuses a bypass list that lets a write or maintain role, an app or a deploy key push release tags', () => {
    for (const loose of [
      { actor_type: 'RepositoryRole', actor_id: 4, bypass_mode: 'always' }, // write
      { actor_type: 'RepositoryRole', actor_id: 2, bypass_mode: 'always' }, // maintain
      { actor_type: 'Integration', actor_id: 99, bypass_mode: 'always' },
      { actor_type: 'DeployKey', actor_id: null, bypass_mode: 'always' },
    ]) {
      const r = run(tagGate(ruleset({ bypass: [ADMIN, loose] })));
      expect(r.code, loose.actor_type).toBe(1);
      expect(r.out, loose.actor_type).toContain(`lets more than admins and named teams push release tags (bypass: ${loose.actor_type} ${loose.actor_id ?? ''})`);
    }
  }, 30_000);

  it('accepts a ruleset over every ref (~ALL) or an exact release pattern', () => {
    expect(run(tagGate(ruleset({ include: ['~ALL'] }))).code).toBe(0);
    expect(run(tagGate(ruleset({ include: ['refs/tags/v*.*.*'] }))).code).toBe(0);
  });

  it('refuses a missing environment', () => {
    const r = run({});
    expect(r.code).toBe(1);
    expect(r.out).toContain("cannot read environment 'npm' of acme/sdk");
  });

  it('refuses an environment with neither gate (what a job creates on the spot)', () => {
    const r = run({ [ENV]: { protection_rules: [], deployment_branch_policy: null } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('accepts any branch or tag: refusing to publish without a gate');
  });

  it('refuses deployment policies that admit a branch or a non-release tag', () => {
    const branch = run(tagGate(undefined, [{ id: 1, name: 'v*.*.*', type: 'tag' }, { id: 2, name: 'main', type: 'branch' }]));
    expect(branch.code).toBe(1);
    expect(branch.out).toContain('must accept only release tags (type tag, v…); it has: branch main');
    expect(run(tagGate(undefined, [{ id: 1, name: '*', type: 'tag' }])).code).toBe(1);
    expect(run(tagGate(undefined, [])).code).toBe(1);
  });

  it('refuses release tags without a ruleset that protects them', () => {
    const none = tagGate();
    none[RULESETS] = [];
    const cases: [string, Api][] = [
      ['no ruleset', none],
      ['evaluate mode only', tagGate(ruleset({ enforcement: 'evaluate' }))],
      ['disabled', tagGate(ruleset({ enforcement: 'disabled' }))],
      ['other tags', tagGate(ruleset({ include: ['refs/tags/release-*'] }))],
      ['release tags excluded', tagGate(ruleset({ include: ['~ALL'], exclude: ['refs/tags/v*'] }))],
      ['creation not restricted', tagGate(ruleset({ rules: ['update', 'deletion'] }))],
      ['tags can be moved', tagGate(ruleset({ rules: ['creation', 'deletion'] }))],
    ];
    for (const [what, api] of cases) {
      const r = run(api);
      expect(r.code, what).toBe(1);
      expect(r.out, what).toContain('no active tag ruleset covering refs/tags/v1.0.0 restricts creating, moving and deleting them');
    }
  }, 30_000); // a node process per fake gh call
});
