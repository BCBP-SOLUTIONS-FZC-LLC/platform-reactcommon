// Loading and holding the runtime config (design doc §C1 /config, §C2 step 3). The config lives
// on the PlatformRuntime, so every copy of the SDK on the page sees the one the shell set.
import { NotInitializedError, getIdentity } from '../core/index.ts';
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
 * http origins on a local host (a dev setup) are accepted only when the page identity's
 * environment is local or dev; anywhere else (or before initializeCore) a leftover dev entry
 * would weaken a deployed config, so it is an issue.
 */
function environmentIssues(c: RuntimeConfig): { path: string; message: string }[] {
  const env = getIdentity()?.environment;
  if (env === 'local' || env === 'dev') return [];
  const origins: [string, string][] = [
    ['auth.idpOrigin', c.auth.idpOrigin],
    ...c.api.propagationAllowlist.map((o, i): [string, string] => [`api.propagationAllowlist.${i}`, o]),
    ...c.remotes.allowedOrigins.map((o, i): [string, string] => [`remotes.allowedOrigins.${i}`, o]),
  ];
  return origins
    .filter(([, o]) => isLocalHttpOrigin(o))
    .map(([path, o]) => ({
      path,
      message: `http origins are allowed only in the local and dev environments (page environment: ${env ?? 'unknown, initializeCore not called'}), got ${JSON.stringify(o)}`,
    }));
}

/** Validates `raw` against the schema and the page's environment; issues name every offending key path. */
function parseConfig(raw: unknown, source: string): RuntimeConfig {
  const result = RuntimeConfigSchema.safeParse(raw);
  const issues = result.success
    ? environmentIssues(result.data)
    : result.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message }));
  if (result.success && issues.length === 0) return result.data;
  throw new RuntimeConfigError(
    `${source} is invalid: ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    issues,
  );
}

/**
 * Shell only: fetches and validates the runtime config (no HTTP cache: `cache: 'no-cache'`
 * revalidates with the ETag). Any failure (network, HTTP status, JSON, schema) is a
 * RuntimeConfigError; the shell shows its static "unavailable" page. As for setRuntimeConfig, an
 * http origin on a local host is an error unless initializeCore set the local or dev environment.
 */
export async function loadRuntimeConfig(opts?: { url?: string; signal?: AbortSignal }): Promise<RuntimeConfig> {
  const url = opts?.url ?? DEFAULT_URL;
  if (!/^\/(?!\/)[^\s\\]*$/.test(url)) {
    throw new RuntimeConfigError(`the runtime config URL must be a same-origin path, got ${JSON.stringify(url)}`);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      cache: 'no-cache',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
  } catch (cause) {
    if (opts?.signal?.aborted) throw cause; // the caller's abort is not a config error
    throw new RuntimeConfigError(`${url} could not be loaded`, [], { cause });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new RuntimeConfigError(`${url} answered HTTP ${res.status}`);
  }
  let raw: unknown;
  try {
    raw = await res.json();
  } catch (cause) {
    throw new RuntimeConfigError(`${url} is not valid JSON`, [], { cause });
  }
  return parseConfig(raw, url);
}

/**
 * Shell only: makes `c` the page's config, validated and deep-frozen. Call initializeCore first:
 * http origins on a local host are accepted only when the page environment is local or dev. Set once: setting an equal
 * config again is a no-op, a different one throws.
 */
export function setRuntimeConfig(c: RuntimeConfig): void {
  const parsed = deepFreeze(parseConfig(c, 'runtime config'));
  const rt = getRuntime();
  if (rt.config !== undefined) {
    if (JSON.stringify(rt.config) === JSON.stringify(parsed)) return;
    throw new Error('@platform/frontend-sdk: the runtime config is already set; it is set once, by the shell.');
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
