// Bundles the harness and starts test/browser/server.ts on an ephemeral 127.0.0.1 port (or
// BROWSER_TEST_PORT) for the whole run; the workers read its URL from BROWSER_BASE_URL. At the end,
// any CSP report the browsers sent to /csp-report fails the run, except from the runs of the
// detector controls that provoke one on purpose (their run ids start with EXPECTED_VIOLATION_PREFIX).
import { EXPECTED_VIOLATION_PREFIX } from './otlp.ts';
import { startServer } from './server.ts';

export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startServer();
  process.env.BROWSER_BASE_URL = server.url;
  return async () => {
    await server.close();
    const unexpected = server.allCspReports.filter((r) => !JSON.stringify(r).includes(`run=${EXPECTED_VIOLATION_PREFIX}`));
    if (unexpected.length > 0) throw new Error(`CSP reports received at /csp-report:\n${JSON.stringify(unexpected, null, 2)}`);
  };
}
