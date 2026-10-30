/**
 * UI authorization hints: which actions to show or enable. Never a security decision; the gateway
 * and the services authorize every request. Roles come from the session context (the token
 * carries none) and are parsed with platform-gincommon's rule.
 * Design contract: docs/design/frontend-sdk-design.md §C1 `/authz`.
 *
 * @packageDocumentation
 */
import { emitRuntime } from '../internal/events.ts';
import { getRuntime } from '../internal/runtime.ts';
import { parseRoles } from './roles.ts';

/** Who the UI is deciding for. A UI hint only: never sent to a backend. */
export interface AuthzSubject {
  readonly roles: readonly string[];
  readonly tenantId?: string;
}

/** Decides whether `user` may perform `action` on `resource`. UI gating only. */
export interface Authorizer {
  authorize(user: AuthzSubject | undefined, action: string, resource: string): boolean;
}

/** The default: everything is denied until the shell installs an authorizer and a subject. */
export const denyAll: Authorizer = Object.freeze({ authorize: () => false });

const PERMISSION = /^[^:\s]+:[^:\s]+$/;

/**
 * An authorizer from a role → permissions map. A permission is 'action:resource'; either part
 * may be '*'. A user is allowed when any of their roles grants a matching permission.
 */
export function roleMapAuthorizer(map: Record<string, readonly `${string}:${string}`[]>): Authorizer {
  const grants = new Map<string, { action: string; resource: string }[]>();
  for (const [role, perms] of Object.entries(map)) {
    if (!Array.isArray(perms)) throw new TypeError(`permissions of role "${role}" must be an array`);
    grants.set(
      role,
      perms.map((p) => {
        if (typeof p !== 'string' || !PERMISSION.test(p)) throw new TypeError(`permission ${JSON.stringify(p)} of role "${role}" must be 'action:resource'`);
        const [action, resource] = p.split(':') as [string, string];
        return { action, resource };
      }),
    );
  }
  return Object.freeze({
    authorize(user: AuthzSubject | undefined, action: string, resource: string): boolean {
      if (!user) return false;
      return user.roles.some((role) =>
        (grants.get(role) ?? []).some(
          (g) => (g.action === '*' || g.action === action) && (g.resource === '*' || g.resource === resource),
        ),
      );
    },
  });
}

/** Shell only: the authorizer every hasPermission call uses. */
export function setAuthorizer(a: Authorizer): void {
  getRuntime().authorizer = a ?? denyAll;
  emitRuntime('authz');
}

/**
 * Shell only: the current subject, from the session context. Roles are re-parsed with the backend
 * rule, so a malformed or oversized list grants nothing. undefined (signed out) denies everything.
 */
export function setAuthzSubject(s: AuthzSubject | undefined): void {
  getRuntime().authzSubject =
    s === undefined
      ? undefined
      : Object.freeze({ roles: Object.freeze(parseRoles(s.roles)), ...(s.tenantId === undefined ? {} : { tenantId: s.tenantId }) });
  emitRuntime('authz');
}

/**
 * Whether the current subject may perform `action` on `resource`. A UI hint: false before the
 * shell sets an authorizer and subject, and false if the authorizer throws or answers non-true.
 */
export function hasPermission(action: string, resource: string): boolean {
  const rt = getRuntime();
  const authorizer = (rt.authorizer as Authorizer | undefined) ?? denyAll;
  try {
    return authorizer.authorize(rt.authzSubject as AuthzSubject | undefined, action, resource) === true;
  } catch {
    return false;
  }
}
