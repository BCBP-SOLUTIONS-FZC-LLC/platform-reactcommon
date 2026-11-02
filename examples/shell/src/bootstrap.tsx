// The shell bootstrap of design doc §C4 (sequence: §C2), as written there.
import { initializeCore, setConsentProvider } from '@bcbp-solutions-fzc-llc/frontend-sdk/core';
import { loadRuntimeConfig, setRuntimeConfig } from '@bcbp-solutions-fzc-llc/frontend-sdk/config';
import { initializeTracing } from '@bcbp-solutions-fzc-llc/frontend-sdk/tracing';
import { initializeLogging, getLogger } from '@bcbp-solutions-fzc-llc/frontend-sdk/logging';
import { initializeMetrics, startWebVitals } from '@bcbp-solutions-fzc-llc/frontend-sdk/metrics';
import { setFlagProvider, runtimeConfigFlagProvider, sessionContextFlagProvider } from '@bcbp-solutions-fzc-llc/frontend-sdk/flags';
import { createOidcProvider, initializeAuth, chooseWorkspace, rememberWorkspace, isWrongWorkspace,
         signInAgain } from '@bcbp-solutions-fzc-llc/frontend-sdk/auth';
import { setTokenSource } from '@bcbp-solutions-fzc-llc/frontend-sdk/http';
import { setAuthorizer, setAuthzSubject, roleMapAuthorizer } from '@bcbp-solutions-fzc-llc/frontend-sdk/authz';
import { initializeI18n } from '@bcbp-solutions-fzc-llc/frontend-sdk/i18n';
import { loadManifest, startVersionPolling } from '@bcbp-solutions-fzc-llc/frontend-sdk/mfe';
import { installTrustedTypesPolicy } from '@bcbp-solutions-fzc-llc/frontend-sdk/security';
import { PlatformProvider, installGlobalErrorHandlers } from '@bcbp-solutions-fzc-llc/frontend-sdk/react';
import { createRoot, type Root } from 'react-dom/client';
import { cmp } from './consent';
import { permissions } from './permissions';
import { workspaceResolver, sessionContextSource } from './iam';   // PUB-1 and IAM item A over an ApiClient
import { askForWorkspace, showWorkspaceNotFound } from './IdentifierFirst'; // FE spec A2 screen; resolves via workspaceResolver
import { showDeviceClock, showSessionEnded, showSignedOut, showWrongWorkspace } from './SessionScreens'; // shell-owned screens
import { App } from './App';

export async function bootstrap(): Promise<void> {
  installTrustedTypesPolicy();
  // app.bcbpsolutions.com fronts tenders, IAM administration and the dashboard: a multi-domain shell (§D1).
  initializeCore({ serviceName: 'web-app', domain: 'portal',
                   environment: __ENVIRONMENT__, buildVersion: __BUILD_VERSION__ });

  const cfg = await loadRuntimeConfig();
  setRuntimeConfig(cfg);
  setConsentProvider(cmp);

  const { otlpBaseUrl, sampleRatio, logLevel } = cfg.telemetry;
  initializeTracing({ otlpBaseUrl, sampleRatio, propagationAllowlist: cfg.api.propagationAllowlist });
  initializeLogging({ otlpBaseUrl, level: logLevel });
  initializeMetrics({ otlpBaseUrl });
  installGlobalErrorHandlers();
  startWebVitals();
  setFlagProvider(runtimeConfigFlagProvider());

  const idp = createOidcProvider(cfg.auth, workspaceResolver);
  setTokenSource(initializeAuth(idp));
  const session = await idp.init();   // may redirect once with prompt=none on a reload or new tab (never settles then)
  if (session.status === 'anonymous') {
    // init() has already moved the URL off the callback path to the page the user opened.
    const signIn = async () => {
      // A failed silent attempt names its workspace; otherwise /t/<slug> → cached or resolved Workspace
      // (paid OR trial), else the most recent cached Workspace, else ask.
      const workspace = (session.reason === 'login-required' ? session.workspace : undefined)
        ?? await chooseWorkspace({ pathname: location.pathname, resolver: workspaceResolver, cfg: cfg.auth })
        ?? await askForWorkspace();
      await idp.login({ workspace, returnUrl: location.pathname + location.search });
    };
    // After a logout, wait for the user: an automatic login would ride the live SSO session and undo it.
    if (session.reason === 'signed-out') showSignedOut(signIn);
    else if (session.reason === 'device-clock') showDeviceClock(signIn);  // signing in again would fail the same way
    else await signIn();
    return;
  }
  // Trial login through an invitation email that landed in another tenant: never cache it, never render the app.
  if (isWrongWorkspace(session.workspace, session.user)) { showWrongWorkspace(idp); return; }
  // Expiry happens only during use. Never redirect on our own; the user clicks "Sign in" in the dialog.
  // A server-ended session (e.g. trial → paid) re-resolves the workspace; a natural expiry reuses the cache.
  let app: Root | undefined;
  idp.subscribe((s) => {
    if (s.status === 'expired') showSessionEnded(s, () =>
      signInAgain({ idp, state: s, resolver: workspaceResolver, cfg: cfg.auth, ask: askForWorkspace }));
    // Signed out here or in another tab (the SDK drops this tab's tokens on the broadcast): unmount the
    // app, so the previous user's data is not left under the dialog on a shared device. The next sign-in
    // asks for credentials (prompt=login).
    if (s.status === 'anonymous' && s.reason === 'signed-out') {
      app?.unmount();
      app = undefined;
      showSignedOut(() =>
        idp.login({ workspace: s.workspace ?? session.workspace, returnUrl: location.pathname + location.search }));
    }
  });

  // Roles, plan and flags are not in the token (§0 row 10). Without them: deny-all, platform flags only.
  const context = await sessionContextSource.load().catch((e) => {
    getLogger().warn('session context unavailable', { error: e }); return undefined; });
  setAuthorizer(roleMapAuthorizer(permissions));
  setAuthzSubject(context && { roles: context.roles, tenantId: context.tenantId });
  if (context) setFlagProvider(sessionContextFlagProvider(context));
  // Cache the workspace with its slug (trial tokens carry none) and move the URL to /t/<slug>/.
  if (context) rememberWorkspace({ ...session.workspace, slug: context.slug });
  await initializeI18n({ defaultLocale: cfg.i18n.defaultLocale, supported: cfg.i18n.supportedLocales });
  await loadManifest().catch((e) => getLogger().error('manifest load failed', { error: e }));
  startVersionPolling();

  app = createRoot(document.getElementById('root')!);
  app.render(
    <PlatformProvider shell={{ user: session.user, workspace: session.workspace, context,
                               locale: document.documentElement.lang,
                               switchWorkspace: async (id) => {
                                 const w = await workspaceResolver.resolve(id);
                                 if (!w) { showWorkspaceNotFound(); return; }  // generic message, never says which input failed
                                 await idp.switchWorkspace(w);
                               },
                               signOut: (o) => idp.logout(o) }}>
      <App />
    </PlatformProvider>,
  );
}
