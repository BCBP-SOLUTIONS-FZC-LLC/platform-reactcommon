// Scenario 3b/3c: browser APIs the SDK relies on that differ between engines: Trusted Types (only
// enforced where the engine implements it, under the production CSP's require-trusted-types-for),
// BroadcastChannel and the storage event across tabs, and WebCrypto in a secure context.
import { expect, test } from './fixtures.ts';

/** Markup sanitizeHtml keeps or rewrites without anything the CSP would object to while parsing. */
const BENIGN =
  '<p>Hello <b>world</b> <a href="https://example.com/x" target="_blank">good</a> <a href="javascript:alert(1)">bad</a>' +
  '<script>alert(1)</script><iframe src="https://example.com"></iframe></p>';
/** The attributes the CSP forbids inline: event handlers and style. */
const HOSTILE = '<p onclick="steal()">Hello <span style="color:red">styled</span></p>';

test('sanitizeHtml returns TrustedHTML where Trusted Types exist, a string elsewhere, and innerHTML takes it', async ({ openHarness, browserName }) => {
  const page = await openHarness();
  const hasTrustedTypes = await page.evaluate(() => typeof (window as { trustedTypes?: unknown }).trustedTypes === 'object');
  test.info().annotations.push({ type: 'Trusted Types', description: `${browserName}: ${hasTrustedTypes ? 'implemented (enforced by the CSP)' : 'not implemented'}` });
  // Chromium has enforced Trusted Types since 83; Gecko and WebKit are checked as they are.
  if (browserName === 'chromium') expect(hasTrustedTypes).toBe(true);

  const r = await page.evaluate((d) => window.harness.sanitize(d), BENIGN);
  if (hasTrustedTypes) expect(r).toMatchObject({ type: 'object', isTrustedHTML: true });
  else expect(r).toMatchObject({ type: 'string', isTrustedHTML: false });
  expect(r.html).toBe('<p>Hello <b>world</b> <a href="https://example.com/x" rel="noopener noreferrer">good</a> <a>bad</a></p>');
  // The guard then asserts there was no CSP (Trusted Types) violation.
});

// Chromium applies the page CSP while DOMPurify parses hostile input, and once reported (and POSTed to
// /csp-report) every handler and style attribute in it; sanitizeHtml's pre-pass removes them first
// (security/markup.ts). The guard also fails the test on any violation or report.
test('sanitizeHtml of input with inline handlers and styles reports no CSP violation', async ({ openHarness }) => {
  const page = await openHarness();
  const r = await page.evaluate((d) => window.harness.sanitize(d), HOSTILE);
  expect(r.html).toBe('<p>Hello <span>styled</span></p>');
  await new Promise((resolve) => setTimeout(resolve, 300)); // violation events are dispatched in a later task
  expect(await page.evaluate(() => (window as unknown as { __violations: unknown[] }).__violations)).toEqual([]);
});

test('BroadcastChannel platform-auth reaches another tab of the same context', async ({ openHarness, context }) => {
  // The SDK's 'platform-auth' channel (auth/oidc.ts) carries logout and workspace switches between
  // tabs; acting on them needs a signed-in session (Keycloak). This checks the transport itself.
  const a = await openHarness();
  const b = await openHarness({ page: await context.newPage() });
  expect(await b.evaluate(() => window.harness.openChannel('platform-auth'))).toBe(true);
  await a.evaluate(() => window.harness.post('platform-auth', { type: 'logout' }));
  await expect.poll(() => b.evaluate(() => window.harness.received('platform-auth'))).toEqual([{ type: 'logout' }]);
  // A tab never receives its own messages.
  expect(await a.evaluate(() => window.harness.received('platform-auth'))).toEqual([]);
});

test('per-workspace storage written in one tab is read, and announced, in another', async ({ openHarness, context, browserName }) => {
  const a = await openHarness();
  const b = await openHarness({ page: await context.newPage() });
  await a.evaluate(() => window.harness.storageSet('tenant-acme', 'filters', { status: 'open' }));
  // Another page of the origin sees the write once the engine has propagated it: at once in Chromium and
  // Firefox, a moment later in WebKit (CI's 2-core runners showed it), so the read polls.
  await expect.poll(() => b.evaluate(() => window.harness.storageGet('tenant-acme', 'filters'))).toEqual({ status: 'open' });
  // Another workspace's namespace sees nothing.
  expect(await b.evaluate(() => window.harness.storageGet('tenant-other', 'filters'))).toBeUndefined();
  test.skip(
    browserName === 'webkit',
    "Playwright's WebKit dispatches no storage event between pages of one context (a plain localStorage.setItem in one page fires none in the other); Safari does",
  );
  await expect.poll(() => b.evaluate(() => window.harness.storageEvents())).toContainEqual({ key: 'tenant-acme:harness:filters', newValue: '{"status":"open"}' });
});

test('crypto.subtle SHA-256 is available in the secure context (PKCE S256)', async ({ openHarness }) => {
  const page = await openHarness();
  const r = await page.evaluate(() => window.harness.sha256('abc'));
  expect(r).toEqual({ isSecureContext: true, hasSubtle: true, hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
});
