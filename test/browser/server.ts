// The real-browser suite's server (test/browser/README.md): one server on 127.0.0.1 that serves the
// harness page with the PRODUCTION response headers (examples/cloudfront/csp.mjs), the runtime
// config, OTLP collectors that record every request, /api/* test endpoints and /csp-report.
//
// It speaks HTTPS (node:https, a throwaway self-signed certificate made with openssl, which the
// browsers are told to accept): the production CSP has `upgrade-insecure-requests`, and WebKit
// upgrades even http://127.0.0.1 subresources under it, so over plain HTTP the page could not load
// its own script without weakening the policy. Over HTTPS the headers are served exactly as deployed.
//
// Every test runs in its own "run": the harness tags what the page sends with `run=<id>` (taken from
// the page URL, /?run=<id>), and CSP reports carry the document URL, so tests in parallel workers
// and browsers never see each other's requests. Tests read a run with GET /__collected?run=<id>.
//
// Started by test/browser/global-setup.ts; `pnpm exec tsx test/browser/server.ts` runs it standalone
// (BROWSER_TEST_PORT, default ephemeral).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { build } from 'esbuild';
// @ts-expect-error plain JS module
import { securityHeaders } from '../../examples/cloudfront/csp.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const HERE = import.meta.dirname;
export const BUILD_DIR = join(HERE, '.build');

/** One request to /otel/v1/<signal>, as the collector saw it. */
export interface CollectedRequest {
  signal: 'traces' | 'logs' | 'metrics';
  /** Order of arrival on this server (all runs), and when the request started and its body ended. */
  seq: number;
  receivedAt: number;
  completedAt: number;
  bytes: number;
  contentType: string;
  /** How the page sent it, as tagged by the harness: 'beacon', 'keepalive' (fetch) or 'fetch'. */
  via: string;
  /** Decoded OTLP JSON, or undefined when the body is not JSON. */
  json: unknown;
}

/** One lifecycle event the harness recorded in the page. */
export interface PageEvent {
  type: string;
  visibilityState: string;
  persisted?: boolean;
  t: number;
}

/** The lifecycle events of one document (one page load). */
export interface PageEventLog {
  pageId: string;
  url: string;
  events: PageEvent[];
}

export interface RunLog {
  requests: CollectedRequest[];
  /** Per document: the longest event list it reported (each beacon carries the whole list so far). */
  pages: PageEventLog[];
  /** securitypolicyviolation events the page reported, and the browser's own /csp-report reports. */
  violations: unknown[];
  cspReports: unknown[];
}

/** /config/runtime.json: every trace sampled, debug logs, same-origin collector and API. */
export const RUNTIME_CONFIG = {
  api: { baseUrl: '/api', timeoutMs: 35_000 },
  telemetry: { otlpBaseUrl: '/otel', sampleRatio: 1, logLevel: 'debug' },
  auth: { idleTimeoutMs: 1_800_000, redirectPath: '/auth/callback' },
  flags: {},
  remotes: { loadTimeoutMs: 10_000, retries: 0 },
  i18n: { defaultLocale: 'en', supportedLocales: ['en'] },
  appUpdate: { pollIntervalMs: 300_000 },
};

const sdkVersion = (JSON.parse(readFileSync(join(ROOT, 'packages/frontend-sdk/package.json'), 'utf8')) as { version: string }).version;

/**
 * Bundles test/browser/harness/entry.ts (the SDK from source) into .build/harness.js: one IIFE,
 * es2022, __SDK_VERSION__ defined as vitest.config.ts does. esbuild emits no eval.
 */
export async function buildHarness(): Promise<string> {
  const outfile = join(BUILD_DIR, 'harness.js');
  await build({
    entryPoints: [join(HERE, 'harness/entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    outfile,
    sourcemap: 'linked',
    define: { __SDK_VERSION__: JSON.stringify(sdkVersion) },
    logLevel: 'warning',
    legalComments: 'none',
  });
  return outfile;
}

/** A self-signed certificate for 127.0.0.1 in .build/ (made once with openssl; valid 30 days). */
export function certificate(): { key: Buffer; cert: Buffer } {
  const key = join(BUILD_DIR, 'tls-key.pem');
  const cert = join(BUILD_DIR, 'tls-cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(BUILD_DIR, { recursive: true });
    // prettier-ignore
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The run a CSP report belongs to, from the document URL it carries. */
function runOfReport(report: unknown): string | undefined {
  const text = JSON.stringify(report);
  return /[?&]run=([A-Za-z0-9-]+)/.exec(text)?.[1];
}

export interface BrowserTestServer {
  url: string;
  server: Server;
  /** Every CSP report received, whatever its run (asserted empty at the end of the suite). */
  allCspReports: unknown[];
  close(): Promise<void>;
}

/** Starts the server on 127.0.0.1:`port` (0: ephemeral) after bundling the harness. */
export async function startServer(port = Number(process.env.BROWSER_TEST_PORT ?? 0)): Promise<BrowserTestServer> {
  const harnessFile = await buildHarness();
  const harnessJs = readFileSync(harnessFile);
  const harnessMap = readFileSync(`${harnessFile}.map`);
  const indexHtml = readFileSync(join(HERE, 'harness/index.html'));
  const headers: Record<string, string> = securityHeaders();

  const runs = new Map<string, RunLog>();
  const allCspReports: unknown[] = [];
  let seq = 0;
  const runOf = (id: string | null | undefined): RunLog | undefined => {
    if (!id) return undefined;
    let r = runs.get(id);
    if (!r) runs.set(id, (r = { requests: [], pages: [], violations: [], cspReports: [] }));
    return r;
  };

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) =>
    send(res, status, 'application/json', JSON.stringify(value), extra);
  /** Static documents and scripts: the distribution's headers policy (every behavior except /api/*). */
  const page = (res: ServerResponse, type: string, body: Buffer | string) => send(res, 200, type, body, headers);

  const server = createServer(certificate(), (req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(e) });
      else res.destroy();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const receivedAt = Date.now();
    const url = new URL(req.url ?? '/', 'https://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // --- the page --------------------------------------------------------------------------------
    if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/other.html')) return page(res, 'text/html; charset=utf-8', indexHtml);
    if (method === 'GET' && path === '/harness.js') return page(res, 'text/javascript; charset=utf-8', harnessJs);
    if (method === 'GET' && path === '/harness.js.map') return page(res, 'application/json', harnessMap);
    if (method === 'GET' && path === '/favicon.ico') return send(res, 204, 'image/x-icon', '', headers);
    if (method === 'GET' && path === '/config/runtime.json') return json(res, 200, RUNTIME_CONFIG, { ...headers, 'cache-control': 'no-cache' });

    // --- OTLP collectors -------------------------------------------------------------------------
    const otel = /^\/otel\/v1\/(traces|logs|metrics)$/.exec(path);
    if (otel && method === 'POST') {
      const s = seq++;
      const body = await readBody(req);
      runOf(url.searchParams.get('run'))?.requests.push({
        signal: otel[1] as CollectedRequest['signal'],
        seq: s,
        receivedAt,
        completedAt: Date.now(),
        bytes: body.byteLength,
        contentType: req.headers['content-type'] ?? '',
        via: url.searchParams.get('via') ?? 'untagged',
        json: parseJson(body),
      });
      return json(res, 200, {});
    }

    // --- what the harness reports ----------------------------------------------------------------
    if (method === 'POST' && path === '/__events') {
      const log = parseJson(await readBody(req)) as PageEventLog | undefined;
      const r = runOf(url.searchParams.get('run'));
      if (r && log?.pageId) {
        const i = r.pages.findIndex((p) => p.pageId === log.pageId);
        if (i < 0) r.pages.push(log);
        else if (log.events.length > r.pages[i]!.events.length) r.pages[i] = log;
      }
      return send(res, 204, 'text/plain', '');
    }
    if (method === 'POST' && path === '/__violation') {
      runOf(url.searchParams.get('run'))?.violations.push(parseJson(await readBody(req)));
      return send(res, 204, 'text/plain', '');
    }
    if (method === 'POST' && path === '/csp-report') {
      const report = parseJson(await readBody(req));
      allCspReports.push(report);
      runOf(runOfReport(report))?.cspReports.push(report);
      return send(res, 204, 'text/plain', '');
    }
    if (method === 'GET' && path === '/__collected') return json(res, 200, runOf(url.searchParams.get('run')) ?? null);
    if (method === 'POST' && path === '/__reset') {
      runs.delete(url.searchParams.get('run') ?? '');
      return send(res, 204, 'text/plain', '');
    }

    // --- /api/*: the gateway (no headers policy) --------------------------------------------------
    if (path.startsWith('/api/')) return api(req, res, url, path.slice('/api'.length));

    return json(res, 404, { error: 'not found' });
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL, route: string): Promise<void> {
    const ms = Math.min(Number(url.searchParams.get('ms') ?? 0), 30_000);
    await readBody(req);
    switch (route) {
      case '/ok':
        return json(res, 200, { ok: true });
      case '/slow':
        await sleep(ms);
        return json(res, 200, { ok: true, waited: ms });
      case '/hang':
        // Headers never come; the client gives up (timeout or abort) and the socket closes.
        req.socket.setTimeout(0);
        return new Promise<void>((resolve) => res.on('close', resolve));
      case '/slow-body': {
        // Headers and the first bytes at once, the rest after `ms`: an abort lands during the body read.
        // 4 KiB of leading whitespace (valid JSON) first: WebKit holds the response back until it has
        // enough bytes to sniff, so with fewer the fetch itself would still be pending.
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.write(`${' '.repeat(4096)}{"part":"`);
        res.flushHeaders();
        await sleep(ms);
        if (!res.destroyed) res.end('done"}');
        return;
      }
      case '/problem':
        return send(
          res,
          400,
          'application/problem+json',
          JSON.stringify({ type: 'about:blank', title: 'Bad Request', status: 400, detail: 'bad input', code: 'VALIDATION_FAILED' }),
        );
      case '/echo-headers':
        return json(res, 200, { headers: req.headers });
      default:
        return send(res, 404, 'application/problem+json', JSON.stringify({ type: 'about:blank', title: 'Not Found', status: 404 }));
    }
  }

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${actual}`,
    server,
    allCspReports,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

if (process.argv[1] === import.meta.filename) {
  const s = await startServer();
  console.log(`browser test server on ${s.url}`);
}
