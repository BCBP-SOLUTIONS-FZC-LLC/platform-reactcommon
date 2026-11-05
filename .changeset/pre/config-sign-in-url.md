---
'@bcbp-solutions-fzc-llc/frontend-sdk': minor
---

`/config`: optional `auth.signInUrl` in `runtime.json` (where users sign in, for pages without a shell, such as a remote run standalone). Set it in `runtime.json` only once the shell (or standalone page) runs this version: earlier versions refuse the unknown key.
