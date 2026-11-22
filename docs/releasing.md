# Releasing Geet

Geet is published to the Visual Studio Marketplace as **Geet for Git**, `ntson9p.geet`
(publisher `ntson9p`), from **github.com/ntson9p/geet**. The Marketplace takes a display
name only once, ignoring spaces and case: "GitTree", the name before, was refused because of
an older "Git Tree". The pipeline is
[.github/workflows/release.yml](../.github/workflows/release.yml): pushing a `v*` tag tests,
packages and publishes. It was authored in P10-T5 and readied for its first run in POST-P14cr;
the [one-time set-up](#one-time-set-up) below must be done before it can publish. It publishes
with [Trusted Publishing](#release-flow-what-the-workflow-does-on-git-tag-vxyz--git-push-origin-vxyz),
so no token is stored (POST-P14cx).

## Versioning

VS Code pre-release convention: **odd minor = pre-release channel, even minor
= stable** (`0.1.x` pre-release → `0.2.x` stable → `0.3.x` pre-release …).
The Marketplace takes each version once, as one channel or the other, and only
`major.minor.patch` (no `-beta.1` suffix). One rule decides the channel:
`scripts/releaseChannel.mjs`, which the workflow's verify job applies to the tag
(it refuses tags that do not exactly match `package.json`'s version) and
`npm run package` to the VSIX.

- `engines.vscode` floor is `^1.96.0` and must equal the `@types/vscode`
  major.minor (currently `1.96.0`) — re-verify both when bumping either.
- Bundle budget: the VSIX must stay **< 2.5 MB excluding images**; asserted
  automatically by the `postpackage` hook (`scripts/checkBundleSize.mjs`) on
  every `npm run package`, locally and in CI.

## Packaging

`npm run package` (`scripts/package.mjs`) runs `vsce package`, with `--pre-release` for an odd
minor and without it for an even one, and writes `geet-<version>.vsix` to the project's root.
It builds first (`vscode:prepublish`: the extension and the webviews), and the bundle budget is
checked after. To try a VSIX before publishing it, install it in VS Code: *Extensions: Install
from VSIX…*.

The README and CHANGELOG are the Marketplace page's Details and Changelog tabs. vsce rewrites
their relative links and images to the GitHub repository in `package.json#repository`
(`…/blob/HEAD/…` and `…/raw/HEAD/…`), so they work once `main` is pushed there. In the VSIX they
are `readme.md` and `changelog.md`: code that opens one from the extension's folder must not
assume the repository's capitals (`whatsNewGate.ts`, `changelogName`).

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
from the upper-case form (`D:\…`, not `d:\…`); `npm run package` does so itself.

## Changelog process

Every release adds a `## [x.y.z] — YYYY-MM-DD` section at the top of
`CHANGELOG.md` *before* tagging, under an empty `## [Unreleased]`. Enforced two ways:

- a unit test fails when `CHANGELOG.md` has no section for the current
  `package.json` version;
- the stable-release job extracts that section
  (`scripts/extractChangelog.mjs`) as the GitHub Release notes, before it publishes, and fails
  if it is missing.

## Release flow (what the workflow does on `git tag vX.Y.Z && git push origin vX.Y.Z`)

1. **verify** — tag ↔ `package.json` version match; the channel from the minor.
2. **check / integration / perf** — full quality gates on 3 OSes, including
   the §13 performance budgets; `npm ci` + `npm audit signatures` provenance.
3. **package** — `npm run package` (the channel's flag, the bundle budget); the VSIX is
   uploaded as an artifact, and that very file is what the next step publishes.
4. **publish** — in the `marketplace` environment, so it waits for that environment's
   **required reviewers** (their approval is the manual gate): `vsce publish --oidc
   --packagePath`, with `--pre-release` for an odd minor. For an even minor the changelog
   section is extracted first, and a GitHub Release with it and the VSIX follows.

**Trusted Publishing** (`--oidc`, POST-P14cx): the publish job asks GitHub for an OIDC token
(`id-token: write`), and vsce exchanges it for a Marketplace credential that lasts 15 minutes.
Nothing is stored, so no secret can leak or expire. The Marketplace takes such a token only
from the repository, workflow file and environment its policy names (below), and vsce does
not fall back to a stored token when the exchange fails. Both channels publish from the one
job and environment because a policy names one environment.

## One-time set-up

1. **Publisher.** Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft
   account and create the publisher with the ID **`ntson9p`** (`package.json#publisher`; the
   ID cannot change later, the display name can).
2. **Make the repository public.** The Marketplace page loads the README's screenshots from
   it; the page's links, and Geet's own Help and Report Issue buttons, open it; and GitHub's
   free plan has environments only on public repositories.
3. **GitHub environment.** In the repository's *Settings › Environments*, create
   `marketplace` and give it *Required reviewers* (yourself). It needs no secret. Without
   reviewers, a pushed tag publishes as soon as the tests pass.
4. **Trusted Publishing policy.** On the publisher's page at
   <https://marketplace.visualstudio.com/manage>, select *Trusted Publishing*, expand
   *Create*, and enter:

   | Field | Value |
   | --- | --- |
   | Policy name | anything, e.g. `release` |
   | Repository owner | `ntson9p` |
   | Repository | `geet` |
   | Workflow | `release.yml` |
   | Environment | `marketplace` |

   The first successful publish activates the policy for good. For a private repository, the
   workflow must run within 48 hours of the policy's creation. Renaming the repository, the
   workflow file or the environment needs the policy changed to match.

Third-party actions in release.yml are pinned to commit shas — re-verify them against the
tags noted in the comments when bumping one.

## A release

1. Set `package.json#version` (and the root `version` in `package-lock.json`), and move
   `## [Unreleased]`'s notes into a `## [x.y.z] — YYYY-MM-DD` section under it.
2. Try it: `npm run check`, then `npm run package` and install the VSIX (above).
3. Commit, push `main`, then tag and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. After the first publish, read the listing on the Marketplace: the icon, the banner colour
   (`galleryBanner`), the README's screenshots and links.

**Publishing by hand** (without the workflow): `npm run package`, then
`npx vsce publish --pre-release --packagePath geet-0.1.0.vsix` for a pre-release
(`--pre-release` makes vsce refuse a VSIX not packaged as one), or without `--pre-release` for
a stable version. By hand, vsce needs a Personal Access Token from Azure DevOps
(<https://dev.azure.com>, *User settings › Personal access tokens › New token*: organization
**All accessible organizations**, scope **Marketplace › Manage**), given as `-p <token>`, the
`VSCE_PAT` environment variable, or `npx vsce login ntson9p`. Azure DevOps is retiring such
"global" tokens: in November 2026 its blog said January 27, 2027, and VS Code's publishing
guide still said December 1, 2026. After that, publish through the workflow. Push the matching
tag afterwards, so the repository records what was published, and when the workflow then asks
for approval to publish, reject it: the Marketplace already has that version.
