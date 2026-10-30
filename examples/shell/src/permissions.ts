// UI permissions per role (session context roles, IAM P-35). UI hints only: every request is authorised
// by the backend.
export const permissions: Record<string, readonly `${string}:${string}`[]> = {
  member: ['read:tender'],
  preparator: ['read:tender', 'update:tender'],
  tenant_admin: ['read:tender', 'update:tender', 'delete:tender', 'manage:members'],
};
