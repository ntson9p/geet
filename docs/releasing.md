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

## Dependency security

`npm audit` must report no vulnerabilities. The extension has no npm runtime
dependencies (`dependencies` is empty and esbuild bundles our own code), so
an advisory can only reach the development tools; they are kept clean all
the same. Three advisories have no fixed release in the range their users
ask for, so `package.json#overrides` forces the fixed versions, each only
under the package that needs it:

| Override | Why | Drop it when |
| --- | --- | --- |
| `mocha` → `serialize-javascript ^7.1.4` | GHSA-5c6j-r48x-rmvq and two more: mocha 10 and 11 ask for 6.x. Mocha uses it only in parallel mode, which the integration runner does not use | mocha is upgraded. Mocha 12 is ESM-only and asks for a vulnerable `glob` and `minimatch`, so it was not taken |
| `@typescript-eslint/typescript-estree` → `minimatch ^11.0.1` | GHSA-g3hv-75wg-m249: 8.72.2 asks for `^10.2.2`; only 11.0.1 is fixed | typescript-eslint asks for `minimatch` 11 itself |
| `@vscode/vsce` → `minimatch ^11.0.1` | The same advisory: vsce 4.1.1 asks for `^10.2.6` | vsce asks for `minimatch` 11 itself |

ESLint's own `minimatch` 3 is outside the advisory's range and is left alone.

`npm run test:unit` starts Vitest through `scripts/vitest.mjs`. On Windows,
Vitest 4 loads two copies of itself when the working directory's drive letter
is lower case (vitest-dev/vitest#11872), and every suite fails. The launcher
starts it from the upper-case form; go back to `vitest run` once that is fixed.

`npm list` (and so `vsce ls` and `vsce package`) crashes with "Cannot read
properties of null (reading 'edgesOut')" when started from a lower-case drive
letter, because the workspace link resolves to the upper-case form. Run them
from the upper-case form (`D:\…`, not `d:\…`).

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
