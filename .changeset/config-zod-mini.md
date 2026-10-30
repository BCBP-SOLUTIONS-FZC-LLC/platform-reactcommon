---
'@platform/frontend-sdk': minor
---

`/config`: the runtime-config schema uses `zod/mini` instead of classic Zod, which halves the SDK the
shell loads (all subpaths, gzipped: 168.6 KB → 86.1 KB; `/config` 93 KB → 11 KB, and every subpath that
reads the config drops by the same amount). Validation rules, defaults, strictness and issue paths are
unchanged. `RuntimeConfigSchema` is now typed `z.ZodMiniType<RuntimeConfig>`; `.parse()` and
`.safeParse()` work as before. `RuntimeConfigError` messages are worded by the SDK (zod/mini has no
default messages), for example `unknown keys "typo"`, `must be ≥ 1000`, `expected an integer`.
