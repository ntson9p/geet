# Releasing GitTree

The pipeline is fully authored in [.github/workflows/release.yml](../.github/workflows/release.yml)
but has **never executed** — this project has no git remote and no marketplace
publisher by owner decision (see PHASE-10 → Deviations). This document is the
process definition plus the go-live checklist for whoever provisions those.

## Versioning

VS Code pre-release convention: **odd minor = pre-release channel, even minor
= stable** (`0.1.x` pre-release → `0.2.x` stable → `0.3.x` pre-release …).
The workflow derives the channel from the version's minor and refuses tags
that do not exactly match `package.json`'s version.

- `engines.vscode` floor is `^1.96.0` and must equal the `@types/vscode`
  major.minor (currently `1.96.0`) — re-verify both when bumping either.
- Bundle budget: the VSIX must stay **< 2.5 MB excluding images**; asserted
  automatically by the `postpackage` hook (`scripts/checkBundleSize.mjs`) on
  every `npm run package`, locally and in CI.

## Changelog process

Every release adds a `## [x.y.z] — YYYY-MM-DD` section at the top of
`CHANGELOG.md` *before* tagging. Enforced two ways:

- a unit test fails when `CHANGELOG.md` has no section for the current
  `package.json` version;
- the stable-release job extracts that section
  (`scripts/extractChangelog.mjs`) as the GitHub Release notes and fails if
  it is missing.

## Release flow (what the workflow does on `git tag vX.Y.Z && git push --tags`)

1. **verify** — tag ↔ `package.json` version match; odd/even-minor → channel.
2. **check / integration / perf** — full quality gates on 3 OSes, including
   the §13 performance budgets; `npm ci` + `npm audit signatures` provenance.
3. **package** — `vsce package` + bundle-size assertion; VSIX uploaded as an
   artifact.
4. **publish-prerelease** — `vsce publish --pre-release` (environment
   `pre-release`, needs the `VSCE_PAT` secret).
5. **publish-stable** — even-minor tags only, gated on the `stable`
   environment's **required reviewers** (that approval is the manual gate):
   `vsce publish` + GitHub Release with the changelog extract and the VSIX.

## Go-live checklist (first real release)

1. Create the GitHub repository matching `package.json#repository` and push
   `main` + tags. Third-party actions in release.yml are pinned to commit
   shas — re-verify them against the tags noted in the comments.
2. Create an Azure DevOps publisher, generate a Marketplace PAT and store it
   as the `VSCE_PAT` secret on both the `pre-release` and `stable`
   environments; add required reviewers on `stable`.
3. Verify `package.json#publisher` matches the real publisher id (currently
   `gittree` — a placeholder until one exists).
4. Dry-run: `npx vsce publish --pre-release --dry-run` locally, then tag an
   odd-minor version (e.g. `v0.1.0`) and watch the pipeline.
5. Marketplace listing assets (icon, galleryBanner, README screenshots) are
   already packaged — review the listing render after the first pre-release.
