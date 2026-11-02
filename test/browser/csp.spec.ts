// Scenario 4: the SDK under the production CSP (examples/cloudfront/csp.mjs): booting core, config,
// tracing, logging, metrics, http and security, and using them, causes no violation and never
// builds code from strings (Zod runs jitless: config/schema.ts). jsdom and happy-dom enforce no CSP.
// Two controls prove, per engine, that the detectors used here (and by every test's guard) work.
import { expect, test } from './fixtures.ts';
// @ts-expect-error plain JS module
import { buildCsp, securityHeaders } from '../../examples/cloudfront/csp.mjs';

const evalCalls = (page: import('@playwright/test').Page) => page.evaluate(() => (window as unknown as { __evalCalls: string[] }).__evalCalls);

test('the page is served with the production security headers', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/?run=headers`);
  expect(res.headers()['content-security-policy']).toBe(buildCsp());
  for (const [name, value] of Object.entries(securityHeaders() as Record<string, string>)) expect(res.headers()[name.toLowerCase()]).toBe(value);
});

test('booting and using every signal under the production CSP: no violation, no eval', async ({ openHarness, collected }) => {
  const page = await openHarness(); // boot: Trusted Types policy, core, runtime config (Zod), consent, tracing, logging, metrics
  await page.evaluate(async () => {
    const h = window.harness;
    h.spans(5, 300);
    h.logs(5, 200);
    h.count(3);
    await h.http('ok');
    await h.http('echo-headers');
    await h.sanitize('<p>hi <a href="/x">x</a></p>');
    // Everything queued goes out now (as on a tab switch): the collector requests are checked against connect-src.
    h.setVisibility('hidden');
    h.setVisibility('visible');
  });
  await expect.poll(async () => new Set((await collected()).requests.map((r) => r.signal)), { timeout: 10_000 }).toEqual(new Set(['traces', 'logs', 'metrics']));
  expect(await evalCalls(page)).toEqual([]);
  expect(await page.evaluate(() => window.harness.errors())).toEqual([]);
  // The guard asserts: no securitypolicyviolation in the page, none reported to /csp-report, no console error.
});

test.describe('detector controls', () => {
  // These provoke the violations the suite must catch; their run ids are excluded from the
  // end-of-run /csp-report check, and their own violations are asserted here instead.
  test.use({ expectViolations: true, allowedErrors: /Content.Security.Policy|Trusted ?(Type|Script|HTML)|unsafe-eval|EvalError|call to Function\(\)|eval\(\)/i });

  test('building a function from a string is blocked and reported', async ({ openHarness }) => {
    const page = await openHarness({ boot: false });
    expect(await page.evaluate(() => window.harness.tryEval())).toMatchObject({ threw: true, error: 'EvalError' });
    expect(await evalCalls(page)).toEqual(['new Function']);
    // Where Trusted Types exist the string-to-code check reports first (trusted-types-sink); script-src
    // 'self' may report too (blockedURI 'eval'). Either proves the page saw the attempt.
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __violations: { effective: string; blockedURI: string }[] }).__violations))
      .toContainEqual(expect.objectContaining({ blockedURI: expect.stringMatching(/^(eval|trusted-types-sink)$/) }));
  });

  test('assigning a plain string to innerHTML is blocked where Trusted Types exist', async ({ openHarness }) => {
    const page = await openHarness({ boot: false });
    const hasTrustedTypes = await page.evaluate(() => typeof (window as { trustedTypes?: unknown }).trustedTypes === 'object');
    const r = await page.evaluate(() => window.harness.assignRawHtml());
    if (!hasTrustedTypes) {
      expect(r).toMatchObject({ threw: false, html: '<b>raw</b>' });
      return;
    }
    expect(r).toMatchObject({ threw: true, error: 'TypeError' });
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __violations: { effective: string }[] }).__violations))
      .toEqual([expect.objectContaining({ effective: 'require-trusted-types-for' })]);
  });
});
