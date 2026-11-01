-- Seed for the real iam-org-membership in the integrated stack (docker-compose.yml). Runs after the service
-- has migrated its schema (compose: org-membership-seed). Idempotent. The ids are the ones in
-- test/stack/stack-constants.ts and the Keycloak user ids (the membership user_id is the Keycloak sub).
--
-- Runs as org_membership_app: tables are under FORCE ROW LEVEL SECURITY, so each tenant's rows are
-- written with app.tenant_id bound to that tenant, as the service's own GUC bridge does.

-- tenant-acme: a paid tenant on its dedicated realm.
SELECT set_config('app.tenant_id', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', false);
INSERT INTO tenants (id, slug, name, plan, status, subscription_started_at, realm_id, realm_type, feature_flags, default_locale)
VALUES ('7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', 'acme', 'Acme Corp', 'pro', 'active', now() - interval '30 days',
        'tenant-acme', 'dedicated', '{"llm_enabled": true}', 'en-US')
ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_departments (tenant_id, department_id)
VALUES ('7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', '3fa85f64-5717-4562-b3fc-2c963f66afa6')
ON CONFLICT DO NOTHING;
INSERT INTO tenant_memberships (id, tenant_id, user_id, status) VALUES
  ('5e000000-0000-4000-8000-0000000000a1', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f1', 'active'),
  ('5e000000-0000-4000-8000-0000000000a2', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f2', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_roles (id, tenant_id, user_id, tenant_membership_id, role_code, granted_by) VALUES
  ('5f000000-0000-4000-8000-0000000000a1', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f1',
   '5e000000-0000-4000-8000-0000000000a1', 'tenant_admin', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;
INSERT INTO dept_memberships (id, tenant_id, user_id, tenant_membership_id, department_id, role_level, granted_by) VALUES
  ('5d000000-0000-4000-8000-0000000000a1', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f1',
   '5e000000-0000-4000-8000-0000000000a1', '3fa85f64-5717-4562-b3fc-2c963f66afa6', 'reviewer', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- globex: a trial tenant in the shared trial realm.
SELECT set_config('app.tenant_id', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e02', false);
INSERT INTO tenants (id, slug, name, plan, status, trial_ends_at, realm_id, realm_type, default_locale)
VALUES ('7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e02', 'globex', 'Globex Trial', 'starter', 'trial', now() + interval '14 days',
        'trial', 'shared', 'en-US')
ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_memberships (id, tenant_id, user_id, status) VALUES
  ('5e000000-0000-4000-8000-0000000000b1', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e02', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f3', 'active')
ON CONFLICT (id) DO NOTHING;
INSERT INTO tenant_roles (id, tenant_id, user_id, tenant_membership_id, role_code, granted_by) VALUES
  ('5f000000-0000-4000-8000-0000000000b1', '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e02', '0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f3',
   '5e000000-0000-4000-8000-0000000000b1', 'tenant_owner', '00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- The BYPASSRLS pool (SYSTEM_DATABASE_URL, org_membership_migrator) serves PUB-1. In this stack the schema is
-- migrated by org_membership_app (as in iam-org-membership's own docker-compose), so the migrator role owns
-- nothing and has no table privileges: grant the reads the system pool needs (see the report, issue list).
GRANT SELECT ON ALL TABLES IN SCHEMA public TO org_membership_migrator;
