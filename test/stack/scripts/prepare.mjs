// Host-side half of `pnpm run stack-up` (test/stack, docker-compose.yml, docs/e2e/integrated-deployment-report.md):
// builds the web artefacts the deploy uploads and renders every environment-specific config into
// .state at the repository root (gitignored). Nothing here talks to Docker; the containers
// (docker-compose.yml) read .state.
//
//   .state/web/shell/          the example shell, built for this environment (PLATFORM_ENVIRONMENT=staging)
//   .state/web/remote/         the tenders remote
//   .state/web/runtime.json    /config/runtime.json for this environment
//   .state/lambda/csp-report.zip   examples/cloudfront/csp-report/handler.mjs bundled with the SDK (esbuild)
//   .state/cloudfront/         response headers policy (from csp.mjs), distribution config template
//   .state/keycloak/import/    tenant-acme.json and trial.json, from IAM's realm-template.json
//   .state/envoy/envoy.yaml    the gateway
//   .state/certs/              a self-signed certificate for the two hosts (kept between runs)
//   .state/stack.env           values docker compose interpolates
//
// Usage: node test/stack/scripts/prepare.mjs [--skip-build]
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STACK } from '../stack-constants.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const STATE = join(ROOT, '.state');
const IAM_ROOT = process.env.IAM_ROOT ?? join(ROOT, '..', '..', '..', 'XPertPMS', 'IAM');
const skipBuild = process.argv.includes('--skip-build');

const write = (rel, data) => {
  const file = join(STATE, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  return file;
};
const log = (m) => console.log(`[prepare] ${m}`);

// ── 1. Web builds ─────────────────────────────────────────────────────────────────────────────
async function webpackBuild(example, outDir, env) {
  const exampleDir = join(ROOT, 'examples', example);
  const req = createRequire(join(exampleDir, 'package.json'));
  const webpack = req('webpack');
  Object.assign(process.env, env);
  const { default: config } = await import(pathToFileURL(join(exampleDir, 'webpack.config.mjs')).href);
  const cfg = config('production');
  cfg.output = { ...cfg.output, path: outDir, clean: true };
  await new Promise((resolve, reject) =>
    webpack(cfg, (err, stats) => {
      if (err || stats.hasErrors()) reject(err ?? new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }),
  );
}

async function buildWeb() {
  if (!existsSync(join(ROOT, 'packages/frontend-sdk/dist/core/index.js'))) {
    throw new Error('packages are not built: run `pnpm build` first');
  }
  log('building examples/remote-tenders');
  await webpackBuild('remote-tenders', join(STATE, 'web/remote'), {});
  log(`building examples/shell (PLATFORM_ENVIRONMENT=${STACK.environment}, BUILD_VERSION=${STACK.shellVersion})`);
  await webpackBuild('shell', join(STATE, 'web/shell'), { PLATFORM_ENVIRONMENT: STACK.environment, BUILD_VERSION: STACK.shellVersion });
  // The shell's public/ (config/runtime.json) is NOT copied: this environment uploads its own runtime.json.

  log('bundling the /csp-report Lambda (esbuild, node22, ESM)');
  const esbuild = createRequire(join(ROOT, 'package.json'))('esbuild');
  const out = join(STATE, 'lambda/build/index.mjs');
  rmSync(dirname(out), { recursive: true, force: true });
  await esbuild.build({
    entryPoints: [join(ROOT, 'examples/cloudfront/csp-report/handler.mjs')],
    absWorkingDir: join(ROOT, 'examples/cloudfront'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: out,
    logLevel: 'warning',
  });
  rmSync(join(STATE, 'lambda/csp-report.zip'), { force: true });
  execFileSync('zip', ['-q', '-j', join(STATE, 'lambda/csp-report.zip'), out]);
  // The suggested fix for the (event, context) issue, as a wrapper next to the unchanged bundle.
}

// ── 2. runtime.json, CSP and the CloudFront inputs ─────────────────────────────────────────────
function runtimeJson() {
  const base = JSON.parse(readFileSync(join(ROOT, 'examples/shell/public/config/runtime.json'), 'utf8'));
  // Only what differs per environment: the IdP origin, and sampleRatio 1 so every trace is kept for the assertions.
  return {
    ...base,
    telemetry: { ...base.telemetry, sampleRatio: 1 },
    auth: { ...base.auth, idpOrigin: STACK.authOrigin },
  };
}

async function cloudfrontInputs() {
  const { securityHeaders } = await import(pathToFileURL(join(ROOT, 'examples/cloudfront/csp.mjs')).href);
  const h = securityHeaders({ idpOrigin: STACK.authOrigin });
  const template = JSON.parse(readFileSync(join(ROOT, 'examples/cloudfront/response-headers-policy.json'), 'utf8'));
  // The checked-in policy is the prod one (connect-src https://auth.bcbpsolutions.com); this environment's
  // differs only in the CSP value, generated from the same csp.mjs the README names.
  const policy = JSON.parse(JSON.stringify(template));
  policy.Name = 'platform-web-security-headers-e2e';
  policy.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy = h['Content-Security-Policy'];
  write('cloudfront/response-headers-policy.json', policy);
  write('cloudfront/spa-rewrite.js', readFileSync(join(ROOT, 'examples/cloudfront/spa-rewrite.js'), 'utf8'));
  write('cloudfront/expected-headers.json', h);
}

function manifest() {
  const entry = readFileSync(join(STATE, 'web/remote/remoteEntry.js'));
  return {
    tenders: {
      entry: `/remotes/tenders/${STACK.remoteVersion}/remoteEntry.js`,
      version: STACK.remoteVersion,
      ownerDomain: 'tender_management',
      integrity: `sha384-${createHash('sha384').update(entry).digest('base64')}`,
    },
  };
}

// ── 3. Keycloak realms from IAM's realm template ─────────────────────────────────────────────
function realm(name, o) {
  const template = JSON.parse(readFileSync(join(IAM_ROOT, 'iam-realm-provisioner/deploy/keycloak/realm-template.json'), 'utf8'));
  const r = JSON.parse(JSON.stringify(template));
  r.realm = name;
  r.id = name;
  if (o.accessTokenLifespan) r.accessTokenLifespan = o.accessTokenLifespan;
  // The SPA client's environment-specific half, as iam-realm-provisioner's WebClientConfig.apply sets it,
  // except the redirect URI: exactly /auth/callback (the provisioner registers <base>/*; see the report).
  const web = r.clients.find((c) => c.clientId === 'tender-web');
  web.redirectUris = STACK.redirectUris;
  web.webOrigins = [STACK.appOrigin];
  web.attributes = { ...web.attributes, 'post.logout.redirect.uris': STACK.postLogoutRedirectUris.join('##') };
  web.protocolMappers = [...(o.mappers ?? [])];
  // Every public client as iam-realm-provisioner sets it at realm creation and converges on the shared trial
  // realm (withPublicClientClaims):
  //   - RP #48 (RP-D21; report Issue 13): the audience mapper, its own client ID in the access token's aud,
  //     which Envoy's jwt_authn checks (HLD §8.3 step 3);
  //   - RP #49 (RP-D22; report Issue 16): profile and email are optional scopes, so access tokens carry no
  //     name or email (HLD §4.1); the id_token_name and id_token_email mappers put both in the ID token and
  //     userinfo only, where the SDK reads them.
  const idTokenOnly = { 'access.token.claim': 'false', 'id.token.claim': 'true', 'introspection.token.claim': 'false', 'userinfo.token.claim': 'true' };
  for (const c of r.clients) {
    if (!c.publicClient) continue;
    c.protocolMappers = [
      ...(c.protocolMappers ?? []),
      {
        name: 'audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': c.clientId, 'access.token.claim': 'true', 'id.token.claim': 'false', 'introspection.token.claim': 'true' },
      },
      { name: 'id_token_name', protocol: 'openid-connect', protocolMapper: 'oidc-full-name-mapper', config: idTokenOnly },
      {
        name: 'id_token_email',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: { 'user.attribute': 'email', 'claim.name': 'email', 'jsonType.label': 'String', ...idTokenOnly },
      },
    ];
    c.defaultClientScopes = ['web-origins', 'acr', 'roles', 'basic'];
    c.optionalClientScopes = ['profile', 'email', 'address', 'phone', 'offline_access', 'microprofile-jwt', 'organization'];
  }
  r.users = o.users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    emailVerified: true,
    firstName: u.firstName,
    lastName: u.lastName,
    enabled: true,
    ...(u.attributes ? { attributes: u.attributes } : {}),
    credentials: [{ type: 'password', value: u.password, temporary: false }],
    requiredActions: [],
  }));
  return r;
}

function keycloakRealms() {
  const tenantIdMapper = {
    // iam-realm-provisioner admin_shared_realm.go tenantIDMapper(): access + ID token + introspection.
    name: 'tenant_id',
    protocol: 'openid-connect',
    protocolMapper: 'oidc-usermodel-attribute-mapper',
    config: {
      'user.attribute': 'tenant_id',
      'claim.name': 'tenant_id',
      'jsonType.label': 'String',
      multivalued: 'false',
      'access.token.claim': 'true',
      'id.token.claim': 'true',
      'introspection.token.claim': 'true',
      'userinfo.token.claim': 'false',
    },
  };
  const acme = realm('tenant-acme', { accessTokenLifespan: STACK.acmeAccessTokenLifespan, users: [STACK.users.alice, STACK.users.bob, STACK.users.dave] });
  const trial = realm('trial', {
    users: [{ ...STACK.users.carol, attributes: { tenant_id: [STACK.tenants.globex.id] } }],
    mappers: [tenantIdMapper],
  });
  // Keycloak 24+ declarative user profile: tenant_id declared admin-only (provisioner applyUserProfile),
  // unmanaged attributes kept.
  trial.components = {
    'org.keycloak.userprofile.UserProfileProvider': [
      { providerId: 'declarative-user-profile', subComponents: {}, config: { 'kc.user.profile.config': [JSON.stringify(userProfile())] } },
    ],
  };
  write('keycloak/import/tenant-acme.json', acme);
  write('keycloak/import/trial.json', trial);
}

function userProfile() {
  const perms = (view, edit) => ({ view, edit });
  const name = (n, d) => ({
    name: n,
    displayName: d,
    validations: { length: { max: 255 }, 'person-name-prohibited-characters': {} },
    required: { roles: ['user'] },
    permissions: perms(['admin', 'user'], ['admin', 'user']),
    multivalued: false,
  });
  return {
    unmanagedAttributePolicy: 'ENABLED',
    attributes: [
      { name: 'username', displayName: '${username}', validations: { length: { min: 3, max: 255 }, 'username-prohibited-characters': {}, 'up-username-not-idn-homograph': {} }, permissions: perms(['admin', 'user'], ['admin', 'user']), multivalued: false },
      { name: 'email', displayName: '${email}', validations: { email: {}, length: { max: 255 } }, required: { roles: ['user'] }, permissions: perms(['admin', 'user'], ['admin', 'user']), multivalued: false },
      name('firstName', '${firstName}'),
      name('lastName', '${lastName}'),
      { name: 'tenant_id', displayName: 'Tenant ID', multivalued: false, permissions: perms(['admin'], ['admin']) },
    ],
    groups: [{ name: 'user-metadata', displayHeader: 'User metadata', displayDescription: 'Attributes, which refer to user metadata' }],
  };
}

// ── 4. Envoy ────────────────────────────────────────────────────────────────────────────────
function envoyYaml() {
  const tpl = readFileSync(join(ROOT, 'docker/envoy/envoy.template.yaml'), 'utf8');
  const vars = {
    ACME_ISSUER: STACK.issuer('tenant-acme'),
    TRIAL_ISSUER: STACK.issuer('trial'),
    AUDIENCES: STACK.envoyAudiences.length ? `audiences: [${STACK.envoyAudiences.join(', ')}]` : '# audiences: not checked (see report)',
    PRESERVE_REQUEST_ID: String(STACK.preserveExternalRequestId),
    PACK_TRACE_REASON: String(STACK.packTraceReason),
  };
  write('envoy/envoy.yaml', tpl.replace(/\$\{([A-Z_]+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`envoy template: no value for ${k}`);
    return vars[k];
  }));
}

// ── 5. Certificate and compose env ──────────────────────────────────────────────────────────
function certificate() {
  const dir = join(STATE, 'certs');
  if (existsSync(join(dir, 'edge.crt')) && existsSync(join(dir, 'edge.key'))) return;
  mkdirSync(dir, { recursive: true });
  log('generating a self-signed certificate for app.localtest.me and auth.localtest.me');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '365',
    '-keyout', join(dir, 'edge.key'), '-out', join(dir, 'edge.crt'),
    '-subj', '/CN=app.localtest.me',
    '-addext', `subjectAltName=DNS:${STACK.appHost},DNS:${STACK.authHost}`,
  ], { stdio: 'ignore' });
}

function composeEnv() {
  const secretFile = join(STATE, 'origin-verify.secret');
  // CloudFront's x-origin-verify value: generated once, stored in Secrets Manager by the deploy.
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('base64url'));
  const env = {
    STACK_HTTPS_PORT: STACK.httpsPort,
    APP_ORIGIN: STACK.appOrigin,
    AUTH_ORIGIN: STACK.authOrigin,
    AUTH_HOSTNAME_URL: STACK.authOrigin,
    SHARED_REALM_ISSUER: STACK.issuer('trial'),
    REALM_TENANT_MAP_SEED: JSON.stringify({ [STACK.issuer('tenant-acme')]: STACK.tenants.acme.id }),
    REMOTE_VERSION: STACK.remoteVersion,
    SHELL_VERSION: STACK.shellVersion,
    IAM_ROOT: relative(ROOT, IAM_ROOT),
  };
  write('stack.env', Object.entries(env).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`).join('\n') + '\n');
}

if (!skipBuild) await buildWeb();
mkdirSync(join(STATE, 'web'), { recursive: true });
write('web/runtime.json', runtimeJson());
write('web/manifest.json', manifest());
write('web/version.json', { version: STACK.shellVersion });
await cloudfrontInputs();
keycloakRealms();
envoyYaml();
certificate();
composeEnv();
for (const d of ['otel', 'logs']) mkdirSync(join(STATE, d), { recursive: true });
// The Lambda zip and the web builds are copied as-is; make sure they exist even with --skip-build.
for (const f of ['web/shell/index.html', 'web/remote/remoteEntry.js', 'lambda/csp-report.zip']) {
  if (!existsSync(join(STATE, f))) throw new Error(`.state/${f} is missing: run without --skip-build`);
}
log(`done: ${STATE}`);
