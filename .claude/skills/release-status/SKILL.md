---
name: release-status
description: After a release has published, update every document that states the latest version (README, VERSIONING, ARCHITECTURE, the LLD version line and §14, .claude/CLAUDE.md, .claude/operations.md), then find references to [Unreleased] for changes that have now shipped, and open the docs-only PR.
argument-hint: "<version without v, e.g. 1.0.0-alpha.7>"
disable-model-invocation: true
---

# /release-status

Record that `v$ARGUMENTS` is released. Run it after `/release` step 6, once `release.yml` has published and `gh release view v$ARGUMENTS` shows the assets. #49, #52 and #57 were this change by hand; `/code-review` on #57 still found three places it had missed.

## 0. Preconditions

```bash
gh release view v$ARGUMENTS --json isPrerelease,assets -q '.assets[].name'   # 3 tarballs, checksums.txt (+ .sigstore.json), the SBOM
git switch main && git pull --ff-only
grep -h '"version"' packages/*/package.json | sort -u                         # exactly $ARGUMENTS
git switch -c docs/release-status-<version>                                    # e.g. docs/release-status-alpha7
```

Read the version's CHANGELOG section first: the summary you write everywhere below comes from it (what was added, whether anything is **Breaking**, the PR numbers).

## 1. The places that state the latest version

Find them; don't trust this list to be complete:

```bash
git grep -n -E "latest (release|is)|the latest\b|released 20[0-9]{2}-|Status:\*\*|pending under|Pending|alpha\.[0-9]+\`? \(released" -- README.md VERSIONING.md ARCHITECTURE.md docs/lld/platform-reactcommon-lld.md .claude/CLAUDE.md .claude/operations.md
```

| File | What to change |
|---|---|
| `README.md` | Header "latest release is"; the versions table row; *Upgrading between alpha versions* (drop "pending under `[Unreleased]`" from the new version's note); `TAG=` in *Verifying a release* |
| `VERSIONING.md` | *Guarantees* (a bullet for the version: what it adds, breaking or not, the upgrade order); *Supported releases* (latest release; the release table row); *Install* and *Verify* commands (`@$ARGUMENTS`, the tarball name) |
| `ARCHITECTURE.md` | *Release and distribution*: "The latest is …" |
| `docs/lld/platform-reactcommon-lld.md` | The **Version** row at the top; §14.1 ("the latest is …"); §14.2 (a bullet for the version); a revision-history row (next number, today's date, after the last row) |
| `.claude/CLAUDE.md` | **Status** (released version and date, what it added; remove it from "pending" wording) |
| `.claude/operations.md` | "Released: …, the latest" |

Dates are the CHANGELOG's (UTC), the same as the release section.

## 2. Shipped changes still called `[Unreleased]`

```bash
git grep -n "\[Unreleased\]" -- '*.md' ':!CHANGELOG.md' ':!.changeset/**'
```

Each hit that describes a change now in a released section becomes that version (`` CHANGELOG `1.0.0-alpha.N` ``). Keep the generic ones ("add an entry under `[Unreleased]`", the CHANGELOG link in VERSIONING's support table).

## 3. Check and open the PR

```bash
pnpm docs:check
git add -A && git commit -m "docs: release status is v$ARGUMENTS"
git push -u origin HEAD
gh pr create --base main --title "docs: release status is v$ARGUMENTS" --body "…"
```

The body says what was released (the tag's commit, the jobs, the dist-tag) and what this changes. It is docs-only, so CI skips it and it needs an admin merge: say so. After the merge, delete the branch.
