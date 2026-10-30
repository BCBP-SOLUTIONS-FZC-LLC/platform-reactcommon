// Loading remotes through Webpack 5 Module Federation (design doc §C1 /mfe, §C3): the kill switch,
// a per-attempt timeout, retries, share-scope negotiation, metrics and spans.
import { tryGetConfig } from '../config/index.ts';
import { isRemoteKilled } from '../flags/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { getLogger } from '../logging/index.ts';
import { getTracer } from '../tracing/index.ts';
import { currentManifest, isAllowedEntry } from './manifest.ts';

/** The remote is switched off (runtime config kill switch or flag remote.<name>.disabled). */
export class RemoteDisabledError extends Error {
  override readonly name = 'RemoteDisabledError';
  constructor(readonly remote: string) {
    super(`remote "${remote}" is disabled`);
  }
}

/** The remote could not be loaded: not in the manifest, the entry failed, or its module failed. */
export class RemoteLoadError extends Error {
  override readonly name = 'RemoteLoadError';
  constructor(
    readonly remote: string,
    message: string,
    override readonly cause: unknown,
  ) {
    super(`remote "${remote}": ${message}`, { cause });
  }
}

/** A Module Federation container (what a remoteEntry.js defines). */
interface Container {
  init(shareScope: unknown): Promise<void> | void;
  get(module: string): Promise<() => unknown>;
}

type Reason = 'disabled' | 'timeout' | 'network' | 'aborted' | 'incompatible';

class AttemptError extends Error {
  constructor(
    readonly reason: Reason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The global a remote's container is exposed as: its name with '-' as '_' (webpack-preset uses the same rule). */
export function containerGlobal(name: string): string {
  return name.replace(/-/g, '_');
}

/** Adds the entry <script> and resolves when it has run. Test seam: replaced in unit tests. */
let injectScript = (url: string, integrity: string | undefined, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const doc = globalThis.document;
    if (!doc) return reject(new AttemptError('network', 'no document to load the remote entry into'));
    const script = doc.createElement('script');
    const policy = getRuntime().trustedTypesPolicy as { createScriptURL(u: string): unknown } | undefined;
    // Under require-trusted-types-for 'script', src needs a TrustedScriptURL ('platform-sdk' policy).
    (script as unknown as { src: unknown }).src = policy ? policy.createScriptURL(url) : url;
    script.async = true;
    if (integrity) {
      script.integrity = integrity;
      script.crossOrigin = 'anonymous';
    }
    const done = (err?: AttemptError) => {
      clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
      if (err) {
        script.remove();
        reject(err);
      } else resolve();
    };
    const timer = setTimeout(() => done(new AttemptError('timeout', `entry did not load within ${timeoutMs} ms`)), timeoutMs);
    script.onload = () => done();
    script.onerror = () => done(new AttemptError('network', `entry ${url} failed to load`));
    doc.head.appendChild(script);
  });

export function setMfeInternalsForTests(o: { injectScript?: typeof injectScript }): void {
  if (o.injectScript) injectScript = o.injectScript;
}

// Webpack defines these in the shell build (it replaces the free identifiers when it bundles the
// SDK); outside webpack they are absent and remotes cannot share modules.
declare const __webpack_init_sharing__: ((scope: string) => Promise<void>) | undefined;
declare const __webpack_share_scopes__: { default?: unknown } | undefined;

async function shareScope(): Promise<unknown> {
  if (typeof __webpack_init_sharing__ === 'function') await __webpack_init_sharing__('default');
  return typeof __webpack_share_scopes__ !== 'undefined' ? (__webpack_share_scopes__?.default ?? {}) : {};
}

/** One container per remote per page: loaded and initialised once, shared by every loadRemote. */
const containers = new Map<string, Promise<Container>>();

async function loadContainer(name: string, timeoutMs: number): Promise<Container> {
  const entry = currentManifest()?.[name];
  if (!entry) throw new AttemptError('network', 'not in the remote manifest');
  // Checked again right before the <script> is created, whatever the manifest said.
  if (!isAllowedEntry(entry.entry)) throw new AttemptError('network', `entry ${entry.entry} is not an allowed origin`);
  const global = containerGlobal(name);
  let container = (globalThis as Record<string, unknown>)[global] as Container | undefined;
  if (!container) {
    await injectScript(entry.entry, entry.integrity, timeoutMs);
    container = (globalThis as Record<string, unknown>)[global] as Container | undefined;
  }
  if (!container || typeof container.get !== 'function' || typeof container.init !== 'function') {
    throw new AttemptError('incompatible', `entry did not define the container global "${global}"`);
  }
  try {
    await container.init(await shareScope());
  } catch (e) {
    // Initialising twice throws in some webpack versions; a strictVersion clash also lands here.
    if (!/already been initialized/i.test(String((e as Error)?.message))) {
      throw new AttemptError('incompatible', 'share scope negotiation failed (strictVersion?)', { cause: e });
    }
  }
  return container;
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new AttemptError('aborted', 'aborted'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new AttemptError('aborted', 'aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads `module` (e.g. './EditTender') from remote `name`. Refused with RemoteDisabledError by the
 * kill switch; otherwise the entry is loaded (timeout per attempt, `retries` more attempts with
 * backoff; defaults from the runtime config), the share scope initialised, and the module's
 * factory called. Any failure is a RemoteLoadError. Every call records platform_web_remote_load_*
 * through the instrument port.
 */
export async function loadRemote<T = unknown>(
  name: string,
  module: `./${string}`,
  o?: { timeoutMs?: number; retries?: number; signal?: AbortSignal },
): Promise<T> {
  const started = performance.now();
  const span = getTracer('@platform/frontend-sdk/mfe').startSpan('remote load', { mfe: name, module });
  const record = (outcome: 'success' | 'failure' | 'error', reason?: Reason) => {
    try {
      getRuntime().instruments.remoteLoad((performance.now() - started) / 1000, { mfe: name, outcome, ...(reason ? { reason } : {}) });
    } catch {
      // metrics never break a load
    }
  };
  try {
    if (isRemoteKilled(name)) {
      record('failure', 'disabled');
      throw new RemoteDisabledError(name);
    }
    const cfg = tryGetConfig()?.remotes;
    const timeoutMs = o?.timeoutMs ?? cfg?.loadTimeoutMs ?? 10_000;
    const retries = Math.max(0, o?.retries ?? cfg?.retries ?? 2);
    let lastError: AttemptError | undefined;
    for (let n = 0; n <= retries; n++) {
      try {
        // Checked before loadContainer, so an aborted caller never injects the entry script.
        if (o?.signal?.aborted) throw new AttemptError('aborted', 'aborted');
        let pending = containers.get(name);
        if (!pending) {
          pending = loadContainer(name, timeoutMs);
          containers.set(name, pending);
          pending.catch(() => containers.delete(name)); // a failed load may be retried
        }
        const container = await abortable(pending, o?.signal);
        let factory: () => unknown;
        try {
          factory = await abortable(Promise.resolve(container.get(module)), o?.signal);
        } catch (e) {
          if (e instanceof AttemptError) throw e;
          throw new AttemptError('incompatible', `module ${module} is not exposed or failed to load`, { cause: e });
        }
        let value: T;
        try {
          value = factory() as T;
        } catch (e) {
          throw new AttemptError('incompatible', `module ${module} failed to evaluate`, { cause: e });
        }
        record('success');
        return value;
      } catch (e) {
        lastError = e instanceof AttemptError ? e : new AttemptError('network', String(e), { cause: e });
        if (lastError.reason === 'aborted' || lastError.reason === 'incompatible' || n === retries) break;
        await sleep(Math.min(5_000, 250 * 2 ** n) * Math.random());
      }
    }
    record('error', lastError!.reason);
    const err = new RemoteLoadError(name, lastError!.message, lastError!.cause ?? lastError);
    span.recordError(err);
    if (lastError!.reason !== 'aborted') getLogger({ mfe: name }).error('remote failed to load', { error: err, reason: lastError!.reason });
    throw err;
  } finally {
    span.end();
  }
}

/** Test only: forget loaded containers. */
export function resetContainersForTests(): void {
  containers.clear();
}
