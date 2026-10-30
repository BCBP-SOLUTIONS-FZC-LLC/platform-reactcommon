// Reads packages/frontend-sdk/subpaths.json, the single source of truth for the SDK's subpaths
// and the dependency rules between them (design doc §C1 "Dependency rules").
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SubpathRule {
  readonly name: string;
  readonly layer: number;
  /** The functional area (an `areas[].id`); documentation and ownership only, no rule. */
  readonly area?: string;
  /** Subpaths this one may import; '*' means any. */
  readonly imports: readonly string[];
}

/** A functional area: a group of subpaths with one purpose, documented on `page`. */
export interface SubpathArea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** Repository-relative path of the area's documentation page. */
  readonly page: string;
}

export interface SubpathConfig {
  readonly areas: readonly SubpathArea[];
  readonly subpaths: readonly SubpathRule[];
  /** Third-party package prefix → the only subpaths allowed to import it. */
  readonly packageImports: Readonly<Record<string, readonly string[]>>;
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SDK_DIR = join(REPO_ROOT, 'packages/frontend-sdk');

export function loadSubpathConfig(sdkDir: string = SDK_DIR): SubpathConfig {
  const raw = JSON.parse(readFileSync(join(sdkDir, 'subpaths.json'), 'utf8')) as {
    areas: SubpathArea[];
    subpaths: SubpathRule[];
    packageImports: Record<string, string[] | string>;
  };
  const packageImports: Record<string, readonly string[]> = {};
  for (const [pkg, allowed] of Object.entries(raw.packageImports)) {
    if (pkg.startsWith('_')) continue; // _comment
    packageImports[pkg] = allowed as string[];
  }
  validateSubpathConfig(raw.subpaths);
  validateAreas(raw.areas, raw.subpaths);
  return { areas: raw.areas, subpaths: raw.subpaths, packageImports };
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

/** Every subpath belongs to exactly one known area; every area has an id, a page, and at least one subpath. */
export function validateAreas(areas: readonly SubpathArea[], subpaths: readonly SubpathRule[]): void {
  const ids = new Set<string>();
  for (const a of areas ?? []) {
    if (!/^[a-z][a-z0-9-]*$/.test(a.id)) throw new Error(`invalid area id ${JSON.stringify(a.id)}`);
    if (ids.has(a.id)) throw new Error(`duplicate area ${a.id}`);
    if (!a.title || !a.summary || !/^docs\/areas\/[a-z0-9-]+\.md$/.test(a.page)) throw new Error(`area ${a.id} needs a title, a summary and a docs/areas/*.md page`);
    ids.add(a.id);
  }
  for (const s of subpaths) {
    if (!s.area || !ids.has(s.area)) throw new Error(`subpath ${s.name} has no known area (got ${JSON.stringify(s.area)})`);
  }
  for (const id of ids) {
    if (!subpaths.some((s) => s.area === id)) throw new Error(`area ${id} has no subpath`);
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
