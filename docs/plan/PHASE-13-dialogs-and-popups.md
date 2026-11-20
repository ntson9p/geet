# Phase 13 — Dialogs, Popups and the Action Hub (Tier 1)

**Goal:** close gap-analysis **S3, S4, S6, S7** and §3.2/§3.5/§3.7/§3.10 — replace the
QuickPick/InputBox chains that stand in for IntelliJ's dialogs (25 call sites) with real
option-bearing dialogs, turn the flat branches QuickPick into an action hub with per-row
submenus, add the VCS Operations Popup, and finish the merge dialog's apply-non-conflicting
model. Target shapes are `docs/intellij-gap-analysis.md` §2A ("Push dialog", "Update Project
dialog", "Merge Revisions dialog", "Branches popup", "Branch row submenu expanded").

**Depends on:** P11-T1 (`dialogHost`, `Dialog`, `FileTree`, `Menu`, `InlineDiff`),
P12-T6 (patch engine), P2 (branch ops), P6 (merge engine).
**Exit criteria:** every flow in the table below opens a dialog that exposes its real git
flags; the branches popup reaches every action in the reference submenu — including
`Merge 'X' into '<current>'`, which today is reachable **only by drag-and-drop**; `Alt+``
opens a context-aware operations hub.

---

## Tasks

### P13-T1 · Push dialog
**Depends:** P11-T1 · **Complexity:** M
**Output files:** `webview-ui/src/dialogs/Push.tsx`, `src/scm/dialogs/pushDialog.ts`.
**Steps:**
1. Layout per §2A: title `Push Commits to <repo>`; left pane a per-branch-pair commit list
   headed `<local> → <remote> : <remote-branch>` (the arrow row is editable — clicking the
   target lets you retarget); right pane the **full changed-file tree of the push** with
   `N files` counts and status colors, plus a right-side toolbar (show diff, preview,
   edit, group-by).
2. Footer: `?` · `[ ] Push tags: [All ▾ | Current Branch]` · `[x] Run Git hooks` ·
   `[Push ▾]` split button (`Push`, `Force Push…`) · `[Cancel]`.
3. Flags reaching argv: `--tags` / `--follow-tags`, `--no-verify` (inverse of Run Git hooks),
   `--force-with-lease` for the force path, `--set-upstream` when no upstream exists.
   Force push keeps the P5 safety confirmation.
4. Multi-repo: one section per repository, each independently checkable.
**Accept:** unit — argv assembly for every flag combination, including tags-with-force and
publish-branch; integration — the changed-file tree matches `git diff --name-status
<remote>/<branch>..<local>`; retargeting pushes to the chosen ref; `Run Git hooks` off adds
`--no-verify`.

### P13-T2 · Update Project dialog
**Depends:** P11-T1 · **Complexity:** S
**Output files:** `webview-ui/src/dialogs/UpdateProject.tsx`, `src/scm/dialogs/updateDialog.ts`.
**Steps:**
1. Layout per §2A: radio pair `(o) Merge incoming changes into the current branch` /
   `( ) Rebase the current branch on top of incoming changes`, `? [ ] Do not show again`,
   footer `[Reset to the Remote Branch] [OK] [Cancel]`.
2. `Do not show again` persists the choice to `gittree.update.strategy` and thereafter
   `Ctrl+T` runs it directly — matching IntelliJ, and reachable again from the gear.
3. `Reset to the Remote Branch` = `git fetch` + `git reset --hard <upstream>` behind an
   explicit destructive confirmation, with a P9 Local History snapshot taken first.
4. Result reporting replaces IntelliJ's `Update Info` tab: a notification summarizing
   commits pulled, files changed, and a "Show in Log" action that opens the log filtered to
   the fetched range.
**Accept:** integration — merge and rebase strategies both run and report; `Do not show again`
suppresses the dialog and the gear restores it; `Reset to the Remote Branch` is snapshotted and
recoverable via P9.

### P13-T3 · Merge · Rebase · Reset · Rollback dialogs
**Depends:** P11-T1 · **Complexity:** L
**Output files:** `webview-ui/src/dialogs/{Merge,Rebase,Reset,Rollback}.tsx`, `src/scm/dialogs/*.ts`.
**Steps:**
1. All four adopt IntelliJ's **"Modify options"** pattern: a compact primary form plus an
   options list that reveals real flags. This is S4, the biggest power-user gap — Geet
   currently hides these flags entirely.
2. **Merge:** branch/ref picker; options `--no-ff`, `--ff-only`, `--squash`, `--no-commit`,
   `--allow-unrelated-histories`, strategy + strategy-option (`ours`/`theirs`/
   `ignore-space-change`), custom message.
3. **Rebase:** onto-ref + optional from-ref; options `--interactive` (hands off to the P5
   rebase webview), `--onto`, `--preserve-merges`/`--rebase-merges`, `--autostash`,
   `--no-verify`, `--keep-empty`.
4. **Reset:** commit field (ref/hash with completion) + mode radio
   `Soft · Mixed · Hard · Keep` — `Keep` is currently missing everywhere (see P12-T7.6) —
   with a live "this will discard N local changes" line and a P9 snapshot before Hard/Keep.
5. **Rollback:** checkbox `FileTree` of the target files with `N files` counts,
   `[x] Delete local copies of added files`, and an `InlineDiff` preview of what is about to
   be reverted. IntelliJ's rollback is a dialog with a file list, not a silent action.
6. Shared: every dialog surfaces the exact command it will run in a dim "will run" line —
   cheap, and it makes the flags legible.
**Accept:** unit — argv assembly per option matrix (one test per flag, plus mutually exclusive
pairs rejected in the UI); integration — `--squash` merge leaves staged-not-committed;
`Reset Keep` refuses rather than discarding; rollback of 2 of 5 files leaves the other 3
untouched and deletes added-file copies only when ticked.

### P13-T4 · Cherry-pick · Stash · Unstash · Apply Patch · Clone · Manage Remotes
**Depends:** P11-T1, P12-T6 · **Complexity:** L
**Output files:** `webview-ui/src/dialogs/{CherryPick,Stash,Unstash,ApplyPatch,Clone,Remotes}.tsx`, `src/scm/dialogs/*.ts`.
**Steps:**
1. **Cherry-pick:** target-branch picker + options `-x` (append source line), `--no-commit`,
   `-m <parent>` for merge commits.
2. **Stash:** message field; options `--keep-index`, `--include-untracked`, `--all`.
   **Unstash:** stash list + `[x] Pop stash`, `[ ] Reinstate index`, target-changelist selector,
   and an `InlineDiff` preview.
3. **Apply Patch:** file picker → pre-apply summary from `patchParser.splitPatchFiles`
   (files + hunk counts, missing-file warnings) → options `--3way`, `--reverse`,
   `-p<n>`, `--whitespace=fix` → apply via P12-T6, reporting rejects as a file list.
4. **Clone:** URL + directory + `[ ] Recursive submodules`, `--depth`, `--branch`; validates
   the target directory is empty and offers to open the clone.
5. **Manage Remotes:** table (name, URL, fetch/push URL split) with add/edit/remove and
   `git remote prune` — **absent entirely today**, no command exists.
6. Every dialog is registered in one `dialogRegistry.ts` so P13-T7 can enumerate them.
**Accept:** integration per dialog — cherry-pick `-x` appends the source line; stash
`--keep-index` leaves the index intact; apply-patch reverse undoes a previously applied patch;
`Manage Remotes` add→fetch→remove round-trips; clone into a non-empty directory is blocked
with a clear reason.

### P13-T5 · Branches popup → action hub with per-row submenus
**Depends:** P2, P13-T6 · **Complexity:** L
**Output files:** `src/branches/branchesPopup.ts` (rewritten), `src/branches/branchActions.ts` (new registry).
**Steps:**
1. Keep `QuickPick`. Master §6 chose it over a webview for native focus, search and keyboard
   parity, and the reference screenshot vindicates that: the field reads *"Search for branches
   **and actions**"*. The gap is content and structure, not the widget.
2. **Top-level verbs first**, before any branch (per §2A):
   `Update Project… Ctrl+T` · `Commit… Ctrl+K` · `Push… Ctrl+Shift+K` · separator ·
   `New Branch… Ctrl+Alt+N` · `Checkout Tag or Revision…`. These make the popup a hub and are
   matched by the search field.
3. Sections `Recent` / `Local` / `Remote` (per remote) / `Tags`, favorites first. **Folder
   rows** built from `treeModel`: picking `feature` drills into a scoped popup with a
   `‹ Back` row and a breadcrumb title. Typing anywhere searches flat across all levels, so
   drill-in never traps the user.
4. **Per-row submenu** — a `›` `QuickInputButton` (and `→`/`Ctrl+Enter`) opens a second
   QuickPick with exactly the reference list, labels interpolated with the real branch names:
   `Checkout` · `New Branch from 'X'…` · `Checkout and Rebase onto '<cur>'` · —— ·
   `Compare with '<cur>'` · `Show Diff with Working Tree` · —— ·
   `Rebase '<cur>' onto 'X'` · `Merge 'X' into '<cur>'` · —— · `New Worktree from 'X'…` · —— ·
   `Push…` · —— · `Rename… (F2)` · `Delete`.
   Remote rows swap in `Checkout`/`Pull into '<cur>'`/`Delete on remote`.
5. **This fixes a real defect, not just a shape gap:** `branchOps.mergeIntoCurrent` has exactly
   one call site — `branchesView.ts:223`, the tree's drag-and-drop handler — so merging a branch
   into the current one is reachable *only* by dragging. `Merge 'X' into '<cur>'` gives it a
   command, a menu entry and a keyboard path.
6. `branchActions.ts` is the single registry consumed by the popup, the branches tree view and
   the P12-T2 log Branches pane, so the three surfaces cannot drift.
7. Header buttons per §2A: incoming/outgoing toggle and a gear (branch settings).
**Accept:** integration — every submenu item dispatches its command for a local branch, a
remote branch and the current branch (irrelevant items hidden, not disabled); typing `merge`
in the top-level field finds the merge action; drill-in + `‹ Back` preserves the filter;
merge-into-current works from the popup with no drag-and-drop involved.

### P13-T6 · Worktree management
**Depends:** P11-T1 · **Complexity:** M
**Output files:** `src/branches/worktrees.ts`, `webview-ui/src/dialogs/NewWorktree.tsx`, view `gittree.worktrees`.
**Steps:**
1. §3.10: worktree paths are resolved internally (`commondir`) but there is **no management
   UI and no create/remove commands**. The reference submenu's `New Worktree from 'X'…`
   requires them.
2. `New Worktree` dialog: path picker (default sibling `../<repo>-<branch>`), branch mode
   (existing / new-from), `[ ] Open in new window`, `--detach`.
3. Tree view listing worktrees (path, branch, locked/prunable), with `Open`, `Remove`,
   `Lock`/`Unlock`, `Prune`.
4. `git worktree add/list --porcelain/remove/lock/unlock/prune`; parser + fixtures in the
   P0-T3 style.
**Accept:** unit — `worktree list --porcelain` parser against fixtures (locked, prunable,
detached, bare); integration — create a worktree from a branch, see it listed, open it, remove
it; removal of a dirty worktree is refused with the git reason surfaced.

### P13-T7 · VCS Operations Popup
**Depends:** T1–T6 · **Complexity:** S
**Output files:** `src/ui/operationsPopup.ts`.
**Steps:**
1. S6 — absent entirely today. `alt+\`` (IntelliJ's binding, gated on
   `config.gittree.keymap.intellij`) opens a QuickPick of every applicable action for the
   current context, enumerated from `dialogRegistry.ts` + `branchActions.ts` so it stays
   complete by construction rather than by hand-maintained list.
2. Context sensitivity: in a diff editor it offers diff/hunk actions; on a log selection,
   commit actions; with a dirty worktree, commit/stash/shelve/rollback; during an in-progress
   operation, continue/abort/skip first.
3. Recently used actions float to the top (per workspace).
**Accept:** integration — the popup's item set differs correctly across four contexts
(clean tree, dirty tree, mid-rebase, diff editor focused); every item dispatches; no item
appears that would immediately fail its own precondition.

### P13-T8 · Merge Revisions dialog parity
**Depends:** P6 · **Complexity:** M
**Output files:** `src/merge/triEditor.ts` (toolbar extended), `src/merge/applyNonConflicting.ts`.
**Steps:**
1. The tri-editor is a genuine strength (three real editors → full LSP) and stays. The gaps are
   in its toolbar, per §2A: `Apply non-conflicting changes:` is **three** actions —
   `Left`, `All`, `Right` — where Geet's magic wand implements only `All`.
2. Add a live status string in the toolbar: `No changes. N conflicts.` / `N changes, M conflicts.`
3. Per-side `Show Details` revealing the revision behind each pane (hash, author, date).
4. `Accept Left` / `Accept Right` as explicit footer actions alongside the existing
   per-conflict accepts.
5. S7 — add a `Files Merged with Conflicts` **dialog** gate after a conflicted merge (file list
   with `Accept Yours` / `Accept Theirs` / `Merge…` / resolve-all-simple), while keeping the
   `gittree.conflicts` tree view for ongoing work. IntelliJ gates on the modal; the tree stays
   as the persistent surface.
**Accept:** integration — `Apply non-conflicting: Left` applies only left-side
non-conflicting changes and leaves right-side ones pending (asserted on result text); the
counter matches the real conflict count after each action; the post-merge dialog appears once
per conflicted merge and its resolve-all-simple matches the tree view's behaviour.

### P13-T9 · Parity re-audit, deviations register, docs
**Depends:** T1–T8, P11, P12 · **Complexity:** M
**Output files:** `FEATURES.md` (rewritten), `docs/parity-audit.md` (replaced), `docs/deviations.md`, `docs/keyboard.md`, `readme.md`, `docs/plan/PROGRESS.md`.
**Steps:**
1. **Rewrite `FEATURES.md` from JetBrains' documentation plus the §2A shapes**, every item
   carrying a *shape* criterion (container · toolbar · menu) next to its behaviour. The gap
   analysis §1 identifies the shallow spec as the root cause of this whole phase group; leaving
   it in place guarantees a repeat.
2. Replace `docs/parity-audit.md` — the old one certifies parity against the obsolete spec and
   its ✅ marks are actively misleading. New audit is scored against the rewritten `FEATURES.md`
   and the gap-analysis inventory (❌/🟡/✅ counts restated).
3. Finalize `docs/deviations.md` as the single register: every accepted divergence, its API
   reason, and — for the diff viewer — what a future phase would have to build.
4. `docs/keyboard.md` + the IntelliJ keymap gain the new bindings (`alt+\``, `ctrl+alt+n`, `F2`).
5. README parity matrix regenerated; walkthrough and what's-new updated.
**Accept:** no document still claims parity against the old spec; `docs:settings` regenerated;
`npm run check` + `test:integration` + `test:perf` green; the gap-analysis counts in §0 updated
to post-Tier-1 reality.

---

## Contributions added this phase
Commands `gittree.push.dialog`, `gittree.update.dialog`, `gittree.merge.dialog`,
`gittree.rebase.dialog`, `gittree.reset.dialog`, `gittree.rollback.dialog`,
`gittree.cherryPick.dialog`, `gittree.stash.dialog`, `gittree.unstash.dialog`,
`gittree.patch.applyDialog`, `gittree.clone.dialog`, `gittree.remotes.manage`,
`gittree.branch.mergeIntoCurrent`, `gittree.branch.checkoutAndRebase`,
`gittree.branch.newWorktree`, `gittree.worktree.{add,remove,lock,unlock,prune,open}`,
`gittree.operationsPopup`, `gittree.merge.applyNonConflicting.{left,all,right}`.
View `gittree.worktrees`. Keybindings `alt+\`` (operations popup), `ctrl+alt+n` (new branch),
`f2` (rename branch in popup) — all gated on `config.gittree.keymap.intellij`.
Settings `gittree.update.strategy`, `gittree.push.runHooks`, `gittree.push.tags`,
`gittree.dialogs.showCommandLine`.

## Parity checklist (gap-analysis S3, S4, S6, S7 · §3.2, §3.5, §3.7, §3.10)
- [x] S4 — Push · Update Project · Merge · Rebase · Reset · Rollback · Cherry-pick · Stash · Unstash · Apply Patch · Clone · Manage Remotes all have option-bearing dialogs *(P13-T1…T4; every one previews the exact argv it will run)*
- [x] S3 — branches popup opens with top-level verbs, has folder rows, and a full `›` submenu per branch *(P13-T5; typing searches flat across every level, so drill-in never traps)*
- [x] S3b — `Merge 'X' into '<current>'` reachable without drag-and-drop (fixes the `mergeIntoCurrent` defect) *(P13-T5: registry entry + `gittree.branch.mergeIntoCurrent` + tree-view menu row)*
- [x] S6 — VCS Operations Popup on `alt+\``, context-aware, enumerated from the registries *(P13-T7: `dialogRegistry.ts` + in-progress/diff/commit groups, recents per workspace)*
- [x] S7 — `Files Merged with Conflicts` dialog gate, tree view retained *(P13-T8, once per
      session, off switch via `gittree.merge.conflictsDialog`)*
- [x] §3.5 — `Apply non-conflicting changes` split into Left/All/Right + live conflict counter + per-side Show Details *(P13-T8; git pre-applies the non-overlapping changes, so Left/Right act on the conflict blocks — deviation D17)*
- [x] §3.10 — worktree create/list/remove/lock/prune with a management view *(P13-T6:
      `gittree.worktrees` view + New Worktree dialog; lock/prunable derived on git < 2.36, D16)*
- [x] `Manage Remotes` exists at all (no command today) *(P13-T4: `gittree.remotes.manage` —
      add / edit / remove / prune over a live table)*
- [x] `Reset → Keep` available in the reset dialog *(P13-T3: four-mode radio, with a live
      impact line and git's own refusal surfaced when `--keep` declines)*

## Outcome (P13-T9, 2026-08-23) — **PHASE 13 CLOSED, Tier 1 complete**

Every checklist item above is ticked. `FEATURES.md` rewritten so each item carries a *shape*
criterion; `docs/parity-audit.md` replaced and re-scored against it; `docs/deviations.md`
finalized at D1–D17; `docs/keyboard.md`, `readme.md` and `CHANGELOG.md` updated. The
gap-analysis inventory re-scored: **118 at parity · 33 partial · 79 absent**, from
75 / 36 / 122. Gates at close: 686 unit, 197 webview (+3 skipped), 220 integration (+2
pending), `test:perf` 8/8 with every §13 budget met, bundle 1.19 MB effective vs 2.50 MB.

## Planned deviations
- **Dialogs are editor-area webview panels, not OS-modal windows** (P11-T1). Focus-trapped and
  Esc-cancellable, but the rest of the window stays interactive.
- **Branches popup uses drill-in, not in-place collapse.** `QuickPick` cannot render a
  collapsible tree; folder rows drill into a scoped popup with `‹ Back`, and typing searches
  flat across every level. Chosen over a webview popup to keep native search and keyboard
  parity (master §6).
- **`alt+\`` may collide** with terminal or user bindings; it is gated on the IntelliJ keymap
  setting, and `gittree.operationsPopup` is always available via the palette.
- **No `Update Info` tab** — replaced by a result notification with "Show in Log" (P13-T2.4).
- **Tri-editor merge layout is kept over IntelliJ's exact pane chrome** — three real editors buy
  full LSP in the result pane, which a webview merge view would lose (master §6).
- **Clone does not enumerate provider repositories** (no account/remote integrations, per the
  project's standing constraint); URL entry only.
