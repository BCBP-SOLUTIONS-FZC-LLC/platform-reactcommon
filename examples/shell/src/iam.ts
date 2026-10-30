// The /auth ports, implemented over the SDK's ApiClient (design doc §C1 /auth): PUB-1 (resolve a slug or
// a pending-invite email to a realm) and IAM P-35 (the session context). The mappings are the ones
// packages/frontend-sdk/contracts/tenant-resolve-cases.json and session-context-cases.json pin.
import type { SessionContext, SessionContextSource, Workspace, WorkspaceResolver } from '@platform/frontend-sdk/auth';
import { tryGetConfig } from '@platform/frontend-sdk/config';
import { createApiClient } from '@platform/frontend-sdk/http';

interface ResolveResponse {
  found?: boolean;
  realm?: string;
  strategy?: 'shared' | 'dedicated';
  tenant_id?: string;
}

interface SessionContextResponse {
  tenant_id: string;
  slug: string;
  roles?: string[] | null;
  departments?: { id: string; level: string }[] | null;
  plan?: string;
  feature_flags?: string[] | null;
  read_only?: boolean;
  mfa_freshness_seconds?: number;
  locale?: string;
}

const api = createApiClient();

/** PUB-1 response → Workspace: 'shared' is the trial realm; a paid slug is the realm after paidRealmPrefix. */
export function toWorkspace(identifier: string, r: ResolveResponse): Workspace | undefined {
  if (r.found !== true || typeof r.realm !== 'string' || r.realm === '') return undefined;
  const trial = r.strategy === 'shared';
  const prefix = tryGetConfig()?.auth.paidRealmPrefix ?? 'tenant-';
  // An email identifier never names the slug; a trial result has one only when the identifier was it.
  const slug = trial ? (identifier.includes('@') ? undefined : identifier) : r.realm.startsWith(prefix) ? r.realm.slice(prefix.length) : undefined;
  return {
    realm: r.realm,
    trial,
    ...(slug ? { slug } : {}),
    ...(trial && typeof r.tenant_id === 'string' ? { tenantIdHint: r.tenant_id } : {}),
  };
}

/** P-35 response → SessionContext (snake_case → camelCase; lists are never null). */
export function toSessionContext(r: SessionContextResponse): SessionContext {
  return {
    tenantId: r.tenant_id,
    slug: r.slug,
    roles: r.roles ?? [],
    departments: r.departments ?? [],
    ...(r.plan !== undefined ? { plan: r.plan } : {}),
    featureFlags: r.feature_flags ?? [],
    readOnly: r.read_only === true,
    ...(r.mfa_freshness_seconds !== undefined ? { mfaFreshnessSeconds: r.mfa_freshness_seconds } : {}),
    ...(r.locale !== undefined ? { locale: r.locale } : {}),
  };
}

export const workspaceResolver: WorkspaceResolver = {
  async resolve(identifier, signal) {
    // Same origin, no token: a public endpoint, rate-limited per IP.
    const res = await api.get<ResolveResponse>('/v1/public/tenants/resolve', { query: { identifier }, auth: false, ...(signal ? { signal } : {}) });
    return toWorkspace(identifier, res.data);
  },
};

export const sessionContextSource: SessionContextSource = {
  async load(signal) {
    const res = await api.get<SessionContextResponse>('/v1/me/session-context', signal ? { signal } : {});
    return toSessionContext(res.data);
  },
};
