// The integrated stack's fixed values, shared by scripts/prepare.mjs (configs), docker-compose.yml (through
// .state/stack.env) and e2e.spec.ts. Erasable TypeScript only: Node runs it with type stripping.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const pkgVersion = (dir: string): string => (JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { version: string }).version;
const env = (k: string, d: string): string => process.env[k] ?? d;

const httpsPort = Number(env('STACK_HTTPS_PORT', '443'));
const suffix = httpsPort === 443 ? '' : `:${httpsPort}`;
const appHost = 'app.localtest.me';
const authHost = 'auth.localtest.me';
const appOrigin = `https://${appHost}${suffix}`;
const authOrigin = `https://${authHost}${suffix}`;

const user = (id: string, username: string, firstName: string, lastName: string, email: string) => ({
  id,
  username,
  firstName,
  lastName,
  email,
  password: 'Passw0rd!e2e',
});

export const STACK = {
  project: 'reactcommon-e2e',
  httpsPort,
  appHost,
  authHost,
  appOrigin,
  authOrigin,
  /** Page identity environment the shell is built with (a build-time define, examples/shell/webpack.config.mjs). */
  environment: 'staging',
  shellVersion: `${pkgVersion('examples/shell')}-e2e`,
  remoteVersion: pkgVersion('examples/remote-tenders'),
  /** The version the remote was deployed under by the last stack-up: the package version plus a content hash (prepare.mjs). */
  deployedRemoteVersion: (): string => /^REMOTE_VERSION='([^']+)'$/m.exec(readFileSync(join(ROOT, '.state/stack.env'), 'utf8'))![1]!,
  issuer: (realm: string): string => `${authOrigin}/realms/${realm}`,
  redirectUris: [`${appOrigin}/auth/callback`],
  postLogoutRedirectUris: [`${appOrigin}/`],
  /** tenant-acme access tokens live this long (s): short, so the refresh lineage is exercised in a test. */
  acmeAccessTokenLifespan: Number(env('STACK_ACME_TOKEN_LIFESPAN', '60')),
  /** Envoy jwt_authn audiences: the public clients, as iam-realm-provisioner #48 specifies (report Issue 13). */
  envoyAudiences: env('STACK_ENVOY_AUDIENCES', 'tender-web,tender-mobile').split(',').filter(Boolean),
  /** Envoy: keep the browser's x-request-id (the fix for the request-id issue). */
  preserveExternalRequestId: env('STACK_PRESERVE_REQUEST_ID', 'true') === 'true',
  /** Envoy: do not rewrite the request id's version nibble (the fix for the request-id issue). */
  packTraceReason: env('STACK_PACK_TRACE_REASON', 'false') === 'true',
  tenants: {
    acme: { id: '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e01', slug: 'acme', realm: 'tenant-acme' },
    globex: { id: '7f3c2a10-5b6e-4d8a-9c1f-0a1b2c3d4e02', slug: 'globex', realm: 'trial' },
  },
  departmentId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  users: {
    /** tenant-acme, tenant_admin + dept reviewer. */
    alice: user('0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f1', 'alice', 'Alice', 'Acme', 'alice@acme.test'),
    /** tenant-acme, member: the second person on the shared device. */
    bob: user('0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f2', 'bob', 'Bob', 'Acme', 'bob@acme.test'),
    /** trial (globex), tenant_owner. */
    carol: user('0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f3', 'carol', 'Carol', 'Globex', 'carol@globex.test'),
    /** tenant-acme realm account with NO Org & Membership membership: AuthZ Enrichment denies. */
    dave: user('0c5d8e2a-1f3b-4c6d-8e9f-a1b2c3d4e5f4', 'dave', 'Dave', 'Nomember', 'dave@acme.test'),
  },
  /** Host ports besides the HTTPS entry (all on 127.0.0.1). */
  ports: { keycloak: 18080, floci: 18566, envoyAdmin: 19901 },
} as const;
