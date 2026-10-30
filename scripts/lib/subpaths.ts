// Reads packages/frontend-sdk/subpaths.json, the single source of truth for the SDK's subpaths
// and the dependency rules between them (design doc §C1 "Dependency rules").
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SubpathRule {
  readonly name: string;
  readonly layer: number;
  /** Subpaths this one may import; '*' means any. */
  readonly imports: readonly string[];
}

export interface SubpathConfig {
  readonly subpaths: readonly SubpathRule[];
  /** Third-party package prefix → the only subpaths allowed to import it. */
  readonly packageImports: Readonly<Record<string, readonly string[]>>;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SDK_DIR = join(REPO_ROOT, 'packages/frontend-sdk');

export function loadSubpathConfig(sdkDir: string = SDK_DIR): SubpathConfig {
  const raw = JSON.parse(readFileSync(join(sdkDir, 'subpaths.json'), 'utf8')) as {
    subpaths: SubpathRule[];
    packageImports: Record<string, string[] | string>;
  };
  const packageImports: Record<string, readonly string[]> = {};
  for (const [pkg, allowed] of Object.entries(raw.packageImports)) {
    if (pkg.startsWith('_')) continue; // _comment
    packageImports[pkg] = allowed as string[];
  }
  validateSubpathConfig(raw.subpaths);
  return { subpaths: raw.subpaths, packageImports };
}

/** Rejects unknown or duplicate names and imports that point at a subpath that does not exist. */
export function validateSubpathConfig(subpaths: readonly SubpathRule[]): void {
  const names = new Set<string>();
  for (const s of subpaths) {
    if (!/^[a-z][a-z0-9]*$/.test(s.name)) throw new Error(`invalid subpath name ${JSON.stringify(s.name)}`);
    if (names.has(s.name)) throw new Error(`duplicate subpath ${s.name}`);
    names.add(s.name);
  }
  for (const s of subpaths) {
    for (const i of s.imports) {
      if (i !== '*' && !names.has(i)) throw new Error(`subpath ${s.name} imports unknown subpath ${i}`);
      if (i === s.name) throw new Error(`subpath ${s.name} lists itself in imports`);
    }
  }
}

/** Subpaths whose `src/<name>/index.ts` exists, in subpaths.json order. Only these are built and exported. */
export function implementedSubpaths(sdkDir: string = SDK_DIR, config = loadSubpathConfig(sdkDir)): string[] {
  return config.subpaths.map((s) => s.name).filter((n) => existsSync(join(sdkDir, 'src', n, 'index.ts')));
}

/** The subpaths `name` may import (never itself; '*' expands to all others). */
export function allowedImports(name: string, config: SubpathConfig): string[] {
  const rule = config.subpaths.find((s) => s.name === name);
  if (!rule) throw new Error(`unknown subpath ${name}`);
  if (rule.imports.includes('*')) return config.subpaths.map((s) => s.name).filter((n) => n !== name);
  return [...rule.imports];
}
