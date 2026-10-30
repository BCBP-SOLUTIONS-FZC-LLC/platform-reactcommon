// Regenerates packages/frontend-sdk/contracts/ from the backend sources (design doc §C5 "How drift
// is caught", item 1). Never hand-edit those files.
//
//   pnpm contracts:sync                 write the files
//   pnpm contracts:check                fail if any file is stale (CI)
//   pnpm contracts:sync --update-pins   also move the pins in contracts/sources.json to each checkout's HEAD
//
// Sources are sibling checkouts under PLATFORM_ROOT (default: the workspace root, two levels above
// this repo), at the commits pinned in contracts/sources.json. A checkout at another commit fails
// the run, so a contracts change is always a reviewed pin bump. Needs `go` on PATH for go-probe.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  buildHeaders,
  buildLogFields,
  buildMetricRegistry,
  buildProblemTypes,
  buildRedaction,
  buildRegistryVocab,
  buildTsConstants,
  diffRegistries,
  toJsonText,
  type ContractsExport,
  type Registry,
} from './lib/contracts.ts';
import { REPO_ROOT, SDK_DIR } from './lib/subpaths.ts';

const CONTRACTS_DIR = join(SDK_DIR, 'contracts');
const SOURCES_FILE = join(CONTRACTS_DIR, 'sources.json');

interface PinnedRepo {
  /** GitHub repository, owner/name. CI checks it out at `sha` into PLATFORM_ROOT/`path`. */
  readonly repo: string;
  /** Checkout location relative to PLATFORM_ROOT. */
  readonly path: string;
  readonly sha: string;
}
interface Sources {
  readonly _comment?: string;
  readonly platform: Record<string, PinnedRepo>;
}

const GO_PROBE_LIBS = ['platform-events', 'platform-gincommon', 'platform-pgcommon'] as const;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function repoDir(root: string, sources: Sources, name: string): string {
  const pin = sources.platform[name];
  if (!pin) throw new Error(`contracts/sources.json has no pin for ${name}`);
  const dir = join(root, pin.path);
  if (!existsSync(join(dir, '.git'))) throw new Error(`${name}: no git checkout at ${dir} (set PLATFORM_ROOT)`);
  return dir;
}

/**
 * Builds go-probe the way platform-interop-tests' run_interop.sh does: a copy whose module paths
 * match each sibling's declared /vN path, with absolute replace targets. Returns its JSON output.
 */
function runContractsExport(root: string, sources: Sources): ContractsExport {
  const probeDir = join(repoDir(root, sources, 'platform-interop-tests'), 'go-probe');
  const work = mkdtempSync(join(tmpdir(), 'sdk-go-probe-'));
  try {
    for (const f of readdirSync(probeDir)) {
      if (f.endsWith('.go') || f === 'go.mod' || f === 'go.sum') copyFileSync(join(probeDir, f), join(work, f));
    }
    let goMod = readFileSync(join(work, 'go.mod'), 'utf8');
    for (const lib of GO_PROBE_LIBS) {
      const dir = repoDir(root, sources, lib);
      const base = `github.com/BCBP-SOLUTIONS-FZC-LLC/${lib}`;
      const actual = /^module\s+(\S+)/m.exec(readFileSync(join(dir, 'go.mod'), 'utf8'))?.[1];
      if (!actual || !(actual === base || new RegExp(`^${base}/v[2-9][0-9]*$`).test(actual))) {
        throw new Error(`${lib}/go.mod declares ${actual ?? 'no module'}, want ${base}[/vN]`);
      }
      if (actual !== base) {
        const major = actual.slice(actual.lastIndexOf('/v') + 2);
        for (const f of readdirSync(work).filter((n) => n.endsWith('.go'))) {
          const p = join(work, f);
          writeFileSync(p, readFileSync(p, 'utf8').replaceAll(`"${base}/`, `"${actual}/`));
        }
        goMod = goMod.replace(new RegExp(`^(\\s+)${base}\\s+v\\S+`, 'm'), `$1${actual} v${major}.0.0`);
      }
      goMod = goMod.replace(new RegExp(`^replace ${base} => \\S+`, 'm'), `replace ${actual} => ${dir}`);
    }
    writeFileSync(join(work, 'go.mod'), goMod);
    const env = { ...process.env, GOFLAGS: '-mod=mod', GOSUMDB: 'off', GOTOOLCHAIN: 'local' };
    execFileSync('go', ['build', '-o', 'go-probe', '.'], { cwd: work, env, stdio: ['ignore', 'ignore', 'inherit'] });
    return JSON.parse(execFileSync(join(work, 'go-probe'), ['contracts-export'], { encoding: 'utf8' })) as ContractsExport;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function generate(root: string, sources: Sources): Map<string, string> {
  const gin = repoDir(root, sources, 'platform-gincommon');
  const fastapi = repoDir(root, sources, 'platform-fastapicommon');
  const interop = repoDir(root, sources, 'platform-interop-tests');
  const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

  const REGISTRY = 'internal/obsregistry/registry.json';
  const registry = JSON.parse(read(gin, REGISTRY)) as Registry;
  const copy = JSON.parse(read(fastapi, 'src/fastapicommon/metrics/registry.json')) as Registry;
  const drift = diffRegistries(registry, copy);
  if (drift.length > 0) {
    console.warn(
      `warning: fastapicommon's registry.json differs from gincommon's (canonical, used here) in: ${drift.join(', ')}`,
    );
  }

  const exp = runContractsExport(root, sources);
  const TRANSPORT = 'internal/core/domain/transport.go';
  const VALIDATION = 'internal/core/domain/validation.go';
  const LOGGING = 'internal/adapter/inbound/http/middleware/logging.go';
  const EXPORT = 'platform-interop-tests go-probe contracts-export (gincommon pkg/problem, pkg/gincommon)';

  const SANITIZER = 'internal/core/service/log_sanitizer.go';
  const vocab = buildRegistryVocab(registry, `platform-gincommon ${REGISTRY}`);
  const headers = buildHeaders(exp, read(gin, TRANSPORT), read(gin, VALIDATION), {
    export: EXPORT,
    transport: `platform-gincommon ${TRANSPORT}`,
    validation: `platform-gincommon ${VALIDATION}`,
  });
  const redaction = buildRedaction(read(gin, SANITIZER), `platform-gincommon ${SANITIZER}`);

  const files = new Map<string, string>();
  files.set('registry-vocab.json', toJsonText(vocab));
  files.set('metric-registry.json', toJsonText(buildMetricRegistry(registry, `platform-gincommon ${REGISTRY}`)));
  files.set('problem-types.json', toJsonText(buildProblemTypes(exp, EXPORT)));
  files.set('headers.json', toJsonText(headers));
  files.set('redaction.json', toJsonText(redaction));
  files.set('log-fields.json', toJsonText(buildLogFields(read(gin, LOGGING), `platform-gincommon ${LOGGING}`)));
  // Shared golden fixtures, copied byte for byte (design doc §C5 drift item 2).
  for (const fixture of ['header_cases.json', 'identity_cases.json', 'redaction_cases.json']) {
    files.set(`fixtures/${fixture}`, read(interop, `fixtures/${fixture}`));
  }
  // The constants the SDK's code imports (src/internal/generated), from the same objects.
  files.set(
    '../src/internal/generated/contracts.ts',
    buildTsConstants(
      { REGISTRY_VOCAB: vocab, HEADERS: headers, REDACTION: redaction },
      ['contracts/registry-vocab.json', 'contracts/headers.json', 'contracts/redaction.json'],
    ),
  );
  return files;
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const check = args.has('--check');
  const updatePins = args.has('--update-pins');
  if (check && updatePins) throw new Error('--check and --update-pins are mutually exclusive');
  const root = resolve(process.env.PLATFORM_ROOT ?? join(REPO_ROOT, '../..'));
  let sources = JSON.parse(readFileSync(SOURCES_FILE, 'utf8')) as Sources;

  // Every checkout must be at its pinned commit (or the pins are moved to HEAD on request).
  const pins = { ...sources.platform };
  const mismatched: string[] = [];
  for (const [name, pin] of Object.entries(sources.platform)) {
    const head = git(repoDir(root, sources, name), 'rev-parse', 'HEAD');
    if (head !== pin.sha) {
      if (updatePins) pins[name] = { ...pin, sha: head };
      else mismatched.push(`${name}: checkout at ${head.slice(0, 12)}, pinned ${pin.sha.slice(0, 12) || '(none)'}`);
    }
  }
  if (mismatched.length > 0) {
    console.error(`Checkouts are not at their pinned commits (contracts/sources.json):\n  ${mismatched.join('\n  ')}`);
    console.error('Check out the pinned commits, or run `pnpm contracts:sync --update-pins` to move the pins.');
    process.exit(1);
  }
  if (updatePins) {
    sources = { ...sources, platform: pins };
    writeFileSync(SOURCES_FILE, toJsonText(sources));
  }

  const files = generate(root, sources);
  const stale: string[] = [];
  for (const [rel, text] of files) {
    const path = join(CONTRACTS_DIR, rel);
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current === text) continue;
    if (check) stale.push(rel);
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      console.log(`updated ${relative(SDK_DIR, path)}`);
    }
  }
  if (stale.length > 0) {
    console.error(`Stale contracts: ${stale.join(', ')}. Run \`pnpm contracts:sync\` and commit the result.`);
    process.exit(1);
  }
}

main();
