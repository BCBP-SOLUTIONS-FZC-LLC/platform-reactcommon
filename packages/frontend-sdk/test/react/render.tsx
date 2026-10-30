// A minimal render helper over react-dom/client and React's act (no extra test library).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: { root: Root; container: HTMLElement }[] = [];

export async function render(ui: ReactNode): Promise<{ container: HTMLElement; rerender(ui: ReactNode): Promise<void>; unmount(): Promise<void> }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => root.render(ui));
  return {
    container,
    rerender: (next) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
}

/** Runs `fn` inside act and lets effects and promises settle. */
export async function settle(fn?: () => unknown): Promise<void> {
  await act(async () => {
    await fn?.();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

export async function cleanup(): Promise<void> {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
}
