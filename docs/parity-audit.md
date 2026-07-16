# FEATURES.md parity audit — definition of done (P10-T5)

Line-by-line walk of [FEATURES.md](../FEATURES.md) against the shipped build
(`gittree-0.0.1.vsix`, 2026-07-16). Legend: ✅ shipped and verified by the
referenced tests · ⏭️ intentionally unshipped by project-owner decision.
This audit closing is the project's "100% parity" definition-of-done; the
README feature matrix is derived from it.

Verification base: 400 unit tests, 108 integration tests (+1 capability
skip), 26 Playwright webview tests, §13 perf budgets green locally
(docs/perf.md). CI matrices are authored but have never executed — no
remote (see PHASE-10 Deviations).

## §1 Global UI & editor integration

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Color-coded gutter line tracking (green/blue/grey) | ✅ | P1 QuickDiffProvider (`gittree.quickDiff.base` index/head); VS Code renders the standard gutter colors |
| Click-to-diff floating inline diff | ✅ | The gutter peek over GitTree's quick-diff base shows original vs current |
| Inline rollback of a hunk from the popup | ✅ | `gittree.revert.hunkAt` / `gittree.hunk.rollback` (peek/editor menus); e2e in phase03 |
| Stash/commit icon on the popup | ✅ | `gittree.hunk.stage`, `gittree.hunk.openCommitView` |
| Toggleable gutter blame ("Annotate with Git Blame") | ✅ | P4 `BlameUi`, `gittree.blame.toggle` (`Ctrl+Alt+G B`), editor context menu |
| Blame shows author, date, hash per line | ✅ | `gittree.blame.format` (`${author\|12} ${date\|relative} ${sha\|7}`) |
| Color fading = age heat-map | ✅ | `gittree.blame.heatmap` (newest brightest); unit-tested in blameService/blameUi suites |
| Click annotation → commit in Git Log | ✅ | `gittree.blame.revealCursorCommit` → `logView.revealCommit`; `gittree.blame.showDiff` |
| VCS status widget: branch + sync arrows, bottom status bar | ✅ | P1 `StatusBarController` (ahead/behind counts, fetch spinner) |
| Widget click opens the Branches popup | ✅ | Status-bar command opens the P2 branches QuickPick |

## §2 Branch management (Branches popup)

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Search bar filtering branches | ✅ | Native QuickPick filtering over the popup |
| Categories: Current / Recent / Local / Remote | ✅ | P2 `RefService`; `gittree.branches.recentCount` (checkout-frequency based) |
| Favorites (star to pin) | ✅ | `gittree.branches.toggleFavorite`, pinned section |
| Smart Checkout on dirty-checkout failure | ✅ | P2 `smartCheckout` (`gittree.smartCheckout.behavior` ask/auto/never): stash → checkout → unstash → conflict flow; e2e "smart checkout stashes, switches and restores" |
| Checkout | ✅ | `gittree.branches.checkout` (`gittree.branches.defaultAction`) |
| Checkout and Rebase onto Current | ✅ | `gittree.branches.rebaseOntoCurrent` |
| New Branch from Selected | ✅ | `gittree.branches.newFrom` (+ `new`) |
| Compare with Current (unified commits + diffs view) | ✅ | `gittree.branches.compareWithCurrent` / `compareInLog` (range mode marks sides — logService test) |
| Show Diff with Working Tree | ✅ | `gittree.branches.diffWithWorkingTree` |
| Rename / Delete / Push | ✅ | `gittree.branches.{rename,delete,push}` |

## §3 Commit lifecycle

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Changelists paradigm (index-bypassing buckets) | ✅ | P3 `ChangelistService`: multiple lists, active list, auto-adoption, per-list commit (`gittree.changelist.*`, `commitList`); 12 unit + e2e |
| Check/uncheck files within lists to commit | ✅ | Checked-file commit flow (index-bypassing pathspec commit) |
| Staging paradigm (Staged/Unstaged split) | ✅ | P3 staging view; paradigm switch `gittree.commit.switchParadigm`, both directions e2e |
| Hunk/line-level staging via `>>` | ✅ | Diff-editor CodeLens "Stage hunk ≫" + `Ctrl+Alt+Enter` selected-range staging; byte-exact CRLF round-trip tests (patchBuilder ×16) |
| Pre-commit: Reformat Code (modified lines only) | ✅ | `gittree.commit.checks.reformat` — modified-range formatting |
| Pre-commit: Optimize Imports | ✅ | `gittree.commit.checks.optimizeImports` |
| Pre-commit: Analyze Code (halt + review prompt) | ✅ | `gittree.commit.checks.analyze` — waits for diagnostics, warns, commit-anyway flow |
| Pre-commit: Check TODOs | ✅ | `gittree.commit.checks.todo` + `todoPattern` |
| Pre-commit: Cleanup | ✅ | `gittree.commit.checks.cleanup` (source.fixAll) |
| Commit message history dropdown | ✅ | `gittree.commit.showMessageHistory` (`Ctrl+Up` in the SCM input) |
| Amend checkbox | ✅ | `gittree.commit.toggleAmend` / `gittree.commitAmend` (previous message loaded) |
| Sign commit (GPG toggle) | ✅ | `gittree.commit.toggleSign` (gpg pinentry notes in docs/faq.md) |

## §4 Git log & history

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Optimized color-coded topological graph | ✅ | P4 canvas graph; 100k commits, 60 fps scroll (perf spec), ≤8 ms redraw budget via frame deltas |
| Date / Topo / IntelliSort | ✅ | `gittree.log.sort` + toolbar selector (`intelli` = IntelliSort) |
| Filters: Branch / User (autocomplete) / Date / Path, intersecting | ✅ | P4 FilterBar chips + `LogFilter` intersection; author autocomplete cached by HEAD (logService test) |
| Interactive rebase from selection (drag-drop, pick/squash/reword/fixup/drop) | ✅ | P5 rebase editor: pointer drag + `Alt+↑/↓`, hotkeys p/r/s/f/d, message editing; 8 Playwright + e2e suites |
| Undo Commit (reverse patch into staging) | ✅ | `gittree.commit.undo` (P5, e2e "undo reconciliation") |
| Revert Commit | ✅ | `gittree.commit.revert` (merge commits use `-m 1` — e2e) |
| Cherry-Pick | ✅ | `gittree.commit.cherryPick` (+ `gittree.cherryPick.recordOrigin` `-x`; multi-pick with mid-sequence conflict e2e) |
| Drop Commit (background rebase) | ✅ | `gittree.commit.drop` + undo-drop recovery flow |

## §5 3-way merge conflict resolution

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Conflicts dialog on merge conflict | ✅ | P6 conflict session view (auto-created from any conflicting op — merge, rebase, pick, stash, unshelve) |
| Three-pane window: Local / Result / Remote | ✅ | P6 tri-editor (`gittree.merge.open`) |
| Magic wand auto-resolving simple conflicts | ✅ | `gittree.merge.magicWand`(`Session`) — 37-test golden fixture suite (≥25 triples) |
| Chevron accepts per conflict block | ✅ | `gittree.merge.acceptYours/acceptTheirs/acceptBoth` + `acceptFocusedSide` (`Alt+Enter`), `F7`/`Shift+F7` navigation |
| Center pane is a real editor (highlighting + autocomplete) | ✅ | Result pane is a genuine VS Code text editor — full IntelliSense/keybindings |
| Accept Left / Accept Right global buttons | ✅ | `acceptAllYours`/`acceptAllTheirs` (session) and `acceptFileYours`/`acceptFileTheirs` (file) |

## §6 Stash and shelve

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Standard stash GUI: save, list, diff vs working tree, pop/apply | ✅ | P7 stash view — push (message, options, file subset), apply/pop `--index`, drop/clear/branch/copyMessage, diff rows + Compare All |
| Shelve stores patches outside `.git` | ✅ | P7 `ShelfStore` under global storage / `gittree.shelf.path`; sha256-integrity-gated |
| Survives repo deletion / destructive git ops | ✅ | e2e: `rm -rf .git` + re-init still lists and unshelves |
| Shelf tab: view patches, edit them, unshelve to working tree | ✅ | P7 shelf view with in-memory diff previews, validated patch editing (re-consecration), full/partial unshelve with conflict-safe apply ladder + P6 session handoff |

## §7 Deep provider integrations (GitHub / GitLab)

| Item | Status | Notes |
| --- | --- | --- |
| Pull Requests tool window (filter by assignee/author/state) | ⏭️ | Skipped by project-owner decision (2026-07-16): requires live provider accounts and remote actions, neither available nor permitted. |
| In-IDE review: line comments, submit review, merge | ⏭️ | Same. |
| Timeline view: conversation, CI status, commit list | ⏭️ | Same. Rationale + future-implementer onboarding guide: [plan/PHASE-08-provider-integrations.md](plan/PHASE-08-provider-integrations.md). Git-protocol work against any remote is unaffected (§2 push, fetch/pull, askpass auth all shipped). |

## §8 Local History failsafe

| Item | Status | Shipped as / evidence |
| --- | --- | --- |
| Records saves, task runs and git operations independently of git | ✅ | P9: save-time snapshots (`gittree.localHistory.snapshotOnSave`), task labels (`taskLabels`), and the master-§10 destructive-op matrix (Before/After snapshots around reset, rebase, checkout-with-changes, stash/shelve-with-remove, …) — 10-test coverage-matrix suite |
| Restore state from minutes ago after a bad destructive command | ✅ | `gittree.history.{show,showForPath,restoreSnapshot,restoreFiles,diffFile}`; external `reset --hard` detection + `recoverCommit` from the reflog (e2e) |
| Bridge to VS Code's native Timeline | ✅ | P9 Timeline provider integration |
| Invisible, size-bounded storage | ✅ | Content-addressed gzip store, GC oldest-first by `maxSizeMb`/`retentionDays`/`maxFileSizeKb` (unit-tested); locations documented in faq.md |

## Verdict

Every FEATURES.md line item is either ✅ shipped-and-tested or ⏭️
explicitly skipped by owner decision with a documented rationale and
onboarding path — **zero unexplained gaps**. Deviations are folded into the
README matrix (§7 marked skipped) as required; "file material deviations as
issues" has no tracker to file into (no remote — the deviations live in the
phase docs' Deviations sections instead). With this audit merged, the
project's parity definition-of-done is met for the local-only scope.
