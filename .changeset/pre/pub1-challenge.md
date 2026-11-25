---
'@bcbp-solutions-fzc-llc/frontend-sdk': patch
---

Document that a WorkspaceResolver must throw on anything that is not a PUB-1 resolve response (a WAF challenge page, even with a 2xx), so the saved workspace is kept; the reference shell's resolver now does.
