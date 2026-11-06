---
name: release
description: Prepare a release of the three packages (vX.Y.Z or vX.Y.Z-alpha.N) - release branch, version-packages, the CHANGELOG section, verify, publish:check, a dry run of the release workflow's own scripts, the PR - then the tag steps for the admin and watching release.yml to the GitHub Packages publish.
argument-hint: "<version without v, e.g. 1.0.0-alpha.2>"
disable-model-invocation: true
---

# /release

Release `$ARGUMENTS` as `VERSIONING.md` § *Maintainer release process* describes. The first release (`v1.0.0-alpha.1`, 2026-11-03) went through every step below; each note is something that went wrong once.

## 0. Preconditions

- `main` has everything for the release and its **CI on the head commit is green** (`gh run list --branch main --limit 1`). Every change to a published package carried a `.changeset/*.md` and an `[Unreleased]` entry.
- `$ARGUMENTS` matches what changesets will produce: `cat .changeset/pre.json` (pre mode `alpha` gives `1.0.0-alpha.N`; leaving pre mode is a separate step, `pnpm changeset pre exit`, before `1.0.0`).
- No open PR is still meant for this release.

## 1. Branch and version

```bash
git switch main && git pull --ff-only
git switch -c release/v$ARGUMENTS
pnpm run version-packages        # changeset version (all three, fixed group) + exports:sync
grep -h '"version"' packages/*/package.json | sort -u   # must be exactly $ARGUMENTS
```

In pre mode changesets v3 **moves** the consumed changesets into `.changeset/pre/` instead of deleting them. That is expected; commit both sides. `changelog-check.yml` recognises the move as a release PR.

## 2. CHANGELOG

```bash
node .claude/skills/release/release-changelog.mjs $ARGUMENTS          # date defaults to today (UTC)
```

It renames `## [Unreleased]` to `## [$ARGUMENTS] - YYYY-MM-DD`, adds an empty `[Unreleased]`, and rewrites the compare links. It refuses an empty `[Unreleased]`. Read the section once: the **Breaking** entries under *Changed* must say how to keep the old behaviour.

## 3. Verify, as the release workflow will

```bash
pnpm install                     # if the lockfile changed
pnpm verify
bash .github/scripts/pack-packages.sh && pnpm publish:check            # 3 tarballs at $ARGUMENTS, the dist-tag
RELEASE_TAG=v$ARGUMENTS bash .github/scripts/verify-changelog-entry.sh
RELEASE_TAG=v$ARGUMENTS REPO=BCBP-SOLUTIONS-FZC-LLC/platform-reactcommon bash .github/scripts/extract-release-notes.sh && rm release-notes.md
```

`extract-release-notes.sh` needs `REPO`. All five must pass before the PR.

## 4. The release PR

Commit as `chore(release): v$ARGUMENTS` (body: what version-packages did, the CHANGELOG step, the checks). Push the branch and open the PR into `main` with the tag steps in its description. Wait for **both** CI and the Changelog check, then the user merges it.

## 5. The tag (the user, an admin)

Only admins can create `v*` tags (ruleset "release tags"); pushing the tag is the publish approval. The `guard-release-tag.sh` hook refuses a tag whose commit is not on `origin/main`, versioned as the tag, and green. Before tagging, **`main`'s CI on the release merge commit must be green**: a failure there (a flaky test) means a fix PR first, then tag the commit after it. Then:

```bash
git switch main && git pull --ff-only
git tag -a v$ARGUMENTS -m "v$ARGUMENTS"
git push origin v$ARGUMENTS      # "Bypassed rule violations … creations being restricted" is expected
```

## 6. Watch `release.yml`

`gh run list --workflow release.yml --limit 1`, then follow the run to the end. Expected: `verify` → the gates (test, quality, contracts, package, Trivy, smoke, interop, react-floor, eslint-9) → `npm publish (GitHub Packages)` → `GitHub Release`. In the npm-publish log:

- `✔ environment 'npm' accepts only release tags, and ruleset 'release tags' … restricts who may create, move or delete them` (a warning that the token cannot see the bypass list is expected);
- `✔ @bcbp-solutions-fzc-llc/<pkg>@$ARGUMENTS published under dist-tag <tag>; registry integrity matches` for all three.

Then `gh release view v$ARGUMENTS` (pre-release for `-alpha`/`-rc`; 3 tarballs, `checksums.txt`, `.sigstore.json`, SBOM).

## 7. After

Run `/release-status $ARGUMENTS` (every doc that states the latest version, and shipped changes still called `[Unreleased]`), delete the merged release branch, and tell the shell and remote teams (breaking changes, shell first).
