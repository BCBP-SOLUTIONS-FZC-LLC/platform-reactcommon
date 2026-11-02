// @vitest-environment happy-dom
// /http, /problem, /logging and /react wired together: a gincommon problem+json answer becomes a
// ProblemError joined to its request by request_id, and a gateway DENY_TENANT_READ_ONLY puts the
// page in the read-only state the hooks report.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionContext } from '../../packages/frontend-sdk/src/auth/index.ts';
import { createApiClient } from '../../packages/frontend-sdk/src/http/index.ts';
import { getFlag, sessionContextFlagProvider, setFlagProvider } from '../../packages/frontend-sdk/src/flags/index.ts';
import { getLogger } from '../../packages/frontend-sdk/src/logging/index.ts';
import { PlatformProblemTypes, isProblemError, toFieldErrorMap, type ProblemError } from '../../packages/frontend-sdk/src/problem/index.ts';
import { MFEErrorBoundary, PlatformProvider, useApi, useFeatureFlag, useReadOnly } from '../../packages/frontend-sdk/src/react/index.ts';
import { mockProblem } from '../../packages/frontend-sdk/src/testing/index.ts';
import { ACME, World, endWorld, useFakeClock } from '../fixtures/boot.ts';
import { cleanup, render } from '../fixtures/render.tsx';
import { unloadTelemetry } from '../fixtures/telemetry.ts';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const CONTEXT: SessionContext = { tenantId: 't-1', slug: 'acme', roles: ['preparator'], departments: [], featureFlags: [], readOnly: false };

/** Answers like gincommon: the problem body, and X-Request-ID echoed. */
const answer = (res: Response) => (req: Request) => {
  res.headers.set('x-request-id', req.headers.get('x-request-id') ?? '');
  return res;
};

/** Lets effects, fetches and re-renders finish on the fake clock. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await new Promise((r) => setImmediate(r));
    }
  });

let w: World;

beforeEach(async () => {
  useFakeClock();
  w = new World('/t/acme/');
  await w.signIn();
});

afterEach(async () => {
  await cleanup();
  await endWorld();
});

describe('problem+json', () => {
  it('becomes a ProblemError with the request id it was sent with, and an error log joined on it', async () => {
    w.net.on(
      'POST /api/tenders',
      answer(
        mockProblem(PlatformProblemTypes.ValidationFailed, {
          traceId: TRACE_ID,
          validationErrors: [{ field: 'title', message: 'must not be empty', code: 'required' }],
        }),
      ),
    );
    const err = (await createApiClient()
      .post('/tenders', { body: { title: '' } })
      .catch((e: unknown) => e)) as ProblemError;

    expect(isProblemError(err)).toBe(true);
    expect(err.is(PlatformProblemTypes.ValidationFailed)).toBe(true);
    expect([err.status, err.errorCode, err.traceId, err.synthetic]).toEqual([PlatformProblemTypes.ValidationFailed.status, PlatformProblemTypes.ValidationFailed.code, TRACE_ID, false]);
    const [req] = w.net.sent('/api/tenders');
    expect(err.requestId).toBe(req!.headers.get('x-request-id'));
    expect(toFieldErrorMap(err)).toEqual({ title: ['must not be empty'] });

    getLogger().error('saving the tender failed', { error: err, request_id: err.requestId, status: err.status });
    await unloadTelemetry();
    expect(w.collector.logs.find((l) => l.body === 'saving the tender failed')?.attributes).toMatchObject({
      request_id: err.requestId,
      status: err.status,
      'exception.type': 'ProblemError',
      'exception.message': err.message,
    });
    const span = w.collector.spans.find((s) => s.name === 'HTTP POST')!;
    expect(span.attributes['http.response.status_code']).toBe(err.status);
  });

  it('a remote that throws an API error is logged by its boundary with that request_id', async () => {
    w.net.on('GET /api/tenders/:id', answer(mockProblem(PlatformProblemTypes.NotFound)));
    function Tender() {
      const { error } = useApi((api, signal) => api.get('/tenders/:id', { params: { id: '9' }, signal }), []);
      if (error) throw error;
      return null;
    }
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the caught render error
    const { container } = await render(
      <MFEErrorBoundary mfe="tenders">
        <Tender />
      </MFEErrorBoundary>,
    );
    await settle();
    const requestId = w.net.sent('/api/tenders/9')[0]!.headers.get('x-request-id');
    expect(container.textContent).toContain(requestId); // the fallback shows it
    await unloadTelemetry();
    expect(w.collector.logs.find((l) => l.body === 'remote showed an error')?.attributes).toMatchObject({ mfe: 'tenders', request_id: requestId });
  });
});

describe('DENY_TENANT_READ_ONLY', () => {
  it('puts the page in the read-only state: useReadOnly flips; the read_only flag keeps the session context value', async () => {
    setFlagProvider(sessionContextFlagProvider(CONTEXT));
    w.net.on(
      'PUT /api/tenders/:id',
      answer(mockProblem(PlatformProblemTypes.Forbidden, { errorCode: 'DENY_TENANT_READ_ONLY', detail: 'The workspace is read-only.' })),
    );
    function Toolbar() {
      return <p>{`readOnly=${useReadOnly()} flag=${useFeatureFlag('read_only', false)}`}</p>;
    }
    const shell = { user: { sub: 'user-1' }, workspace: ACME, context: CONTEXT, locale: 'en', switchWorkspace: async () => {} };
    const { container } = await render(
      <PlatformProvider shell={shell}>
        <Toolbar />
      </PlatformProvider>,
    );
    expect(container.textContent).toBe('readOnly=false flag=false');

    let err: unknown;
    await act(async () => {
      err = await createApiClient()
        .put('/tenders/:id', { params: { id: '1' }, body: { title: 'x' } })
        .catch((e: unknown) => e);
    });

    expect(isProblemError(err) && [err.status, err.errorCode]).toEqual([403, 'DENY_TENANT_READ_ONLY']);
    expect(container.textContent).toBe('readOnly=true flag=false');
    // The deny is page state for useReadOnly (README, gateway deny codes); flags follow the session
    // context only, so code that reads getFlag('read_only') does not see it (reported, see the report).
    expect(getFlag('read_only', false)).toBe(false);
  });
});
