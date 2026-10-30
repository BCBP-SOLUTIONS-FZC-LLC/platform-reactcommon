// Role parsing with platform-gincommon's ParseRoles rule (design doc §C5 row 10).
import { HEADERS } from '../internal/generated/headers.ts';

const ROLE_TOKEN = new RegExp(HEADERS.patterns.roleToken);
const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * Roles parsed with gincommon's ParseRoles: comma-separated (or a list), each trimmed; tokens that
 * are empty, longer than 64 bytes or not ^[a-zA-Z0-9_-]+$ are dropped; duplicates are dropped.
 * Fails closed to [] when the whole value is over 4096 bytes or holds more than 64 roles.
 */
export function parseRoles(input: string | readonly string[] | undefined): string[] {
  if (input === undefined || input === null) return [];
  const header = typeof input === 'string' ? input : Array.isArray(input) ? input.filter((r) => typeof r === 'string').join(',') : '';
  if (header === '') return [];
  if (utf8Length(header) > HEADERS.limits.rolesHeaderMaxBytes) return [];
  const roles: string[] = [];
  const seen = new Set<string>();
  for (const part of header.split(',')) {
    const r = part.trim();
    if (r === '' || utf8Length(r) > HEADERS.limits.roleMaxBytes || !ROLE_TOKEN.test(r) || seen.has(r)) continue;
    if (roles.length === HEADERS.limits.maxRoles) return [];
    seen.add(r);
    roles.push(r);
  }
  return roles;
}

