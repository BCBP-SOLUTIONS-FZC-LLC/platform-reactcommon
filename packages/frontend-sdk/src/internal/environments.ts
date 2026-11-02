// Environments that run on a developer's machine or in CI against local servers. Pages there may
// talk to http servers on a local host (/config) and load a remote without an integrity hash (/mfe);
// staging, prod and any other environment never do. Before initializeCore the environment is
// unknown, and the stricter rule applies.
export const LOCAL_ENVIRONMENTS: ReadonlySet<string> = new Set(['local', 'dev', 'test']);

export function isLocalEnvironment(environment: string | undefined): boolean {
  return environment !== undefined && LOCAL_ENVIRONMENTS.has(environment);
}
