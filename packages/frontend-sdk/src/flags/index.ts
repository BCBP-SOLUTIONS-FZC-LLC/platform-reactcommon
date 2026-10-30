/**
 * Feature flags: platform flags (kill switches, rollout) from the runtime config, and the
 * tenant's plan and feature flags from the session context.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/flags`.
 *
 * @packageDocumentation
 */
import { tryGetConfig } from '../config/index.ts';
import { getRuntime } from '../internal/runtime.ts';

export type FlagValue = boolean | string | number;

/** Answers flag lookups. Flag names are opaque strings (e.g. 'sso_enabled', 'llm.refiner.query'). */
export interface FlagProvider {
  get(key: string): FlagValue | undefined;
  /** Calls `l` whenever a value may have changed; returns an unsubscribe function. */
  subscribe(l: () => void): () => void;
}

const NO_SUBSCRIPTION = () => () => {};

function configFlag(key: string): FlagValue | undefined {
  const flags = tryGetConfig()?.flags;
  return flags && Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : undefined;
}

/** The default provider: the runtime config's `flags`. The config is set once, so it never changes. */
export function runtimeConfigFlagProvider(): FlagProvider {
  return Object.freeze({ get: configFlag, subscribe: NO_SUBSCRIPTION });
}

/**
 * Runtime-config flags, plus the tenant's `featureFlags` (presence means true, as in the gateway's
 * x-feature-flags) and `read_only`. A runtime-config value wins, so a platform kill switch or
 * rollout setting can always turn a tenant feature off. Absent flags are undefined (the caller's
 * fallback applies), never false.
 */
export function sessionContextFlagProvider(ctx: { featureFlags: readonly string[]; readOnly: boolean }): FlagProvider {
  const tenantFlags = new Set(Array.isArray(ctx?.featureFlags) ? ctx.featureFlags.filter((f) => typeof f === 'string') : []);
  const readOnly = ctx?.readOnly === true;
  return Object.freeze({
    get(key: string): FlagValue | undefined {
      const platform = configFlag(key);
      if (platform !== undefined) return platform;
      if (key === 'read_only') return readOnly || tenantFlags.has(key);
      return tenantFlags.has(key) ? true : undefined;
    },
    subscribe: NO_SUBSCRIPTION,
  });
}

/** Shell only: the provider every getFlag call uses (e.g. sessionContextFlagProvider once the context loads). */
export function setFlagProvider(p: FlagProvider): void {
  getRuntime().flagProvider = p ?? undefined;
}

function provider(): FlagProvider {
  return (getRuntime().flagProvider as FlagProvider | undefined) ?? runtimeConfigFlagProvider();
}

/**
 * The flag's value, or `fallback` when it is absent, of a different type than the fallback, or
 * the provider throws. A remote run standalone always gets its fallbacks.
 */
export function getFlag<T extends FlagValue>(key: string, fallback: T): T {
  let v: unknown;
  try {
    v = provider().get(key);
  } catch {
    return fallback;
  }
  return typeof v === typeof fallback && (typeof v !== 'number' || Number.isFinite(v)) ? (v as T) : fallback;
}

/**
 * Whether a remote is switched off: listed in the runtime config's remotes.killSwitch, or flag
 * `remote.<name>.disabled` is true.
 */
export function isRemoteKilled(remote: string): boolean {
  if (tryGetConfig()?.remotes.killSwitch.includes(remote)) return true;
  return getFlag(`remote.${remote}.disabled`, false);
}
