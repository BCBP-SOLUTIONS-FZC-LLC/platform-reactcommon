# contracts/

Generated, committed copies of the backend contracts the SDK must match (design doc §C5). **Never
edit these files**: run `pnpm contracts:sync`, review the diff, commit. CI (`pnpm contracts:check`)
fails when they differ from what the pinned sources generate.

| File | Source | Used by |
|---|---|---|
| `sources.json` | Pins: one commit per source repo (hand-maintained; move with `--update-pins`) | `scripts/sync-contracts.ts`, CI |
| `registry-vocab.json` | gincommon `internal/obsregistry/registry.json`: domain and environment vocabularies, service and version patterns | `/core` |
| `metric-registry.json` | gincommon `internal/obsregistry/registry.json`: the observability standard (tiers, metrics, labels, prohibited labels, bucket presets) | `/metrics` |
| `problem-types.json` | `go-probe contracts-export` (gincommon `pkg/problem`): problem constants, platform types, `TypeForStatus`; plus `rules` from gincommon `internal/problem` (standard members, extension-name pattern, 1 MiB body cap, NewType slug and code patterns) | `/problem` |
| `gateway-deny-codes.json` | iam-authz-enrichment `internal/domain/decision.go` (reasons, `HTTPStatus`), checked against `TestDenyCodes_Pinned` | `/problem` |
| `headers.json` | `go-probe contracts-export` (gincommon `pkg/gincommon`) + gincommon `internal/core/domain` limits and patterns | `/core`, `/http` |
| `log-fields.json` | gincommon `internal/adapter/inbound/http/middleware/logging.go` | `/logging` |
| `redaction.json` | gincommon `internal/core/service/log_sanitizer.go` (unexported): exact keys, substrings, `*_key` rule, placeholder, 256-byte limit | `/core` |
| `tenant-resolve-cases.json` | SDK-authored PUB-1 cases (`scripts/lib/iam-cases.ts`), each response checked against iam-org-membership `docs/swagger/swagger.json` (`GET /public/tenants/resolve`, 200 schema inlined) | `/auth` tests; `/testing` contract tests of the shell's `WorkspaceResolver` |
| `session-context-cases.json` | SDK-authored P-35 cases (`scripts/lib/iam-cases.ts`), checked against the same swagger (`GET /me/session-context`) | `/auth` tests; `/testing` contract tests of the shell's `SessionContextSource` |
| `fixtures/header_cases.json` | platform-interop-tests `fixtures/header_cases.json` (byte copy) | `/core`, `/http` tests |
| `fixtures/identity_cases.json` | platform-interop-tests `fixtures/identity_cases.json` (byte copy; Go runs it with `go-probe identity-check`) | `/core` tests |
| `fixtures/redaction_cases.json` | platform-interop-tests `fixtures/redaction_cases.json` (byte copy) | `/core` tests |
| `fixtures/problem_bodies.json` | platform-interop-tests `fixtures/problem_bodies.json`: real gincommon and fastapicommon error responses with gincommon's decoding (byte copy) | `/problem` tests |
| `../src/internal/generated/*.ts` | One module per contract (`registry-vocab`, `headers`, `redaction`, `problem`, `gateway-deny-codes`, `metric-registry`): the same objects as the JSON files, as `as const` TypeScript, so each subpath bundles only the contracts it uses | SDK code |

Sources are read from checkouts at the paths in `sources.json`: the `platform` group under
`PLATFORM_ROOT` (default: two levels above this repo, the workspace root), the `iam` group under
`IAM_REPOS_DIR` (default: `../../../XPertPMS/IAM`).

Two docs pages are generated from these files: `docs/observability/metric-registry.md` and `docs/problem-details/registry.md`. After `pnpm contracts:sync`, run `pnpm docs:sync` as well (CI's `docs:check` fails otherwise).
