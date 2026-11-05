// Loading and holding the runtime config (design doc §C1 /config, §C2 step 3). The config lives
// on the PlatformRuntime, so every copy of the SDK on the page sees the one the shell set.
import { NotInitializedError, getIdentity } from '../core/index.ts';
import { isLocalEnvironment } from '../internal/environments.ts';
import { getRuntime } from '../internal/runtime.ts';
import { RuntimeConfigSchema, isLocalHttpOrigin, type RuntimeConfig } from './schema.ts';

/** /config/runtime.json could not be loaded or does not match the schema. */
export class RuntimeConfigError extends Error {
  override readonly name = 'RuntimeConfigError';
  constructor(
    message: string,
    /** Each problem found: `path` is the dotted key path ('' for the whole document). */
    readonly issues: readonly { path: string; message: string }[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const DEFAULT_URL = '/config/runtime.json';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/**
 * http origins on a local host (a dev setup) are accepted only when the page's environment is
 * local, dev or test (CI and integration runs against local servers); anywhere else a leftover dev
 * entry would weaken a deployed config, so it is an issue. The page's environment is the identity's
 * (initializeCore), else, for loadRuntimeConfig only, the file's own `environment`; with neither, it
 * is unknown and refused.
 * A config whose `environment` differs from the identity's is an issue.
 */

function environmentIssues(c: RuntimeConfig, trustOwnEnvironment: boolean): { path: string; message: string }[] {
  const pageEnv = getIdentity()?.environment;
  if (pageEnv !== undefined && c.environment !== undefined && c.environment !== pageEnv) {
    return [{ path: 'environment', message: `must equal the page identity's environment ${JSON.stringify(pageEnv)}, got ${JSON.stringify(c.environment)}` }];
  }
  // Before initializeCore, loadRuntimeConfig (which stores nothing) uses the file's own environment: a
  // host page built once loads the config first. setRuntimeConfig does not: it stores the config, and
  // a config set before the identity must not vouch for itself.
  const env = pageEnv ?? (trustOwnEnvironment ? c.environment : undefined);
  if (isLocalEnvironment(env)) return [];
  const origins: [string, string][] = [
    ['auth.idpOrigin', c.auth.idpOrigin],
    ...(c.auth.signInUrl === undefined ? [] : [['auth.signInUrl', c.auth.signInUrl] as [string, string]]),
    ...c.api.propagationAllowlist.map((o, i): [string, string] => [`api.propagationAllowlist.${i}`, o]),
    ...c.remotes.allowedOrigins.map((o, i): [string, string] => [`remotes.allowedOrigins.${i}`, o]),
  ];
  return origins
    .filter(([, o]) => isLocalHttpOrigin(o))
    .map(([path, o]) => ({
      path,
      message: `http origins are allowed only in the local, dev and test environments (page environment: ${env ?? 'unknown: initializeCore not called and no environment in the config'}), got ${JSON.stringify(o)}`,
    }));
}

/** The fields of a zod issue the messages below read. */
interface Issue {
  code: string;
  message: string;
  path: PropertyKey[];
  keys?: string[];
  expected?: string;
  minimum?: number | bigint;
  maximum?: number | bigint;
  inclusive?: boolean;
  origin?: string;
  values?: unknown[];
}

/**
 * zod/mini ships no default messages (every built-in issue says "Invalid input"), so the built-in
 * ones are worded here from the issue's own fields. Messages the schema sets itself are kept.
 */
export function describeIssue(i: Issue): string {
  if (i.message !== 'Invalid input') return i.message;
  const count = (n: number | bigint | undefined, what: string) => `${n} ${what}${Number(n) === 1 ? '' : 's'}`;
  switch (i.code) {
    case 'unrecognized_keys':
      return `unknown key${(i.keys?.length ?? 0) === 1 ? '' : 's'} ${(i.keys ?? []).map((k) => JSON.stringify(k)).join(', ')}`;
    case 'invalid_type':
      return `expected ${i.expected === 'int' ? 'an integer' : `a ${i.expected}`}`;
    case 'too_small':
      if (i.origin === 'array') return `must have at least ${count(i.minimum, 'item')}`;
      if (i.origin === 'string') return `must have at least ${count(i.minimum, 'character')}`;
      return `must be ${i.inclusive === false ? '>' : '≥'} ${i.minimum}`;
    case 'too_big':
      if (i.origin === 'array') return `must have at most ${count(i.maximum, 'item')}`;
      if (i.origin === 'string') return `must have at most ${count(i.maximum, 'character')}`;
      return `must be ${i.inclusive === false ? '<' : '≤'} ${i.maximum}`;
    case 'invalid_value':
      return `must be one of ${(i.values ?? []).map((v) => JSON.stringify(v)).join(', ')}`;
    case 'invalid_union':
      return 'must be a boolean, a string or a finite number';
    default:
      return i.message;
  }
}

/** Validates `raw` against the schema and the page's environment; issues name every offending key path. */
function parseConfig(raw: unknown, source: string, trustOwnEnvironment = false): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(raw);
  const issues = result.success
    ? environmentIssues(result.data, trustOwnEnvironment)
    : result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: describeIssue(i as Issue) }));
  if (result.success && issues.length === 0) return result.data;
  throw new RuntimeConfigError(
    `${source} is invalid: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    issues,
  );
}

/** loadRuntimeConfig's default bound on the request and its body. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Host page only (the shell, or a remote's own standalone page when no shell is present): fetches and validates the runtime config (no HTTP cache: `cache: 'no-cache'`
 * revalidates with the ETag), within `timeoutMs` (default 10 s). Any failure (network, timeout, HTTP status, JSON, schema) is a
 * RuntimeConfigError; the shell shows its static "unavailable" page. As for setRuntimeConfig, an
 * http origin on a local host is an error unless the page's environment (initializeCore's, else the
 * file's `environment`) is local, dev or test. A host page built once for every environment calls it
 * before initializeCore and passes the file's `environment` to it.
 * A `timeoutMs` outside 1 to 2147483647 is a programming error: a RangeError, before any request.
 */
export async function loadRuntimeConfig(opts?: { url?: string; signal?: AbortSignal; timeoutMs?: number }): Promise<RuntimeConfig> {
  const url = opts?.url ?? DEFAULT_URL;
  if (!/^\/(?!\/)[^\s\\]*$/.test(url)) {
    throw new RuntimeConfigError(`the runtime config URL must be a same-origin path, got ${JSON.stringify(url)}`);
  }
  // Bounded: a stalled CDN or origin would otherwise leave a blank page instead of the "unavailable" one.
  // Own timer plus the caller's signal (AbortSignal.any is missing in older Safari).
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // setTimeout takes NaN, Infinity or anything over 2^31-1 ms as about 1 ms.
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new RangeError(`timeoutMs must be an integer from 1 to 2147483647, got ${String(timeoutMs)}`);
  }
  const timeoutMessage = `${url} did not answer within ${timeoutMs} ms`;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort(opts?.signal?.reason);
  if (opts?.signal?.aborted) onAbort();
  else opts?.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', cache: 'no-cache', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal });
    } catch (cause) {
      if (opts?.signal?.aborted) throw cause; // the caller's abort is not a config error
      throw new RuntimeConfigError(timedOut ? timeoutMessage : `${url} could not be loaded`, [], { cause });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new RuntimeConfigError(`${url} answered HTTP ${res.status}`);
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (cause) {
      if (opts?.signal?.aborted) throw cause;
      throw new RuntimeConfigError(timedOut ? timeoutMessage : `${url} is not valid JSON`, [], { cause });
    }
    return parseConfig(raw, url, true);
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Host page only (the shell, or a remote's own standalone page when no shell is present): makes
 * `c` the page's config, validated and deep-frozen. Call initializeCore first: the config's
 * `environment`, when set, must equal the identity's, and http origins on a local host are accepted
 * only when the page environment is local, dev or test. Set once: setting an equal config again is
 * a no-op, a different one throws.
 */
export function setRuntimeConfig(c: RuntimeConfig): void {
  const parsed = deepFreeze(parseConfig(c, 'runtime config'));
  const rt = getRuntime();
  if (rt.config !== undefined) {
    if (JSON.stringify(rt.config) === JSON.stringify(parsed)) return;
    throw new Error('@bcbp-solutions-fzc-llc/frontend-sdk: the runtime config is already set; it is set once, by the shell.');
  }
  rt.config = parsed;
}

/** The page's config. Throws NotInitializedError before the shell has set it: remotes use tryGetConfig. */
export function getConfig(): RuntimeConfig {
  const c = tryGetConfig();
  if (!c) throw new NotInitializedError('the runtime config is not set yet (shell bootstrap step 3); use tryGetConfig() outside the shell');
  return c;
}

/** The page's config, or undefined before the shell has set it (e.g. a remote run standalone). */
export function tryGetConfig(): RuntimeConfig | undefined {
  return getRuntime().config as RuntimeConfig | undefined;
}
