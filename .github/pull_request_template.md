## Description
Provide a clear description of the changes.

---

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Refactor
- [ ] Documentation
- [ ] Test
- [ ] Breaking change (public API of a subpath, a contract pin, or a shared-module version)

---

## Testing
- [ ] Unit tests added/updated
- [ ] All checks passing (`pnpm verify`)
- [ ] Manual testing performed (if required)

---

## Checklist

### Code Quality
- [ ] Lint, typecheck and dependency rules pass (`pnpm lint`, `pnpm typecheck`, `pnpm depcruise`)
- [ ] API reports updated if a public API changed (`pnpm api`, commit `api/*.api.md`)
- [ ] Changeset (`pnpm changeset`) and a `CHANGELOG.md` entry under `[Unreleased]` for a change to a published package
- [ ] No debug logs / commented code

---

### Contracts and the design doc
- [ ] Follows `docs/design/frontend-sdk-design.md`; doc updated in this PR if behaviour changed
- [ ] Contracts come from the generated `contracts/` only (`pnpm contracts:sync` after moving a pin)

---

### Observability
- [ ] Logs carry `trace_id` / `request_id` / `session_id` through the SDK logger (no `console` in SDK code)
- [ ] API errors are handled as RFC 9457 problems (`/problem`), not raw bodies
- [ ] Metrics use registry names and labels (`metrics:parity` passes)

---

### Security
- [ ] No secrets hardcoded; no tokens in browser storage
- [ ] No identity headers sent from the browser (`x-user-id`, `x-tenant-id`, …)
- [ ] HTML only through `sanitizeHtml`; CSP-safe (no `eval`, no inline script, no runtime CSS-in-JS)

---

### Documentation
- [ ] README / design doc updated (if needed)

---

## 🔗 Related Issue
Closes #<issue-id>

---

## Deployment Notes
Mention anything important for deployment (shell/remote rebuilds, runtime config, CloudFront).
