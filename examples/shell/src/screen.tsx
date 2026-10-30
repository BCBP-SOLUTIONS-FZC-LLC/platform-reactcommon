// Mounts the shell's own screens (sign-in, signed-out, session ended, wrong workspace) outside the app
// root, so a dialog can sit over a running app.
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let root: Root | undefined;

export function showScreen(node: ReactNode): void {
  if (!root) {
    const el = document.createElement('div');
    el.id = 'shell-screen';
    document.body.appendChild(el);
    root = createRoot(el);
  }
  root.render(node);
}

export function hideScreen(): void {
  root?.render(null);
}
