// The shell's navigator for /nav navigate() (LLD §5.4.6): it routes by the path, and appId is informational.
// A path in the current workspace (under <workspacePathPrefix><slug>/) is a history navigation that the App
// follows on popstate, with no page load; the remote already mounted gets its new props (its route params).
// Any other same-origin path (another workspace, a page outside the workspace) is a full page load.
import { slugFromPath } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import type { RuntimeConfig } from '@bcbp-solutions-fzc-llc/frontend-sdk/config';

export function createShellNavigator(auth: RuntimeConfig['auth']): (appId: string, path: string, o?: { replace?: boolean }) => void {
  return (_appId, path, o) => {
    const here = slugFromPath(location.pathname, auth);
    const target = new URL(path, location.href);
    if (here !== undefined && slugFromPath(target.pathname, auth) === here) {
      if (o?.replace) history.replaceState(history.state, '', path);
      else history.pushState(history.state, '', path);
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return;
    }
    if (o?.replace) location.replace(path);
    else location.assign(path);
  };
}
