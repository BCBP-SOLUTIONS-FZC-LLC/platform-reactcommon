---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

/react: useRefreshSessionContext() and the optional ShellContextValue.refreshContext, so a remote can ask the shell to reload the session context (IAM P-35) after a role change or a 403 DENY_ROLE_INSUFFICIENT; calls are shared page-wide and never reject. /testing: createTestPlatform's refreshContext option and contextRefreshes.
