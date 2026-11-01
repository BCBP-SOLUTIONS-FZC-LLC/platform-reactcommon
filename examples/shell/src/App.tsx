// The shell's routes: a home page and the tenders remote's edit page under /t/<slug>/.
import { RemoteBoundary, useRouteTemplate, useSignOut, useWorkspace } from '@bcbp-solutions-fzc-llc/frontend-sdk/react';

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

/** Signs out of this device (local): every tab follows, and the next sign-in asks for credentials. */
function SignOut() {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={() => void signOut()}>
      Sign out
    </button>
  );
}

export function App() {
  const edit = EDIT_TENDER.exec(location.pathname);
  return (
    <>
      <header>
        <SignOut />
      </header>
      {edit ? <RemoteBoundary remote="tenders" module="./EditTender" fallback={<p>Loading…</p>} props={{ id: decodeURIComponent(edit[1]!) }} /> : <Home />}
    </>
  );
}
