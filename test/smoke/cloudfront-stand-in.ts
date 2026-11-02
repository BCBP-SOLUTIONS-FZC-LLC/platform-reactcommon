// An in-process stand-in for the web distribution (examples/cloudfront/README.md "Behaviors"), used by
// the smoke suite when SMOKE_BASE_URL is unset. It serves the built examples the way the deploy lays
// them out in S3 and the distribution's behaviors answer for them:
//   /api/*                   the gateway: 404 application/problem+json, never rewritten, no headers policy
//   /config/runtime.json     examples/shell/dist/config/runtime.json, no-cache
//   /version.json            deploy step 4: { "version": <shell package version> } (dist's own, if built)
//   /remotes/manifest.json   deploy step 2: the tenders entry, with its SRI hash, no-cache
//   /remotes/tenders/<v>/…   deploy step 1: examples/remote-tenders/dist, immutable
//   Default (*)              examples/shell/dist through spa-rewrite.js (the real CloudFront Function)
// and every behavior except /api/* carries securityHeaders() from examples/cloudfront/csp.mjs.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
// @ts-expect-error plain JS module
import { securityHeaders } from '../../examples/cloudfront/csp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
export const SHELL_DIST = join(ROOT, 'examples/shell/dist');
export const REMOTE_DIST = join(ROOT, 'examples/remote-tenders/dist');
const CLOUDFRONT = join(ROOT, 'examples/cloudfront');

const version = (dir: string) => (JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as { version: string }).version;
export const REMOTE_VERSION = version('examples/remote-tenders');
const SHELL_VERSION = version('examples/shell');

/** The built examples this stand-in needs; empty when everything is there. */
export function missingBuildOutputs(): string[] {
  return [join(SHELL_DIST, 'index.html'), join(SHELL_DIST, 'config/runtime.json'), join(REMOTE_DIST, 'remoteEntry.js')].filter((f) => !existsSync(f));
}

type Rewrite = (event: { request: { uri: string; headers: object } }) => { uri: string };

/** spa-rewrite.js is a CloudFront Function (a script, no exports): run it as CloudFront does. */
function loadSpaRewrite(): Rewrite {
  const ctx: { handler?: Rewrite } = {};
  runInNewContext(`${readFileSync(join(CLOUDFRONT, 'spa-rewrite.js'), 'utf8')}\nthis.handler = handler;`, ctx);
  return ctx.handler!;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const NO_CACHE = 'no-cache';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** `rel` (already URL-decoded) under `dir`, or undefined when it escapes `dir` or is not a file. */
function fileUnder(dir: string, rel: string): string | undefined {
  const file = normalize(join(dir, rel));
  if (file !== dir && !file.startsWith(dir + sep)) return undefined;
  return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

/** /remotes/manifest.json as deploy step 2 writes it for the example remote. */
export function buildManifest(): Record<string, { entry: string; version: string; ownerDomain: string; integrity: string }> {
  const entry = readFileSync(join(REMOTE_DIST, 'remoteEntry.js'));
  return {
    tenders: {
      entry: `/remotes/tenders/${REMOTE_VERSION}/remoteEntry.js`,
      version: REMOTE_VERSION,
      ownerDomain: 'tender_management',
      integrity: `sha384-${createHash('sha384').update(entry).digest('base64')}`,
    },
  };
}

function versionJson(): string {
  const built = join(SHELL_DIST, 'version.json');
  return existsSync(built) ? readFileSync(built, 'utf8') : JSON.stringify({ version: SHELL_VERSION });
}

/** Starts the stand-in on an ephemeral 127.0.0.1 port; resolves to its base URL and a close function. */
export async function startCloudFrontStandIn(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const rewrite = loadSpaRewrite();
  const headers = securityHeaders() as Record<string, string>;
  const manifest = JSON.stringify(buildManifest());

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, cache?: string, extra: Record<string, string> = headers) => {
    res.writeHead(status, { ...extra, 'Content-Type': type, ...(cache ? { 'Cache-Control': cache } : {}) });
    res.end(body);
  };
  const sendFile = (res: ServerResponse, file: string | undefined, cache: string) => {
    // S3 behind OAC answers a missing key with 403 AccessDenied (no ListBucket), as XML.
    if (!file) return send(res, 403, 'application/xml', '<Error><Code>AccessDenied</Code></Error>');
    send(res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file), cache);
  };

  const server: Server = createServer((req, res) => {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://stand-in').pathname);
    } catch {
      return send(res, 400, 'text/plain', 'bad request');
    }
    if (path === '/api' || path.startsWith('/api/')) {
      const problem = { type: 'about:blank', title: 'Not Found', status: 404, detail: `no route for ${path}` };
      return send(res, 404, 'application/problem+json', JSON.stringify(problem), undefined, {});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method not allowed');
    if (path === '/config/runtime.json') return sendFile(res, fileUnder(SHELL_DIST, 'config/runtime.json'), NO_CACHE);
    if (path === '/version.json') return send(res, 200, TYPES['.json']!, versionJson(), NO_CACHE);
    if (path === '/remotes/manifest.json') return send(res, 200, TYPES['.json']!, manifest, NO_CACHE);
    const remote = /^\/remotes\/tenders\/([^/]+)\/(.+)$/.exec(path);
    if (remote) return sendFile(res, remote[1] === REMOTE_VERSION ? fileUnder(REMOTE_DIST, remote[2]!) : undefined, IMMUTABLE);
    if (path.startsWith('/remotes/')) return sendFile(res, undefined, IMMUTABLE);
    const uri = rewrite({ request: { uri: path, headers: {} } }).uri;
    // Default (*): no-cache for everything, as the README's behavior table has it.
    sendFile(res, fileUnder(SHELL_DIST, uri.slice(1)), NO_CACHE);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
