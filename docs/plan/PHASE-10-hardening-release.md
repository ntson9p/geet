# Phase 10 — Hardening, Performance & Release

**Goal:** Turn the feature-complete extension into a shippable product: enforced performance budgets, accessibility and keyboard parity, onboarding, opt-in telemetry, docs, and a Marketplace release pipeline. Also the final 100%-parity audit against FEATURES.md.

**Depends on:** all prior phases feature-complete on `main`.
**Exit criteria:** benchmarks green in CI against master-§13 budgets; a11y audit passes; fresh-user onboarding reaches first commit without docs; `vsce publish` pipeline produces signed pre-release + stable channels.

---

## Tasks

### P10-T1 · Performance pass & CI benchmarks
**Depends:** — · **Complexity:** L
**Output files:** `test/perf/**` (benchmark runner + fixtures), CI `perf` job, targeted fixes across modules.
**Steps:**
1. Benchmark harness (extension-host, `perf_hooks`, medians of 5): activation sync path; status refresh @ 10k dirty-capable files; log first paint + scroll frame time @ 100k commits (synthetic `fast-import` fixture); blame cold/warm @ 5k lines; snapshot overhead @ 2k dirty files; memory RSS ceiling after log session. Budgets from master §13 encoded as assertions with 15% CI-noise tolerance; regression fails the PR.
2. Known hot spots to profile and fix: parser allocation churn (reuse buffers), decoration re-creation on blame recompute (diff decoration sets), graph canvas over-draw (dirty-row tracking), status flood under branch switch (verify suppression window), webview message batching (coalesce row pages).
3. Startup audit: activation does nothing but wire lazily (`import()` heavy modules on first use); `onStartupFinished` path verified < 100 ms sync; log webview code-split.
4. Large-repo playbook: auto-suggest `core.fsmonitor` + `core.untrackedCache` on repos > 50k files (one-time prompt, capability-gated), maintenance task for `commit-graph`.
**Accept:** perf job green on all OSes; before/after numbers recorded in `docs/perf.md`; no feature regressions (full suite).

### P10-T2 · Accessibility & keyboard-parity audit
**Depends:** — · **Complexity:** M
**Output files:** fixes across webviews/views; `docs/keyboard.md`; default keybindings block in `package.json`.
**Steps:**
1. Webview audit (log, rebase, PR timeline, compare): tab order, roving tabindex in virtual lists, `aria-live` for async loads, focus-visible outlines, HC theme (forced-colors) rendering, screen-reader labels on graph rows (`aria-label`: "commit <subject> by <author>, <date>, branch <refs>").
2. Every mouse affordance has a command + keybinding: chevron accepts (`alt+enter`), next/prev conflict (`F7`), stage hunk, rebase reorder (`alt+↑/↓`), log filter focus, blame toggle. Publish an IntelliJ-keymap-flavored optional keybinding set (`gittree.keymap.intellij` toggles a contributed keybindings JSON users can import).
3. Reduced-motion respect in webview animations; color-blind-safe graph palette variant setting.
**Accept:** manual audit checklist committed; keyboard-only walkthrough (clone→branch→edit→resolve conflict→commit→log→rebase) recorded in test notes; HC screenshots attached to PR.

### P10-T3 · Onboarding, docs & migration
**Depends:** — · **Complexity:** M
**Output files:** `contributes.walkthroughs` entry, `README.md` (feature matrix + screenshots/gifs), `docs/{migration-from-builtin.md,settings.md,faq.md}`, marketplace `gallery` assets.
**Steps:**
1. Walkthrough steps: pick mode (takeover/companion, runs the P0-T7 consent flow), choose commit paradigm, tour the log tool window, resolve a sample conflict (bundled playground repo generator command), enable blame, connect GitHub/GitLab.
2. README: FEATURES.md-derived parity matrix (✅ per shipped item — final audit lives here), quick-start, screenshots per pillar.
3. `settings.md` generated from `package.json` configuration (script keeps it honest); FAQ covers coexistence, gpg on Windows, self-hosted providers, local-history storage location.
4. In-product "What's new" notification per minor (changelog webview reusing markdown renderer, dismissible, setting-gated).
**Accept:** fresh profile + walkthrough reaches first commit and first resolved conflict without external docs (user-tested script); README matrix has zero unshipped ✅.

### P10-T4 · Telemetry, error reporting & log polish
**Depends:** — · **Complexity:** S
**Output files:** `src/core/telemetry.ts`, ErrorHandler final pass.
**Steps:**
1. `@vscode/extension-telemetry` wrapper honoring `telemetry.telemetryLevel` + our own `gittree.telemetry.enabled` (both must allow); events: activation timing, feature-first-use counters, op duration histograms, error kinds — **never** repo names, paths, shas, messages, or file contents (schema-reviewed allowlist, unit-tested serializer strips unknown keys).
2. Error UX final pass: every `GitError.kind` mapped to actionable copy + docs deep-link; "Report issue" button pre-fills a sanitized GitHub issue (versions, capability map, trace tail with paths hashed).
3. OutputChannel: consistent categories (`[queue] [exec] [watch] [webview]`), `gittree.trace` levels off/messages/verbose.
**Accept:** telemetry schema test green; forced failure of each kind shows its dialog; issue template renders sanitized.

### P10-T5 · Packaging & release pipeline
**Depends:** T1–T4 · **Complexity:** S
**Output files:** `.github/workflows/release.yml`, `CHANGELOG.md` process, publisher assets.
**Steps:**
1. Release workflow: tag `v*` → full test+perf matrix → `vsce package` → publish **pre-release** channel; manual approval gate → stable publish + GitHub Release with changelog extract; provenance: pin action shas, `npm ci` with lockfile audit.
2. Versioning: pre-release = odd minor (VS Code convention); `engines` floor re-verified; bundle-size budget (< 2.5 MB vsix sans images) asserted.
3. Final **parity audit task**: walk FEATURES.md line-by-line against the shipped build; each item gets ✅/deviation note; deviations folded into README matrix and, if material, filed as issues. This audit closing = project "100% parity" definition-of-done.
**Accept:** dry-run publish to a test publisher succeeds from CI; parity audit document merged with zero unexplained gaps.

---

## Contributions added this phase
Walkthrough `gittree.gettingStarted`; commands `gittree.{openWalkthrough,reportIssue,generatePlayground}`; settings `gittree.telemetry.enabled`, `gittree.keymap.intellij`; no new feature surfaces.

## Parity checklist
- [ ] Master §13 budgets enforced in CI
- [ ] Keyboard/a11y walkthrough passes end-to-end
- [ ] Onboarding reaches first commit + first resolved conflict unaided
- [ ] Telemetry opt-in and content-free
- [ ] FEATURES.md line-by-line audit merged — the 100%-parity sign-off artifact
