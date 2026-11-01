// The viewer's single HTTPS entry for the integrated stack (docker-compose.yml, test/stack): the floci-gap shim.
//
//   https://auth.<domain>  → Keycloak (as the ALB in front of it would: TLS here, X-Forwarded-* to Keycloak)
//   https://app.<domain>   → "CloudFront", from the distribution config floci holds (.state/cloudfront):
//       S3-origin behaviors   forwarded to floci's CloudFront data plane (Host: <dist>.cloudfront.net), which
//                             serves the objects and applies the response headers policy itself. The one
//                             thing added here: the behavior's viewer-request CloudFront Function, which
//                             floci 2.1.0 does not execute — run with node:vm from the code floci has LIVE.
//       custom-origin behaviors   floci 2.1.0 fails every custom origin (502 UnknownHostException), so they
//                             are proxied here: origin DomainName/HTTPPort, the origin's CustomHeaders
//                             (x-origin-verify on /csp-report), X-Forwarded-For appended, Host = origin
//                             domain, and the behavior's response headers policy applied.
// Nothing else: no caching, no compression, no WAF (floci has no WAF data plane either).
// Every request is logged as one JSON line (stdout and /logs/edge.jsonl) for the e2e evidence.
import { Buffer } from 'node:buffer';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { runInNewContext } from 'node:vm';

const STATE = process.env.STATE_DIR ?? '/state';
const FLOCI = new URL(process.env.FLOCI_URL ?? 'http://floci:4566');
const KEYCLOAK = new URL(process.env.KEYCLOAK_URL ?? 'http://keycloak:8080');
const APP_HOST = process.env.APP_HOST ?? 'app.localtest.me';
const AUTH_HOST = process.env.AUTH_HOST ?? 'auth.localtest.me';
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? 443);
const LOG_FILE = process.env.LOG_FILE ?? '/logs/edge.jsonl';

const log = (o) => {
  const line = JSON.stringify({ kind: 'edge', time: new Date().toISOString(), ...o });
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // stdout has it
  }
};

// ── distribution state (reloaded when web-deploy rewrites it) ─────────────────────────────────
let dist; // { id, domain, config, functions: Map<arn, handler>, policies: Map<id, headers> }
let distMtime = 0;

function loadDistribution() {
  const file = `${STATE}/cloudfront/distribution.json`;
  if (!existsSync(file)) return undefined;
  const m = statSync(file).mtimeMs;
  if (dist && m === distMtime) return dist;
  const d = JSON.parse(readFileSync(file, 'utf8')).Distribution;
  let code = readFileSync(`${STATE}/cloudfront/spa-rewrite.live.js`, 'utf8');
  // floci 2.1.0's GetFunction returns the code base64-encoded (AWS returns the bytes): decode it.
  if (/^[A-Za-z0-9+/=\s]+$/.test(code)) code = Buffer.from(code, 'base64').toString('utf8');
  const ctx = {};
  runInNewContext(`${code}\nthis.handler = handler;`, ctx);
  const policy = JSON.parse(readFileSync(`${STATE}/cloudfront/response-headers-policy.live.json`, 'utf8')).ResponseHeadersPolicy;
  dist = {
    id: d.Id,
    domain: d.DomainName,
    config: d.DistributionConfig,
    // The only CloudFront Function in this distribution; any viewer-request association runs it.
    viewerRequest: ctx.handler,
    policies: new Map([[policy.Id, policyHeaders(policy.ResponseHeadersPolicyConfig)]]),
  };
  distMtime = m;
  log({ event: 'distribution-loaded', id: dist.id, domain: dist.domain });
  return dist;
}

/** ResponseHeadersPolicyConfig → header map, as CloudFront adds them (all Override: true here). */
function policyHeaders(cfg) {
  const h = {};
  const s = cfg.SecurityHeadersConfig ?? {};
  if (s.ContentSecurityPolicy) h['content-security-policy'] = s.ContentSecurityPolicy.ContentSecurityPolicy;
  if (s.StrictTransportSecurity) {
    const t = s.StrictTransportSecurity;
    h['strict-transport-security'] = `max-age=${t.AccessControlMaxAgeSec}${t.IncludeSubdomains ? '; includeSubDomains' : ''}${t.Preload ? '; preload' : ''}`;
  }
  if (s.ContentTypeOptions) h['x-content-type-options'] = 'nosniff';
  if (s.ReferrerPolicy) h['referrer-policy'] = s.ReferrerPolicy.ReferrerPolicy;
  if (s.FrameOptions) h['x-frame-options'] = s.FrameOptions.FrameOption;
  for (const i of cfg.CustomHeadersConfig?.Items ?? []) h[i.Header.toLowerCase()] = i.Value;
  return h;
}

/** CloudFront path patterns: case-sensitive, `*` any run of characters, `?` one character. */
function matches(pattern, path) {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return re.test(path);
}

function behaviorFor(d, path) {
  for (const b of d.config.CacheBehaviors?.Items ?? []) if (matches(b.PathPattern, path)) return b;
  return d.config.DefaultCacheBehavior;
}

// ── proxying ──────────────────────────────────────────────────────────────────────────────────
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);
const clientIp = (req) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
const appendXff = (h, ip) => (h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip);

function forward(req, res, target, o) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  Object.assign(headers, o.headers ?? {});
  for (const k of o.drop ?? []) delete headers[k];
  const started = Date.now();
  const up = http.request(
    { hostname: target.hostname, port: target.port, method: req.method, path: o.path, headers, timeout: 30_000 },
    (r) => {
      const out = {};
      for (const [k, v] of Object.entries(r.headers)) if (!HOP.has(k)) out[k] = v;
      Object.assign(out, o.responseHeaders ?? {});
      if (o.rewriteCsp && typeof out['content-security-policy'] === 'string') out['content-security-policy'] = o.rewriteCsp(out['content-security-policy']);
      res.writeHead(r.statusCode ?? 502, out);
      r.pipe(res);
      log({ ...o.log, method: req.method, url: req.url, status: r.statusCode, upstream: `${target.hostname}:${target.port}${o.path}`, ms: Date.now() - started, reqId: req.headers['x-request-id'] });
    },
  );
  up.on('timeout', () => up.destroy(new Error('origin read timeout')));
  up.on('error', (e) => {
    log({ ...o.log, method: req.method, url: req.url, status: 502, error: e.message });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html><body>502 Bad Gateway (edge shim)</body></html>');
  });
  req.pipe(up);
}

function viaHeaders(d) {
  return { via: `2.0 ${d.domain} (CloudFront)`, 'x-amz-cf-id': Math.random().toString(36).slice(2) };
}

function app(req, res) {
  const d = loadDistribution();
  if (!d) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('distribution not deployed yet');
    return;
  }
  const url = new URL(req.url ?? '/', `https://${APP_HOST}`);
  const b = behaviorFor(d, url.pathname);
  if (!b.AllowedMethods.Items.includes(req.method)) {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('403 method not allowed by this behavior');
    log({ behavior: b.PathPattern ?? 'Default (*)', method: req.method, url: req.url, status: 403 });
    return;
  }
  const origin = d.config.Origins.Items.find((o) => o.Id === b.TargetOriginId);
  const name = b.PathPattern ?? 'Default (*)';
  if (origin.S3OriginConfig) {
    // floci's data plane does this behavior; only the viewer-request function is ours to run.
    let uri = url.pathname;
    if ((b.FunctionAssociations?.Items ?? []).some((f) => f.EventType === 'viewer-request')) {
      uri = d.viewerRequest({ request: { uri, method: req.method, headers: {}, querystring: {} } }).uri;
    }
    // Test hook (never in CloudFront): the e2e suite's "suggested fix" runs set this cookie to try a CSP change
    // without redeploying the response headers policy (report Issue 1).
    const ttFix = /(?:^|;\s*)e2e-csp-fix=tt-allow-duplicates(?:;|$)/.test(String(req.headers.cookie ?? ''));
    forward(req, res, FLOCI, {
      path: `${uri}${url.search}`,
      ...(ttFix ? { rewriteCsp: (v) => v.replace(/trusted-types ([^;]+)/, "trusted-types $1 'allow-duplicates'") } : {}),
      headers: { host: d.domain, 'x-forwarded-for': appendXff(req.headers, clientIp(req)) },
      log: { behavior: name, origin: 'floci-cloudfront', rewrittenUri: uri !== url.pathname ? uri : undefined },
    });
    return;
  }
  // Custom origin (floci gap): what CloudFront would send.
  const c = origin.CustomOriginConfig;
  const lambdaUrl = origin.DomainName.includes('.lambda-url.');
  const target = lambdaUrl ? FLOCI : new URL(`http://${origin.DomainName}:${c.HTTPPort}`);
  const custom = Object.fromEntries((origin.CustomHeaders?.Items ?? []).map((h) => [h.HeaderName.toLowerCase(), h.HeaderValue]));
  const allViewer = Boolean(b.OriginRequestPolicyId); // AllViewerExceptHostHeader on /api/*
  const drop = allViewer ? [] : ['cookie', ...(req.method === 'GET' || req.method === 'HEAD' ? ['authorization'] : [])];
  forward(req, res, target, {
    path: `${origin.OriginPath ?? ''}${url.pathname}${url.search}`,
    headers: {
      host: lambdaUrl ? origin.DomainName : `${origin.DomainName}:${c.HTTPPort}`,
      'x-forwarded-for': appendXff(req.headers, clientIp(req)),
      'x-forwarded-proto': 'https',
      'cloudfront-forwarded-proto': 'https',
      // CloudFront overwrites a viewer-sent header of the same name with the origin custom header.
      ...custom,
      ...(allViewer ? {} : { 'user-agent': 'Amazon CloudFront' }),
    },
    drop,
    responseHeaders: { ...(b.ResponseHeadersPolicyId ? d.policies.get(b.ResponseHeadersPolicyId) : {}), ...viaHeaders(d) },
    log: { behavior: name, origin: origin.Id },
  });
}

function auth(req, res) {
  forward(req, res, KEYCLOAK, {
    path: req.url ?? '/',
    headers: {
      'x-forwarded-for': appendXff(req.headers, clientIp(req)),
      'x-forwarded-proto': 'https',
      'x-forwarded-host': AUTH_HOST,
      'x-forwarded-port': String(PUBLIC_PORT),
    },
    log: { behavior: 'auth', origin: 'keycloak' },
  });
}

const tls = { key: readFileSync(`${STATE}/certs/edge.key`), cert: readFileSync(`${STATE}/certs/edge.crt`) };
https
  .createServer(tls, (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
    if (host === APP_HOST) {
      try {
        return app(req, res);
      } catch (e) {
        log({ event: 'edge-error', url: req.url, error: String(e) });
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        return res.end('edge shim error');
      }
    }
    if (host === AUTH_HOST) return auth(req, res);
    res.writeHead(421, { 'content-type': 'text/plain' });
    res.end(`unknown host ${host}`);
  })
  .listen(8443, () => log({ event: 'listening', port: 8443 }));
// Plain HTTP → HTTPS (ViewerProtocolPolicy redirect-to-https).
http
  .createServer((req, res) => {
    res.writeHead(301, { location: `https://${String(req.headers.host ?? APP_HOST).replace(/:\d+$/, '')}${req.url}` });
    res.end();
  })
  .listen(8080);
