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

## Deviations

- **T1 (CI perf job authored, never executed):** the repository has no remote by owner
  decision (see PHASE-08 skip note + project constraints), so no GitHub Actions run has ever
  executed — the `perf` job in `.github/workflows/ci.yml` is authored per spec but "green on
  all OSes" is unverifiable; the acceptance evidence is local Windows runs recorded in
  `docs/perf.md`. The same applies to the pre-existing `check`/`integration`/`package` jobs.
- **T1 (perf runs need isolation):** benchmark numbers are only meaningful with nothing else
  running — a concurrent Playwright run inflated log-first-paint ~1.5× and tripped the budget
  spuriously. CI runners are isolated by construction; local runs must be too (noted in
  docs/perf.md).
- **T1 (frame budget measured as frame deltas):** §13's "canvas redraw ≤ 8 ms/frame" is not
  directly observable without instrumenting the draw path; the Playwright spec
  (`webview-ui/tests/perf.spec.ts`) asserts the observable form — median rAF frame delta holds
  60 fps (≤ 17.5 ms) with p95 ≤ 35 ms while scrolling the 100k-commit mock — where an
  over-budget redraw would surface as missed frames. Layout cost itself is separately bounded
  by P4-T2's vitest benchmark (100k < 400 ms).
- **T1 (snapshot overhead has no §13 row):** measured and recorded (before/after in
  docs/perf.md) but not budget-asserted; the measurement exposed a real defect — the fully
  synchronous per-file gzip pipeline blocked the extension host ~9 s at 2k dirty files — fixed
  by a bounded-concurrency async capture in `snapshotStore.ts` (threadpool gzip, deterministic
  manifest order preserved).
- **T1 (memory budget interpreted as session delta):** the §13 row bounds "extension-host
  memory with a 100k-commit log session"; the extension host's absolute RSS includes VS Code
  baseline (~180 MB before any log work), so the assertion bounds the session's RSS *delta*
  (≤ 150 MB); both numbers are recorded.
- **T1 (fsmonitor prompt, no new setting):** the large-repo playbook is a one-time prompt
  remembered in `globalState` (per the phase's "no new feature surfaces" rule) with
  `GITTREE_TEST_LARGE_REPO_THRESHOLD`/`GITTREE_TEST_PLAYBOOK_CHOICE` seams; commit-graph
  maintenance already ships via P4-T1.
- **T1 (playbook e2e skips on this machine):** the development machine runs git 2.28 —
  below the builtin-fsmonitor floor (2.37) — so the capability gate correctly suppresses the
  offer and `phase10.test.ts` self-skips (asserted logic would otherwise set
  `core.fsmonitor=true`, which pre-2.37 git misreads as a hook path — the gate exists for
  exactly this). The enable-path e2e runs wherever `caps.fsmonitor` holds, e.g. the CI
  system-git lane (authored, never executed — no remote).
- **T2 (HC screenshots "attached to PR"):** no PRs exist (no remote, owner decision), so the
  high-contrast evidence is the `forced-colors`/theme-variable audit recorded in
  `docs/keyboard.md` plus a manual pass over log/rebase/merge under both HC themes and a
  Windows Contrast Theme. The `aria-live`/label/focus behaviors are Playwright-asserted
  instead of screenshotted.
- **T2 (audit scope):** the spec's webview list includes "PR timeline" (P8 — skipped by owner
  decision) and "compare" (shipped as native VS Code diff/tree UI, which inherits workbench
  accessibility); the shipped webviews are log and rebase, both audited. The demo webview is a
  debug-only surface (`gittree.debug.webviewDemo`) and was left out of scope.
- **T2 (IntelliJ keymap as when-gated bindings):** "toggles a contributed keybindings JSON
  users can import" is implemented as `contributes.keybindings` entries `when`-gated on
  `config.gittree.keymap.intellij` — VS Code cannot contribute keybindings conditionally, and
  when-gated bindings behave identically to an imported set while remaining rebindable and
  uninstallable via one setting. Known shadowings (Ctrl+K chord prefix, Ctrl+Shift+K delete
  line, Ctrl+T symbol search) are deliberate IntelliJ flavor, documented in docs/keyboard.md,
  and off by default.
- **T2 (stage hunk keybinding):** `gittree.stage.hunkAt` is a CodeLens target that requires a
  hunk argument, so it cannot be bound to a key directly; keyboard hunk staging is the
  already-bound `Ctrl+Alt+Enter` → `gittree.stage.selectedRanges` (select the hunk's lines
  first), which the audit records as the parity route.
- **T2 (graphPalette is a new setting):** the phase's "no new feature surfaces" note lists
  only `gittree.telemetry.enabled` and `gittree.keymap.intellij`, but T2's step 3 explicitly
  requires a "color-blind-safe graph palette variant setting" — shipped as
  `gittree.log.graphPalette` (`default`/`colorBlind`, Okabe–Ito), applied live on config
  change via a session re-init.
- **T3 (no provider step in the walkthrough):** the spec's step list ends with "connect
  GitHub/GitLab" — P8 is skipped by owner decision, so the walkthrough ships the other six
  concerns as seven steps (mode, paradigm, playground, first commit, conflict, log, blame)
  and no provider step exists to connect.
- **T3 ("user-tested script" acceptance):** no second user or fresh-profile tester is
  available in this environment. Evidence instead: the playground e2e
  (`phase10.test.ts` — pending edit commits cleanly, `feature/polish` rebase conflicts
  exactly on `src/greeting.js`, non-empty target refused), walkthrough completionEvents wired
  to the real commands, and the recorded keyboard-only walkthrough in docs/keyboard.md which
  follows the same route.
- **T3 (README matrix "zero unshipped ✅"):** satisfied by marking FEATURES.md §7 as
  "⏭️ skipped by decision" rather than ✅ — the matrix contains no ✅ that is not shipped,
  and no shipped pillar is unticked.
- **T3 (screenshots, no gifs):** README/marketplace images are captured from the real
  webview bundles rendered against the mock hosts (webview-ui/tests/capture.spec.ts, manual
  `GITTREE_CAPTURE=1` run — excluded from the test gate) under a Dark-Modern variable set;
  full-window VS Code recordings/gifs are not produced (no screen-recording pipeline in this
  environment).
- **T3 (whatsNew is a new setting):** step 4 requires the notification to be
  "setting-gated"; shipped as `gittree.whatsNew.enabled` (default on) — same
  contributions-note deviation as T2's graphPalette.
- **T3 ("changelog webview reusing markdown renderer"):** implemented as VS Code's own
  markdown preview opened on the packaged CHANGELOG.md (`markdown.showPreview`) — the same
  renderer every changelog view uses, without shipping a bespoke webview; notification fires
  once per minor (globalState), never on fresh installs.
- **T3 (marketplace gallery assets):** icon.png (Playwright-rendered from SVG) and
  galleryBanner are in package.json and the VSIX; there is no marketplace listing to verify
  them against (no publisher account — owner constraint, see T5).
- **T4 (no telemetry backend → no `@vscode/extension-telemetry`):** the spec names the
  library, but it requires an Application Insights connection string and the owner ruled out
  any telemetry backend. `src/core/telemetry.ts` implements the same double-gate semantics
  (VS Code telemetry level via `vscode.env.isTelemetryEnabled` AND `gittree.telemetry.enabled`,
  default OFF), the schema-allowlisted serializer (unit-tested: unknown events refused,
  unknown keys stripped, non-slug strings — paths/shas/messages — rejected by shape), and a
  pluggable `TelemetrySender` whose shipped implementation is a deliberate no-op. Wiring a
  real reporter is a drop-in sender replacement for whoever provisions a backend. Nothing is
  transmitted today regardless of settings, and the setting description says so.
- **T4 (feature-first-use coverage is partial):** the schema and deduping API exist
  (`featureFirstUse`), wired for the onboarding commands; retrofitting a first-use call into
  every feature entry point across P1–P9 modules would violate the append-only discipline for
  a metric with no backend — future call sites are one-liners. Activation timing, op-duration
  histograms (new `durationMs` on `FinishedMutationEvent`) and error kinds are wired centrally.
- **T4 ("Report issue" targets an unverifiable URL):** the pre-filled GitHub new-issue URL
  points at the package.json repository, which has no live remote (owner constraint). The
  command, sanitizer (paths → sha256#8 stand-ins) and URL builder are unit- and e2e-tested;
  opening the URL in a browser is the user's action and transmits nothing by itself.
- **T4 (trace levels stay boolean):** the spec's "off/messages/verbose" maps onto existing
  semantics rather than a new enum setting: always-on categorized `appendLine` lines are the
  "messages" level, `gittree.trace: true` is "verbose" (timestamped per-call tracing), false
  is "off" for the verbose stream. Changing the setting's type would break existing values
  for no behavioral gain. Categories normalized: `[exec] [queue] [watch] [webview] [sync]
  [branches] [log] [merge] [rewrite] [shelf] [local-history] [perf] [onboarding] [telemetry]`.
- **T4 (dialog acceptance):** "forced failure of each kind shows its dialog" is verified as:
  per-kind copy asserted distinct + actionable for all 7 `GitErrorKind`s (e2e via the
  debugRegistry seam), and the generic presenter wired into the sync-command path (kinds with
  richer flows — smart checkout, conflict sessions, lease refusal, publish-upstream — keep
  their dedicated UX and never reach it).

## Contributions added this phase
Walkthrough `gittree.gettingStarted`; commands `gittree.{openWalkthrough,reportIssue,generatePlayground}`; settings `gittree.telemetry.enabled`, `gittree.keymap.intellij`; no new feature surfaces.

## Parity checklist
- [x] Master §13 budgets enforced in CI (job authored + all budgets green locally; CI itself has never executed — no remote, see Deviations)
- [x] Keyboard/a11y walkthrough passes end-to-end (docs/keyboard.md: audit checklist + recorded walkthrough; HC evidence local — no PR, see Deviations)
- [x] Onboarding reaches first commit + first resolved conflict unaided (walkthrough + playground; e2e-verified repo shape, no human tester — see Deviations)
- [x] Telemetry opt-in and content-free (double-gated, schema-allowlisted, no-op sender — no backend by owner decision, see Deviations)
- [ ] FEATURES.md line-by-line audit merged — the 100%-parity sign-off artifact
