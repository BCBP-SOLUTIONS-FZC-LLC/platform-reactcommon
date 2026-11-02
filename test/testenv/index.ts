// Test environment for the suites under test/ (platform-gincommon's test/testenv): loads `.env` from
// the repository root, then sets the defaults the suites rely on, without overriding a value already
// in the process environment. Vitest runs it first (setupFiles), so every suite sees the same values.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The page identity the suites boot the SDK with, unless .env or the caller sets them. */
export const DEFAULT_DOMAIN = 'portal';
export const DEFAULT_ENVIRONMENT = 'test';

const ROOT = join(import.meta.dirname, '..', '..');

/** KEY=value lines; `#` comments and blank lines skipped; one pair of surrounding quotes removed. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function setDefault(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}

const dotenv = join(ROOT, '.env');
if (existsSync(dotenv)) for (const [k, v] of Object.entries(parseDotenv(readFileSync(dotenv, 'utf8')))) setDefault(k, v);
setDefault('OBSERVABILITY_DOMAIN', DEFAULT_DOMAIN);
setDefault('ENVIRONMENT', DEFAULT_ENVIRONMENT);

/**
 * The values the suites read. `smokeBaseUrl` is set only to run test/smoke against a deployed shell
 * (SMOKE_BASE_URL, e.g. https://app.dev.bcbpsolutions.com); otherwise smoke runs in-process.
 */
export const testenv = {
  domain: process.env.OBSERVABILITY_DOMAIN!,
  environment: process.env.ENVIRONMENT!,
  smokeBaseUrl: process.env.SMOKE_BASE_URL || undefined,
  root: ROOT,
};
