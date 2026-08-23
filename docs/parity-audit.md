# Parity audit — Tier 1 close (P13-T9)

Scored against the **rewritten** [FEATURES.md](../FEATURES.md) (P13-T9) and the inventory in
[intellij-gap-analysis.md](intellij-gap-analysis.md) §3. It replaces the 2026-07-16 audit,
which signed off line-by-line against the *old* FEATURES.md — a contract that specified
capabilities without containers, so its ✅ marks were accurate as "matches the spec" and
misleading as "matches IntelliJ".

**What changed in the method.** Every row below is scored on **shape *and* behaviour**: which
container it lives in, which toolbar or menu reaches it, and what it does. A feature that works
but sits in the wrong kind of surface scores 🟡, not ✅. That rule is the whole point of this
rewrite — it is what the previous audit could not express.

Legend: **✅** shipped, shape and behaviour · **🟡** shipped, shape differs (each one is
registered in [deviations.md](deviations.md)) · **❌** absent · **⏭️** intentionally unshipped.

**Verification base (2026-08-23):** 686 unit tests, 220 integration tests (+2 pending),
197 Playwright webview tests (+3 skipped), §13 perf budgets green (`docs/perf.md`), bundle
1.15 MB against a 2.50 MB budget. One known-red integration assertion is documented in
`docs/plan/NIGHTLOG-2026-08-23.md` (a 500 ms stash-view latency bound that this machine
now straddles); it is a budget question for the owner, not a product defect. CI matrices are
authored but have never executed — no remote (PHASE-10 deviations).

---

## Headline

| | 2026-08-20 | 2026-08-23 |
| --- | --- | --- |
| ❌ absent | 122 | **79** |
| 🟡 partial | 36 | **33** |
| ✅ at parity | 75 | **118** |

Counted the same way, over the same inventory (`intellij-gap-analysis.md` §3). The remaining
❌ is dominated by two deliberate exclusions — the Differences Viewer (D1) and provider
integrations (D11) — plus IntelliJ-platform features with no VS Code analogue.

---

## §1 Global UI & editor integration

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Gutter line tracking, bars track the index live | ✅ | P1 `quickDiffProvider` over `gittree-rev:`; `phase01` integration |
| Hunk actions from the gutter popup | 🟡 | `scm/change/title`: Stage/Unstage/Revert Hunk, Show Diff. The popup is VS Code's — no API for a bespoke one (**D1**) |
| Blame: author · date · sha per line, toggleable | ✅ | `gittree.blame.toggle` (`Ctrl+Alt+G B`), inline decorations, `blame --incremental` |
| Blame age heat-map | ✅ | `gittree.blame.heatmap`; unit-tested in the blame suites |
| Click a blame annotation → the commit in the log | ✅ | `gittree.blame.revealCursorCommit` |
| VCS status widget: branch + ahead/behind + fetch spinner | 🟡 | `StatusBarController` — status bar, not a top toolbar (**D4**) |
| Widget click opens the Branches popup | ✅ | `gittree.branches.open` |

## §2 Branch management (the popup as an action hub)

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Native popup with type-ahead over branches **and actions** | ✅ | P13-T5 `branchesPopup.ts`; `phase13branches` asserts `merge` finds an action |
| Top-level verbs first (Update/Commit/Push/New Branch/Checkout Revision) | ✅ | `HUB_VERBS`; test asserts they precede every branch row |
| Sections Current/Favorites/Recent/Local/Remote-per-remote/Tags | ✅ | `buildPopupItems` |
| Folder rows folding a prefix | ✅ | drill-in with `‹ Back` and a breadcrumb title |
| Typing searches flat across every level | ✅ | folders collapse while filtering — pinned by test |
| Header: new branch · fetch · incoming/outgoing toggle · gear | ✅ | P13-T5 |
| `›` per-row submenu, full reference list, names interpolated | ✅ | `branchActions.ts` → popup, tree view, log pane |
| Irrelevant submenu items hidden, not disabled | ✅ | asserted across local / remote / tag / current |
| **`Merge 'X' into '<current>'` reachable without dragging** | ✅ | `gittree.branch.mergeIntoCurrent`; real merge asserted from the command |
| `Rebase '<current>' onto 'X'` | ✅ | `BranchOps.rebaseCurrentOnto` |
| `Pull into '<current>'` | 🟡 | merge variant only; no rebase variant |
| `New Worktree from 'X'…` | ✅ | → P13-T6 dialog |
| Smart Checkout | ✅ | `smartCheckout.ts`, conflicts routed into the merge flow |
| In-place collapsible tree | 🟡 | drill-in instead — `QuickPick` cannot render a tree (**D5**) |

## §3 Commit lifecycle (commit tool window)

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| One tool window with `Commit \| Shelf` tabs, first in the SCM container | ✅ | P11-T2 `gittree.commit` webview |
| Toolbar strip (refresh, rollback, diff, shelve, preview, expand/collapse) | ✅ | P11-T2 |
| Folder rows with single-child chains collapsed | ✅ | `treeModel.buildTree` |
| Tri-state checkboxes on group, folder and file rows | ✅ | P11-T2/T3 — impossible in `TreeView` |
| Unversioned files tickable | ✅ | P11-T3 |
| Per-change inclusion with `N differences, M included` | ✅ | P11-T3 `InlineDiff`; stale selections fall back loudly |
| Message editor with history, template, amend | ✅ | P11-T4 |
| Options gear: author, sign-off, deferred checks | ✅ | P11-T5 |
| Commit checks (reformat, imports, cleanup, analyze, TODO) | 🟡 | no IntelliJ inspection *profiles* — no analogue (**D7**) |
| IME composition in the message editor | 🟡 | event contract covered; **needs one manual pass on a real OS IME** |

## §4 Git log & history (Git tool window)

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Bottom tool window with `Log \| Console` tabs | ✅ | P12-T1, P12-T8 |
| Four panes in persisted splitters, each with a toolbar | ✅ | P12-T1/T2/T3 |
| Branches pane + vertical icon rail | ✅ | P12-T2 |
| Graph, 100k commits, filters, search, sorts (incl. IntelliSort) | ✅ | P4 + P12-T5; perf-gated |
| Presentation & highlight menus | 🟡 | *Collapse linear branches* / *Show long edges* omitted — they need whole-graph edge spans the row-local model cannot give (recorded in PHASE-12) |
| Go to Hash / Branch / Tag | ✅ | P12-T4 |
| Commit context menu (28 items) | ✅ | P12-T7 — incl. fixup/squash, push-all-up-to-here, reset **Keep**, show-repo-at-revision |
| Changed Files pane with counts, status colors, toolbar | ✅ | P12-T3 |
| Console tab: every git command, redacted | ✅ | P12-T8; read-only by design (**D10**) |
| `Repository` / `Incoming` / `Update Info` tabs | 🟡 | Update Info replaced by a result notification (**D9**); the other two absent |

## §5 Merge & conflict resolution

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| `Files Merged with Conflicts` gate, tree view retained | ✅ | P13-T8; once per session, `gittree.merge.conflictsDialog` to disable |
| Three panes, centre a real editor | ✅ | P6-T3 `TriMergeEditor` — **a win over a webview** (**D14**) |
| `Apply non-conflicting changes` Left · All · Right | ✅ | P13-T8; Left/Right act on the conflict blocks (**D17**) |
| Live counter `No changes. N conflicts.` | ✅ | P13-T8, in the status bar |
| Per-side `Show Details` | ✅ | P13-T8 — sha · author · date · subject |
| `Accept Yours` / `Accept Theirs` as explicit verbs | ✅ | toolbar + tree, distinct from the applies |
| Magic Wand rule cascade | ✅ | P6-T5, property-tested against real git |
| Chevrons, F7 navigation, sync scroll, undo | ✅ | P6-T4 |
| Pane headers naming the actual refs | 🟡 | titles are `(Yours)`/`(Theirs)`; the refs are one click away in Show Details |

## §6 Stash & shelve

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Stash view, create/apply/pop/drop/clear/branch | ✅ | P7 |
| `Stash Changes` dialog with `--keep-index`, `--all`, `--staged` | ✅ | P13-T4; `--staged` gated on git ≥ 2.35 with the reason stated |
| `Unstash` dialog: list, pop, reinstate index, changelist, inline diff | ✅ | P13-T4 |
| Shelf outside `.git`, Shelf tab, partial shelve, import/export | ✅ | P7 + P11-T6/T7 |
| Silent shelve/unshelve shortcuts, Recently Deleted node | ❌ | IntelliJ-platform conveniences; not planned |

## §7 Provider integrations

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Pull requests, in-IDE review, CI status, remote actions | ⏭️ | **Skipped by owner decision** (**D11**). No account, no network calls of any kind |

## §8 Local History

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Snapshot before every destructive operation | ✅ | P9-T2; table-driven coverage test over `SNAPSHOT_LABELS` |
| Byte-exact restore, paranoia snapshot, undo restore | ✅ | P9-T3 |
| Dangling-commit recovery from the reflog | ✅ | P9-T4 |
| Save-centric timeline (every save, refactoring, test run) | 🟡 | operation-centric by default; save snapshots opt-in (**D12**) |

## §9 Dialogs, popups, action hub

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Push · Update Project · Merge · Rebase · Reset · Rollback | ✅ | P13-T1…T3 |
| Cherry-pick · Stash · Unstash · Apply Patch · Clone · Manage Remotes | ✅ | P13-T4 — `Manage Remotes` had **no command at all** before |
| "Modify options" pattern with reasons for rejected combinations | ✅ | `ModifyOptions.tsx`; un-ticking clears the flag |
| Every dialog previews the exact command it runs | ✅ | one argv builder imported by both halves |
| VCS Operations Popup on `` Alt+` `` | ✅ | P13-T7, enumerated from the registries |
| Dialogs are OS-modal | 🟡 | focus-trapped editor-area panels — VS Code has no modal webview (**D2**) |

## §10 Worktrees

| FEATURES.md item | Status | Shipped as / evidence |
| --- | --- | --- |
| Worktrees view: path, branch, locked/prunable | ✅ | P13-T6 |
| New Worktree dialog (existing / new-from / detach, location, options) | ✅ | P13-T6 |
| Open · Remove · Lock · Unlock · Prune | ✅ | P13-T6; dirty removal refused with git's reason |
| Lock/prunable reported by the porcelain | 🟡 | derived from disk on git < 2.36 (**D16**) |

---

## What is still open, and why

| Area | Why |
| --- | --- |
| **Differences Viewer** (S5) | VS Code exposes no API to put controls inside a diff editor. Tier 2; routes A/B/C costed in `deviations.md` (**D1**) |
| **Provider integrations** | Owner decision, standing constraint (**D11**) |
| Graph *Collapse linear branches* / *Show long edges* | Needs whole-graph edge spans; the row-local model exists to hold the 100k-commit perf budget |
| IntelliJ-platform features | Inspection profiles, run configurations before commit, rearrange/copyright, directory-mapping settings — no VS Code analogue |
| Long tail of conveniences | Silent shelve shortcuts, multi-select batch branch ops, protected branches, unshallow, clipboard patches |

Nothing in this table is a regression, and nothing here is claimed as parity elsewhere in the
documentation. Anything not in `deviations.md` is a gap, not a decision.
