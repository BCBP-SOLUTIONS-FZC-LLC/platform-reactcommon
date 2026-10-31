// The remote manifest (design doc §C1 /mfe, §C3): which remotes exist, where their entries are,
// and which domain team owns each. Validated per remote, so one bad entry never takes the others down.
import { tryGetConfig } from '../config/index.ts';
import { getLogger } from '../logging/index.ts';
import { getRuntime } from '../internal/runtime.ts';
import { REGISTRY_VOCAB } from '../internal/generated/registry-vocab.ts';

export interface RemoteManifestEntry {
  /** The remote's container entry, e.g. '/remotes/<name>/<version>/remoteEntry.js'. */
  readonly entry: string;
  readonly version: string;
  /** The registry domain whose team owns the remote (alert routing, Tier 2/3 metrics). */
  readonly ownerDomain: string;
  /** Subresource Integrity for the entry script, e.g. 'sha384-…'. */
  readonly integrity?: string;
}

export interface RemoteManifest {
  readonly [name: string]: RemoteManifestEntry;
}

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
const VERSION = new RegExp(REGISTRY_VOCAB.versionPattern);
const INTEGRITY = /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/;
const DOMAINS: readonly string[] = REGISTRY_VOCAB.domains;
const DEFAULT_URL = '/remotes/manifest.json';

/** Whether `entry` may be loaded: http(s), the page's own origin or an exact configured remote origin. */
export function isAllowedEntry(entry: string): boolean {
  let url: URL;
  try {
    url = new URL(entry, globalThis.location?.href ?? 'http://localhost/');
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  const page = globalThis.location?.origin ?? 'http://localhost';
  return url.origin === page || (tryGetConfig()?.remotes.allowedOrigins ?? []).includes(url.origin);
}

/** Why a manifest entry is unusable, or undefined when it is fine. */
function problemWith(name: string, e: unknown): string | undefined {
  if (!NAME.test(name) || name === 'shell') return `remote name must match ${NAME.source} and not be 'shell'`;
  if (typeof e !== 'object' || e === null) return 'entry is not an object';
  const { entry, version, ownerDomain, integrity, ...rest } = e as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return `unknown fields ${Object.keys(rest).join(', ')}`;
  if (typeof entry !== 'string' || !isAllowedEntry(entry)) return `entry ${JSON.stringify(entry)} is not same-origin or an allowed remote origin`;
  if (typeof version !== 'string' || !VERSION.test(version)) return `version ${JSON.stringify(version)} is invalid`;
  if (typeof ownerDomain !== 'string' || !DOMAINS.includes(ownerDomain)) return `ownerDomain ${JSON.stringify(ownerDomain)} is not a registry domain`;
  if (integrity !== undefined && (typeof integrity !== 'string' || !INTEGRITY.test(integrity))) return 'integrity is not an SRI hash';
  return undefined;
}

/**
 * Shell only: fetches and validates /remotes/manifest.json (no HTTP cache). Each invalid remote
 * is dropped with an error log; a manifest that is not a JSON object throws. The result is
 * published to the PlatformRuntime: the entries for loadRemote, and remote → ownerDomain for
 * /metrics.
 */
export async function loadManifest(url: string = DEFAULT_URL): Promise<RemoteManifest> {
  const res = await fetch(url, { cache: 'no-cache', credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const raw = (await res.json()) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError(`${url} is not a JSON object of remotes`);
  // Null prototype: a lookup by remote name never reaches Object.prototype ('constructor', …).
  const manifest: Record<string, RemoteManifestEntry> = Object.create(null) as Record<string, RemoteManifestEntry>;
  for (const [name, entry] of Object.entries(raw)) {
    const problem = problemWith(name, entry);
    if (problem) {
      getLogger().error('remote dropped from the manifest', { remote: name, reason: problem });
      continue;
    }
    manifest[name] = Object.freeze({ ...(entry as RemoteManifestEntry) });
  }
  const frozen = Object.freeze(manifest);
  const rt = getRuntime();
  rt.manifest = frozen;
  const remotes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [n, e] of Object.entries(frozen)) remotes[n] = e.ownerDomain;
  rt.remotes = Object.freeze(remotes);
  return frozen;
}

/** The manifest loadManifest published, if any. */
export function currentManifest(): RemoteManifest | undefined {
  return getRuntime().manifest as RemoteManifest | undefined;
}
