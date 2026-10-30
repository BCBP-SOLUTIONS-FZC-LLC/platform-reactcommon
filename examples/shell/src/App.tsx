// The shell's routes: a home page and the tenders remote's edit page under /t/<slug>/.
import { RemoteBoundary, useRouteTemplate, useWorkspace } from '@platform/frontend-sdk/react';

const EDIT_TENDER = /^\/t\/[a-z0-9-]+\/tenders\/([^/]+)\/edit$/;

function Home() {
  useRouteTemplate('/t/:slug');
  const w = useWorkspace();
  return (
    <main>
      <h1>{w?.slug ?? 'Workspace'}</h1>
      <a href={`/t/${w?.slug ?? ''}/tenders/1/edit`}>Edit tender 1</a>
    </main>
  );
}

export function App() {
  const edit = EDIT_TENDER.exec(location.pathname);
  if (edit) return <RemoteBoundary remote="tenders" module="./EditTender" fallback={<p>Loading…</p>} props={{ id: decodeURIComponent(edit[1]!) }} />;
  return <Home />;
}
