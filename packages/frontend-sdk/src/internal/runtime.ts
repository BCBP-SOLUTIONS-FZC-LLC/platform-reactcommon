// The PlatformRuntime: the one place SDK modules share state (design doc §C1 "Dependency rules").
// It lives on globalThis under a registered symbol, so every copy of the SDK on a page finds the
// same object. A second copy (a remote that bundled the SDK instead of sharing it through Module
// Federation) is detected: it logs one error and binds to the existing runtime when the major
// version matches, so the page still has one identity, one session and one consent state.
import { NOOP_INSTRUMENTS, type PlatformInstruments } from './instruments.ts';

/** Identity as /core validated it. Plain strings here: /core owns the branded types. */
export interface RuntimeIdentity {
  readonly serviceName: string;
  readonly domain: string;
  readonly environment: string;
  readonly buildVersion: string;
}

/** Consent as the runtime stores it; /core's ConsentProvider is assignable to it. */
export interface RuntimeConsent {
  has(category: string): boolean;
  subscribe(listener: () => void): () => void;
}

export interface PlatformRuntime {
  /** Version of the SDK copy that created the runtime. */
  readonly sdkVersion: string;
  /** Opaque marker of the module copy that created the runtime (duplicate-copy detection). */
  readonly owner: object;
  identity: RuntimeIdentity | undefined;
  consent: RuntimeConsent;
  instruments: PlatformInstruments;
  /** Session id used when localStorage is unavailable (private mode, blocked storage). */
  memorySessionId: string | undefined;
  /** The deep-frozen runtime config, set once by the shell (/config owns its type). */
  config: unknown;
  /** Tracing state once initializeTracing has run (/tracing owns its type). */
  tracing: unknown;
}

export const RUNTIME_KEY = Symbol.for('@platform/frontend-sdk');

/** Grants essential only: the default until the shell installs its consent provider. */
export const ESSENTIAL_ONLY_CONSENT: RuntimeConsent = {
  has: (category) => category === 'essential',
  subscribe: () => () => {},
};

const OWNER: object = Object.freeze({ sdkVersion: __SDK_VERSION__ });
let bound: PlatformRuntime | undefined;

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

function createRuntime(): PlatformRuntime {
  return {
    sdkVersion: __SDK_VERSION__,
    owner: OWNER,
    identity: undefined,
    consent: ESSENTIAL_ONLY_CONSENT,
    instruments: NOOP_INSTRUMENTS,
    memorySessionId: undefined,
    config: undefined,
    tracing: undefined,
  };
}

/** The page's runtime, created on first use. */
export function getRuntime(): PlatformRuntime {
  if (bound) return bound;
  const slot = globalThis as { [RUNTIME_KEY]?: PlatformRuntime };
  const existing = slot[RUNTIME_KEY];
  if (!existing) {
    bound = createRuntime();
    slot[RUNTIME_KEY] = bound;
    return bound;
  }
  if (existing.owner !== OWNER) {
    const shared = majorOf(existing.sdkVersion) === majorOf(__SDK_VERSION__);
    console.error(
      `@platform/frontend-sdk: a second copy (${__SDK_VERSION__}) was loaded next to ${existing.sdkVersion}. ` +
        'Remotes must take the SDK from the shell through Module Federation (import: false), never bundle it. ' +
        (shared
          ? 'This copy uses the existing runtime.'
          : 'Major versions differ, so this copy keeps its own runtime: its identity, session and consent are not shared.'),
    );
    bound = shared ? existing : createRuntime();
    return bound;
  }
  bound = existing;
  return bound;
}

/** Test only: forget the runtime, as if the page had just loaded. */
export function resetRuntimeForTests(): void {
  bound = undefined;
  delete (globalThis as { [RUNTIME_KEY]?: PlatformRuntime })[RUNTIME_KEY];
}
