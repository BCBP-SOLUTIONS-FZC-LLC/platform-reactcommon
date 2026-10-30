// The shell bootstrap of design doc §C4 (sequence: §C2), as written there.
import { initializeCore, setConsentProvider } from '@platform/frontend-sdk/core';
import { loadRuntimeConfig, setRuntimeConfig } from '@platform/frontend-sdk/config';
import { initializeTracing } from '@platform/frontend-sdk/tracing';
import { initializeLogging, getLogger } from '@platform/frontend-sdk/logging';
import { initializeMetrics, startWebVitals } from '@platform/frontend-sdk/metrics';
import { setFlagProvider, runtimeConfigFlagProvider, sessionContextFlagProvider } from '@platform/frontend-sdk/flags';
import { createOidcProvider, initializeAuth, chooseWorkspace, rememberWorkspace, isWrongWorkspace,
         signInAgain } from '@platform/frontend-sdk/auth';
import { setTokenSource } from '@platform/frontend-sdk/http';
import { setAuthorizer, setAuthzSubject, roleMapAuthorizer } from '@platform/frontend-sdk/authz';
import { initializeI18n } from '@platform/frontend-sdk/i18n';
import { loadManifest, startVersionPolling } from '@platform/frontend-sdk/mfe';
import { installTrustedTypesPolicy } from '@platform/frontend-sdk/security';
import { PlatformProvider, installGlobalErrorHandlers } from '@platform/frontend-sdk/react';
import { createRoot } from 'react-dom/client';
import { cmp } from './consent';
import { permissions } from './permissions';
import { workspaceResolver, sessionContextSource } from './iam';   // PUB-1 and IAM item A over an ApiClient
import { askForWorkspace, showWorkspaceNotFound } from './IdentifierFirst'; // FE spec A2 screen; resolves via workspaceResolver
import { showWrongWorkspace, showSessionEnded, showSignedOut } from './SessionScreens'; // shell-owned screens
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
    if (session.reason === 'signed-out') showSignedOut(signIn); else await signIn();
    return;
  }
  // Trial login through an invitation email that landed in another tenant: never cache it, never render the app.
  if (isWrongWorkspace(session.workspace, session.user)) { showWrongWorkspace(idp); return; }
  // Expiry happens only during use. Never redirect on our own; the user clicks "Sign in" in the dialog.
  // A server-ended session (e.g. trial → paid) re-resolves the workspace; a natural expiry reuses the cache.
  idp.subscribe((s) => {
    if (s.status === 'expired') showSessionEnded(s, () =>
      signInAgain({ idp, state: s, resolver: workspaceResolver, cfg: cfg.auth, ask: askForWorkspace }));
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

  createRoot(document.getElementById('root')!).render(
    <PlatformProvider shell={{ user: session.user, workspace: session.workspace, context,
                               locale: document.documentElement.lang,
                               switchWorkspace: async (id) => {
                                 const w = await workspaceResolver.resolve(id);
                                 if (!w) { showWorkspaceNotFound(); return; }  // generic message, never says which input failed
                                 await idp.switchWorkspace(w);
                               } }}>
      <App />
    </PlatformProvider>,
  );
}
