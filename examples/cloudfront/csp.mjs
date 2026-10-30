// The response headers of design doc §C3 (every behavior except /api/*, which the gateway owns), from
// one source. response-headers-policy.json must match (test/csp.test.ts).

/** Trusted Types policies the page creates: /security, @platform/webpack-preset, DOMPurify. */
export const TRUSTED_TYPES_POLICIES = ['platform-sdk', 'platform-webpack', 'dompurify'];

/** An exact https origin (scheme://host[:port], no path, wildcard or trailing slash), or a TypeError. */
function httpsOrigin(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (typeof value !== 'string' || !url || url.protocol !== 'https:' || url.origin !== value || value.includes('*')) {
    throw new TypeError(`${name} must be an exact https origin, got ${value}`);
  }
  return value;
}

const origins = (list, name) => {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new TypeError(`${name} must be an array of https origins`);
  return list.map((o) => httpsOrigin(o, name));
};

/**
 * The Content-Security-Policy value. `idpOrigin` is the Keycloak origin the token fetches go to (§D4).
 * `remoteOrigins` must mirror runtime.json `remotes.allowedOrigins` (remoteEntry.js, its chunks and the
 * static CSS, images and fonts they bring: script-src, style-src, img-src, font-src, connect-src); `apiOrigins` must mirror the cross-origin entries of runtime.json
 * `api.propagationAllowlist` (connect-src). Both default to none, i.e. everything same-origin.
 */
export function buildCsp({ idpOrigin = 'https://auth.bcbpsolutions.com', remoteOrigins, apiOrigins } = {}) {
  const origin = httpsOrigin(idpOrigin, 'idpOrigin');
  const remotes = origins(remoteOrigins, 'remoteOrigins');
  const apis = origins(apiOrigins, 'apiOrigins');
  const list = (...xs) => [...new Set(xs.flat())].join(' ');
  return [
    "default-src 'none'",
    `script-src ${list("'self'", remotes)}`,
    `style-src ${list("'self'", remotes)}`,
    `img-src ${list("'self'", 'data:', remotes)}`,
    `font-src ${list("'self'", remotes)}`,
    `connect-src ${list("'self'", origin, remotes, apis)}`,
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
    "require-trusted-types-for 'script'",
    `trusted-types ${TRUSTED_TYPES_POLICIES.join(' ')}`,
    // report-uri is the fallback for browsers without Reporting-API CSP reports (they ignore it otherwise).
    'report-uri /csp-report',
    'report-to csp',
  ].join('; ');
}

/** Every header of the policy, CSP included. */
export function securityHeaders(o) {
  return {
    'Content-Security-Policy': buildCsp(o),
    'Reporting-Endpoints': 'csp="/csp-report"',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}
