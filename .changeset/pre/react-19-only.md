---
'@bcbp-solutions-fzc-llc/frontend-sdk': major
'@bcbp-solutions-fzc-llc/webpack-preset': major
---

React 19 only: the peer range and the shared (Module Federation) range for `react` / `react-dom` are `^19.0.0` (was `^18.3.0 || ^19.0.0`). A remote facing a shell on React 18 is refused at share negotiation instead of failing inside the page. Tested at React 19.0.0 (CI `react-floor`) and the newest 19.x.
