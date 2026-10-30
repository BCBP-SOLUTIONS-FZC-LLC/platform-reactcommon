# Developer surface

`/react` · `/testing`

How app code actually meets the SDK: React hooks and components over every other area, and a test kit for remotes' unit tests and CI. It sits on top: it uses every area, and no area uses it.

| Subpath | What it does | Main exports |
|---|---|---|
| `/react` | The shell's provider; hooks for session, workspace, permissions, flags, locale, API calls, step-up, read-only, online state, app updates; error boundaries for remotes; global error and CSP-violation capture | `PlatformProvider`, `useSession`, `useCurrentUser`, `useWorkspace`, `useSessionContext`, `useApi`, `useApiClient`, `useT`, `useLocale`, `useFeatureFlag`, `useHasPermission`, `Can`, `useStepUp`, `useReadOnly`, `useRouteTemplate`, `useBeforeAuthRedirect`, `useOnlineStatus`, `useAppUpdate`, `useSwitchWorkspace`, `MFEErrorBoundary`, `RemoteBoundary`, `installGlobalErrorHandlers` |
| `/testing` | A real SDK runtime for tests, with in-memory logs and spans, a signed-in user, permissions and flags; API mocks with gincommon-shaped problems; the metric inventory for `metricslint` (dev only) | `createTestPlatform`, `mockApi`, `mockProblem`, `renderMetricInventory` |

Build time: [`@platform/eslint-plugin`](../../packages/eslint-plugin) enforces how apps use the SDK:
- SDK subpath imports only;
- no identity headers;
- no raw browser storage;
- no unsanitized HTML;
- no runtime CSS-in-JS;
- route templates for API paths.

## How it's used

```tsx
export default function EditTender({ id }: { id: string }) {
  return (
    <MFEErrorBoundary mfe="tenders">
      <EditTenderForm id={id} />
    </MFEErrorBoundary>
  );
}

function EditTenderForm({ id }: { id: string }) {
  useRouteTemplate('/tenders/:id/edit');
  const t = useT('tenders');
  const canEdit = useHasPermission('update', 'tender');
  const { data, error, loading } = useApi((c, signal) => c.get<Tender>('/tenders/:id', { params: { id }, signal }), [id]);
  // …
}
```

In a remote's tests:

```ts
const p = createTestPlatform({ permissions: ['update:tender'] });
mockApi({ 'GET /tenders/:id': Response.json(tender) });
render(<p.Wrapper><EditTender id="1" /></p.Wrapper>);
expect(p.logs).toEqual([]);
```

## Guarantees

- **Hooks follow the SDK's state:** session, permissions, flags and locale changes re-render.
- **`useApi`** cancels its request on unmount and when its inputs change.
- **One remote's render error** stays in its boundary, logged with that remote's name, and offers "Try again". After a deploy, a chunk-load error reloads once.
- **`/testing` runs the real SDK,** with fakes only at the edges (exporters, network, identity provider).

Design doc: §C1 `/react`, `/testing`, §C4 (examples).
