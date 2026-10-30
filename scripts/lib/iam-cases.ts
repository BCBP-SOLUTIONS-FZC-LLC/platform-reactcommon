// SDK-authored cases for the IAM APIs the shell's /auth ports call (design doc §C5 contract #18).
// scripts/sync-contracts.ts checks every `response` against iam-org-membership's swagger and writes
// contracts/tenant-resolve-cases.json and contracts/session-context-cases.json. `expected` is what
// the port must return: a Workspace (WorkspaceResolver.resolve, null for undefined) or a SessionContext
// (SessionContextSource.load). /auth tests mock the ports with them; /testing's contract tests run
// the shell's ports against them.

const ACME_TENANT = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';
const TRIAL_TENANT = '0b7e4c1a-2d3f-4a5b-9c8d-7e6f5a4b3c2d';

/**
 * PUB-1, GET /public/tenants/resolve?identifier=. Mapping rules: strategy 'shared' is the trial realm,
 * 'dedicated' a paid one; a paid slug is the realm after paidRealmPrefix ('tenant-'); a trial result has a
 * slug only when the identifier was one; `tenant_id` becomes `tenantIdHint` (trial only); `found: false` → null.
 */
export const TENANT_RESOLVE_CASES = [
  {
    name: 'paid workspace by slug',
    identifier: 'acme',
    response: { found: true, realm: 'tenant-acme', strategy: 'dedicated' },
    expected: { realm: 'tenant-acme', trial: false, slug: 'acme' },
  },
  {
    name: 'paid workspace by pending-invite email',
    identifier: 'new.hire@acme.example',
    response: { found: true, realm: 'tenant-acme', strategy: 'dedicated' },
    expected: { realm: 'tenant-acme', trial: false, slug: 'acme' },
  },
  {
    name: 'trial workspace by slug',
    identifier: 'beta-labs',
    response: { found: true, realm: 'trial', strategy: 'shared', tenant_id: TRIAL_TENANT },
    expected: { realm: 'trial', trial: true, slug: 'beta-labs', tenantIdHint: TRIAL_TENANT },
  },
  {
    name: 'trial workspace by pending-invite email (no slug: used once, never cached)',
    identifier: 'invitee@beta.example',
    response: { found: true, realm: 'trial', strategy: 'shared', tenant_id: TRIAL_TENANT },
    expected: { realm: 'trial', trial: true, tenantIdHint: TRIAL_TENANT },
  },
  {
    name: 'trial workspace without tenant_id (OQ-10 removed the hint)',
    identifier: 'beta-labs',
    response: { found: true, realm: 'trial', strategy: 'shared' },
    expected: { realm: 'trial', trial: true, slug: 'beta-labs' },
  },
  {
    name: 'not found (unknown slug, active member email, or anything else: never says which)',
    identifier: 'nobody',
    response: { found: false },
    expected: null,
  },
];

/** P-35, GET /me/session-context: snake_case → camelCase; absent optional fields stay absent. */
export const SESSION_CONTEXT_CASES = [
  {
    name: 'paid tenant admin with departments, plan and MFA window',
    response: {
      tenant_id: ACME_TENANT,
      slug: 'acme',
      roles: ['member', 'tenant_admin'],
      departments: [
        { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', level: 'approver' },
        { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', level: 'preparator' },
      ],
      plan: 'business',
      feature_flags: ['ai_drafting'],
      read_only: false,
      mfa_freshness_seconds: 300,
      locale: 'ar',
    },
    expected: {
      tenantId: ACME_TENANT,
      slug: 'acme',
      roles: ['member', 'tenant_admin'],
      departments: [
        { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', level: 'approver' },
        { id: '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e', level: 'preparator' },
      ],
      plan: 'business',
      featureFlags: ['ai_drafting'],
      readOnly: false,
      mfaFreshnessSeconds: 300,
      locale: 'ar',
    },
  },
  {
    name: 'trial member: empty lists, no optional fields',
    response: { tenant_id: TRIAL_TENANT, slug: 'beta-labs', roles: ['member'], departments: [], feature_flags: [], read_only: false },
    expected: { tenantId: TRIAL_TENANT, slug: 'beta-labs', roles: ['member'], departments: [], featureFlags: [], readOnly: false },
  },
  {
    name: 'read-only tenant: read_only flag and the read_only feature flag',
    response: {
      tenant_id: ACME_TENANT,
      slug: 'acme',
      roles: ['member'],
      departments: [],
      plan: 'starter',
      feature_flags: ['read_only'],
      read_only: true,
    },
    expected: { tenantId: ACME_TENANT, slug: 'acme', roles: ['member'], departments: [], plan: 'starter', featureFlags: ['read_only'], readOnly: true },
  },
];
