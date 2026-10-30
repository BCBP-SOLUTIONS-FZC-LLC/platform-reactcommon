// The identifier-first screen (FE spec A2): a company slug or a pending invitation's email, resolved
// through PUB-1. "Not found" is one generic message, never which input failed.
import { useState } from 'react';
import type { Workspace } from '@platform/frontend-sdk/auth';
import { workspaceResolver } from './iam';
import { hideScreen, showScreen } from './screen';

function IdentifierForm({ onWorkspace }: { onWorkspace: (w: Workspace) => void }) {
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(form: FormData) {
    const identifier = String(form.get('identifier') ?? '').trim();
    if (!identifier) return;
    setBusy(true);
    setNotFound(false);
    try {
      const w = await workspaceResolver.resolve(identifier);
      if (w) onWorkspace(w);
      else setNotFound(true);
    } catch {
      setNotFound(true); // rate-limited or unreachable: the same generic message
    } finally {
      setBusy(false);
    }
  }
  return (
    <form action={submit} aria-labelledby="signin-title">
      <h1 id="signin-title">Sign in</h1>
      <label>
        Company workspace or invitation email
        <input name="identifier" autoComplete="username" required />
      </label>
      {notFound && <p role="alert">We could not find that workspace.</p>}
      <button type="submit" disabled={busy}>
        Continue
      </button>
    </form>
  );
}

/** Shows the screen until an identifier resolves; returns that Workspace. */
export function askForWorkspace(): Promise<Workspace> {
  return new Promise((resolve) =>
    showScreen(
      <IdentifierForm
        onWorkspace={(w) => {
          hideScreen();
          resolve(w);
        }}
      />,
    ),
  );
}

export function showWorkspaceNotFound(): void {
  showScreen(
    <div role="alert">
      <p>We could not find that workspace.</p>
      <button type="button" onClick={hideScreen}>
        OK
      </button>
    </div>,
  );
}
