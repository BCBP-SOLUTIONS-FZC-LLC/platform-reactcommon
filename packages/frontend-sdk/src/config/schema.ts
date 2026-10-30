// The runtime config schema (design doc §C1 /config): one /config/runtime.json per environment,
// validated strictly (unknown keys rejected at every level) so a typo fails the bootstrap instead
// of being silently ignored. Defaults exist only where the design doc names one.
import * as z from 'zod/mini';

// zod/mini: the same validation core as zod, tree-shakable, without the method-chaining API and
// its default English messages (~90 KB gz → see the PR measuring it). Zod's fast path probes `new Function('')` on first parse. Under the CSP's script-src 'self' (design
// doc §C3) the probe throws (caught) but still fires a CSP violation and a /csp-report on every page
// load. Jitless validation needs no eval. It must be set before any schema below is built.
z.config({ jitless: true });

/** The page's runtime configuration, loaded once by the shell. */
export interface RuntimeConfig {
  readonly api: {
    /** Same-origin path the API is served under, e.g. '/api'. */
    readonly baseUrl: string;
    /** Client deadline per call; default 35000 (above gincommon's 30 s server timeout). */
    readonly timeoutMs: number;
    /** Exact origins, besides the page's own, that receive trace propagation headers; default []. */
    readonly propagationAllowlist: readonly string[];
  };
  readonly telemetry: {
    /** Same-origin path of the OTLP/HTTP collector; default '/otel'. */
    readonly otlpBaseUrl: string;
    /** Trace sampling ratio in [0, 1]; default 0.1. */
    readonly sampleRatio: number;
    /** Minimum level sent; default 'info'. */
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
    /** Send the RUM session id as x-session-id; default true (opt-out). */
    readonly sendSessionHeader: boolean;
  };
  readonly auth: {
    /** Keycloak origin; default 'https://auth.bcbpsolutions.com' (IAM HLD §8.2.4). The issuer is `${idpOrigin}/realms/${realm}`. */
    readonly idpOrigin: string;
    /** The shared trial realm; default 'trial'. */
    readonly trialRealm: string;
    /** A resolved paid realm must equal `${paidRealmPrefix}${slug}`; default 'tenant-'. */
    readonly paidRealmPrefix: string;
    /** Workspace URLs are `${workspacePathPrefix}<slug>/…`; default '/t/'. */
    readonly workspacePathPrefix: string;
    /** OIDC client; default 'tender-web'. */
    readonly clientId: string;
    /** OIDC scopes; must include 'openid'; default ['openid']. */
    readonly scopes: readonly string[];
    /** SDK idle timeout; at most 8 h, the refresh token's idle lifetime (HLD §11.3). */
    readonly idleTimeoutMs: number;
    /** Same-origin path Keycloak redirects back to. */
    readonly redirectPath: string;
  };
  /** Platform flags (kill switches, rollout). Names are opaque; default {}. */
  readonly flags: Readonly<Record<string, boolean | string | number>>;
  readonly remotes: {
    /** Remote names that must not load; default []. */
    readonly killSwitch: readonly string[];
    readonly loadTimeoutMs: number;
    readonly retries: number;
    /** Exact origins, besides the page's own, remote entries may come from; default []. */
    readonly allowedOrigins: readonly string[];
  };
  readonly i18n: {
    /** A canonical BCP 47 tag, e.g. 'en' or 'ar'. */
    readonly defaultLocale: string;
    /** Canonical BCP 47 tags; must include defaultLocale. */
    readonly supportedLocales: readonly string[];
  };
  readonly appUpdate: {
    /** How often /version.json is polled; at least 10 s. */
    readonly pollIntervalMs: number;
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const HOUR_MS = 3_600_000;

type Ctx = { addIssue(issue: { code: 'custom'; message: string; input?: unknown }): void };

/** A string with a custom check that reports `message(value)` when `ok(value)` is false. */
const checkedString = (ok: (v: string) => boolean, message: (v: string) => string) =>
  z.string().check(
    z.superRefine((value: string, ctx: Ctx) => {
      if (!ok(value)) ctx.addIssue({ code: 'custom', message: message(value), input: value });
    }),
  );

/** An exact origin (scheme://host[:port], nothing else): https, or http on a local host only. */
const exactOrigin = checkedString(
  (value) => {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    return url !== undefined && url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)));
  },
  (value) => `must be an exact https origin (http only for localhost), got ${JSON.stringify(value)}`,
);

/** A same-origin absolute path: no scheme, no '//', no '\', no query or fragment, no dot segments. */
const isSameOriginPath = (value: string): boolean =>
  /^\/(?!\/)[^\s?#\\]*$/.test(value) && !value.split('/').some((segment) => segment === '.' || segment === '..') && !/[\p{Cc}]/u.test(value);
const sameOriginPath = checkedString(isSameOriginPath, (value) => `must be a same-origin path such as '/api', got ${JSON.stringify(value)}`);

const pattern = (re: RegExp, message: string) => z.string().check(z.regex(re, message));
const slug = pattern(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lower-case kebab slug');
const mfeName = pattern(/^[a-z][a-z0-9_-]{0,62}$/, 'must match ^[a-z][a-z0-9_-]{0,62}$ (the mfe label)');
const scopeToken = pattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/, 'must be an OAuth scope token (RFC 6749 §3.3)');
const intMs = (min: number, max: number) => z.int().check(z.gte(min), z.lte(max));

const canonicalLocale = z.string().check(
  z.superRefine((value: string, ctx: Ctx) => {
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(value)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical !== value) {
      ctx.addIssue({
        code: 'custom',
        message: canonical ? `must be the canonical tag ${JSON.stringify(canonical)}` : `${JSON.stringify(value)} is not a BCP 47 language tag`,
        input: value,
      });
    }
  }),
);

const schema = z.strictObject({
  api: z.strictObject({
    baseUrl: sameOriginPath,
    timeoutMs: z._default(intMs(1_000, 300_000), 35_000),
    propagationAllowlist: z._default(z.array(exactOrigin), []),
  }),
  telemetry: z.strictObject({
    otlpBaseUrl: z._default(sameOriginPath, '/otel'),
    sampleRatio: z._default(z.number().check(z.gte(0), z.lte(1)), 0.1),
    logLevel: z._default(z.enum(['debug', 'info', 'warn', 'error']), 'info'),
    sendSessionHeader: z._default(z.boolean(), true),
  }),
  auth: z
    .strictObject({
      idpOrigin: z._default(exactOrigin, 'https://auth.bcbpsolutions.com'),
      trialRealm: z._default(slug, 'trial'),
      paidRealmPrefix: z._default(pattern(/^[a-z][a-z0-9-]*-$/, "must be a lower-case prefix ending in '-'"), 'tenant-'),
      workspacePathPrefix: z._default(
        checkedString(
          (v) => isSameOriginPath(v) && v.length > 1 && v.endsWith('/'),
          (v) => (isSameOriginPath(v) ? "must start and end with '/', e.g. '/t/'" : `must be a same-origin path such as '/api', got ${JSON.stringify(v)}`),
        ),
        '/t/',
      ),
      clientId: z._default(pattern(/^[A-Za-z0-9._-]{1,255}$/, 'must be an OIDC client id'), 'tender-web'),
      scopes: z._default(z.array(scopeToken).check(z.refine((s: string[]) => s.includes('openid'), "must include 'openid'")), ['openid']),
      idleTimeoutMs: intMs(60_000, 8 * HOUR_MS),
      redirectPath: sameOriginPath,
    })
    .check(
      z.refine((a: { trialRealm: string; paidRealmPrefix: string }) => !a.trialRealm.startsWith(a.paidRealmPrefix), {
        message: 'trialRealm must not start with paidRealmPrefix, or a trial realm would look like a paid one',
        path: ['trialRealm'],
      }),
    ),
  flags: z._default(
    z.record(
      z.string().check(z.minLength(1)),
      z.union([z.boolean(), z.string(), z.number().check(z.refine((n: number) => Number.isFinite(n), 'must be finite'))]),
    ),
    {},
  ),
  remotes: z.strictObject({
    killSwitch: z._default(z.array(mfeName), []),
    loadTimeoutMs: intMs(1_000, 120_000),
    retries: z.int().check(z.gte(0), z.lte(5)),
    allowedOrigins: z._default(z.array(exactOrigin), []),
  }),
  i18n: z
    .strictObject({
      defaultLocale: canonicalLocale,
      supportedLocales: z.array(canonicalLocale).check(z.minLength(1)),
    })
    .check(
      z.refine((i: { defaultLocale: string; supportedLocales: string[] }) => i.supportedLocales.includes(i.defaultLocale), {
        message: 'must include defaultLocale',
        path: ['supportedLocales'],
      }),
    ),
  appUpdate: z.strictObject({ pollIntervalMs: intMs(10_000, 24 * HOUR_MS) }),
});

/** The schema of /config/runtime.json: strict (unknown keys rejected at every level), with defaults applied. */
export const RuntimeConfigSchema: z.ZodMiniType<RuntimeConfig> = schema;
