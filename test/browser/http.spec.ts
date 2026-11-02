// Scenario 3a: the /http client's deadline and abort handling in real engines, with the native
// AbortSignal.any and without it (Safari < 17.4 has none; http/client.ts anySignal then combines the
// signals by hand). Real fetch aborts, real timeouts, real body streams and a real garbage collector:
// jsdom and happy-dom model none of the timing, stream errors or signal lifetimes involved.
import { expect, test } from './fixtures.ts';
import { WEBKIT_ABORT_ANY } from './known-bugs.ts';
import type { HttpScenario } from './harness/entry.ts';

for (const variant of ['native AbortSignal.any', 'without AbortSignal.any (Safari < 17.4)'] as const) {
  test.describe(variant, () => {
    const withoutAny = variant.startsWith('without');
    // A 400 problem response is a failed resource load to Chromium's console: expected for that call.
    test.use({ allowedErrors: /Failed to load resource: the server responded with a status of 400/ });

    test.beforeEach(async ({ context }) => {
      if (withoutAny) await context.addInitScript(() => void delete (AbortSignal as { any?: unknown }).any);
    });

    test('success, problem and the client deadline (before and during the body) map to the SDK results', async ({ openHarness }) => {
      const page = await openHarness();
      expect(await page.evaluate(() => typeof AbortSignal.any)).toBe(withoutAny ? 'undefined' : 'function');
      const run = (s: HttpScenario) => page.evaluate((x) => window.harness.http(x), s);

      expect(await run('ok')).toMatchObject({ ok: true, status: 200, data: { ok: true } });
      expect(await run('problem')).toMatchObject({ ok: false, error: 'ProblemError', status: 400 });
      const timeout = await run('timeout');
      expect(timeout).toMatchObject({ ok: false, error: 'TimeoutError' });
      expect(timeout.ms).toBeGreaterThanOrEqual(350);
      // The response has started (headers and the first bytes); the rest would come after 2 s.
      const bodyTimeout = await run('timeout-body');
      expect(bodyTimeout).toMatchObject({ ok: false, error: 'TimeoutError' });
      expect(bodyTimeout.ms).toBeLessThan(1_500);

      // The SDK's correlation headers on a same-origin call; never an identity header or a token here.
      const echo = await run('echo-headers');
      const headers = (echo.data as { headers: Record<string, string> }).headers;
      expect(headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      expect(headers.authorization).toBeUndefined();
    });

    test('a caller abort (before the response, during the body) and the deadline next to a caller signal end the call, under GC pressure', async ({ openHarness, browserName }) => {
      test.fail(browserName === 'webkit' && !withoutAny, WEBKIT_ABORT_ANY);
      const page = await openHarness();
      const results: Record<string, string[]> = {};
      for (const s of ['abort', 'abort-get', 'abort-body', 'timeout-with-signal'] as const) {
        for (let i = 0; i < 3; i++) {
          const r = await page.evaluate((x) => window.harness.http(x, { gc: true }), s);
          (results[s] ??= []).push(`${r.error ?? 'ok'}@${r.ms}`);
        }
      }
      test.info().annotations.push({ type: 'outcomes', description: JSON.stringify(results) });
      for (const s of ['abort', 'abort-get', 'abort-body']) for (const r of results[s]!) expect(r, s).toMatch(/^AbortedError@\d+$/);
      for (const r of results['timeout-with-signal']!) expect(r, 'timeout-with-signal').toMatch(/^TimeoutError@\d+$/);
    });

    test('a long-lived caller signal keeps no listener once its calls have reached their deadlines', async ({ openHarness }) => {
      const page = await openHarness();
      const r = await page.evaluate(() => window.harness.signalListeners(25, 500));
      test.info().annotations.push({ type: 'abort listeners on the caller signal', description: `right after 25 calls: ${r.afterSettle}; after their deadlines: ${r.afterDeadline}` });
      expect(r.ok).toBe(true);
      expect(r.hasAny).toBe(!withoutAny);
      // Native: the engine combines the signals; the SDK adds no listener to the caller's signal.
      if (!withoutAny) expect(r.afterSettle).toBe(0);
      // Fallback: one listener per call stays until that call's deadline fires (then it is removed),
      // so a long-lived signal holds at most the calls of one deadline window, never more.
      expect(r.afterSettle).toBeLessThanOrEqual(25);
      expect(r.afterDeadline).toBe(0);
    });
  });
}
