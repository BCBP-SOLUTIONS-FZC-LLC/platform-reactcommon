---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

`/config`: optional `environment` in `runtime.json`, so one shell build serves every environment (load the config, then `initializeCore` with `cfg.environment`). A config whose `environment` differs from the page identity's is refused.
