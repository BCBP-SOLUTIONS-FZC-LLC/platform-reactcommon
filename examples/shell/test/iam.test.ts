// Contract #18 (design doc §C5): the shell's PUB-1 and P-35 ports against the SDK's contract cases,
// which sync-contracts checks against iam-org-membership's swagger. Run through the real ApiClient.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestPlatform, mockApi } from '@platform/frontend-sdk/testing';
import { sessionContextSource, workspaceResolver } from '../src/iam';

interface Cases<C> {
  path: string;
  cases: C[];
}
const contract = <C>(name: string): Cases<C> =>
  JSON.parse(readFileSync(new URL(`../../../packages/frontend-sdk/contracts/${name}`, import.meta.url), 'utf8')) as Cases<C>;
const RESOLVE = contract<{ name: string; identifier: string; response: unknown; expected: unknown }>('tenant-resolve-cases.json');
const SESSION = contract<{ name: string; response: unknown; expected: unknown }>('session-context-cases.json');

let platform: ReturnType<typeof createTestPlatform>;
beforeEach(() => {
  platform = createTestPlatform();
});
afterEach(() => platform.reset());

describe('workspaceResolver (PUB-1)', () => {
  it('calls the contract path on the API base, with no token', () => {
    expect(RESOLVE.path).toBe('/api/v1/public/tenants/resolve');
  });

  it.each(RESOLVE.cases.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    let seen: Request | undefined;
    mockApi({
      'GET /v1/public/tenants/resolve': (req) => {
        seen = req;
        return Response.json(c.response);
      },
    });
    expect((await workspaceResolver.resolve(c.identifier)) ?? null).toEqual(c.expected);
    expect(new URL(seen!.url).searchParams.get('identifier')).toBe(c.identifier);
    expect(seen!.headers.get('authorization')).toBeNull();
  });
});

describe('sessionContextSource (P-35)', () => {
  it('calls the contract path', () => {
    expect(SESSION.path).toBe('/api/v1/me/session-context');
  });

  it.each(SESSION.cases.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    mockApi({ 'GET /v1/me/session-context': Response.json(c.response) });
    expect(await sessionContextSource.load()).toEqual(c.expected);
  });

  it('a 404 MEMBER_NOT_FOUND is a ProblemError the shell can handle', async () => {
    mockApi({});
    await expect(sessionContextSource.load()).rejects.toMatchObject({ status: 404 });
  });
});
