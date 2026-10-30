# contracts/

Generated, committed copies of the backend contracts the SDK must match (design doc §C5). **Never
edit these files**: run `pnpm contracts:sync`, review the diff, commit. CI (`pnpm contracts:check`)
fails when they differ from what the pinned sources generate.

| File | Source | Used by |
|---|---|---|
| `sources.json` | Pins: one commit per source repo (hand-maintained; move with `--update-pins`) | `scripts/sync-contracts.ts`, CI |
| `registry-vocab.json` | gincommon `internal/obsregistry/registry.json`: domain and environment vocabularies, service and version patterns | `/core` |
| `metric-registry.json` | gincommon `internal/obsregistry/registry.json`: the observability standard (tiers, metrics, labels, prohibited labels, bucket presets) | `/metrics` |
| `problem-types.json` | `go-probe contracts-export` (gincommon `pkg/problem`): problem constants, platform types, `TypeForStatus` | `/problem` |
| `headers.json` | `go-probe contracts-export` (gincommon `pkg/gincommon`) + gincommon `internal/core/domain` limits and patterns | `/core`, `/http` |
| `log-fields.json` | gincommon `internal/adapter/inbound/http/middleware/logging.go` | `/logging` |
| `redaction.json` | gincommon `internal/core/service/log_sanitizer.go` (unexported): exact keys, substrings, `*_key` rule, placeholder, 256-byte limit | `/core` |
| `fixtures/header_cases.json` | platform-interop-tests `fixtures/header_cases.json` (byte copy) | `/core`, `/http` tests |
| `fixtures/identity_cases.json` | platform-interop-tests `fixtures/identity_cases.json` (byte copy; Go runs it with `go-probe identity-check`) | `/core` tests |
| `fixtures/redaction_cases.json` | platform-interop-tests `fixtures/redaction_cases.json` (byte copy) | `/core` tests |
| `../src/internal/generated/contracts.ts` | The same objects as `registry-vocab.json`, `headers.json` and `redaction.json`, as `as const` TypeScript | SDK code |

Sources are read from sibling checkouts under `PLATFORM_ROOT` (default: two levels above this repo,
i.e. the workspace root), at the paths in `sources.json`. The IAM contracts (gateway deny codes,
PUB-1 and P-35 fixtures) are added with `/problem` and `/auth`.
