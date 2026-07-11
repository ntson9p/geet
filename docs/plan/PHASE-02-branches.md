# Phase 2 — Branch Management (Branches Popup)

**Goal:** FEATURES.md §2 — the categorized, searchable, favoriting Branches popup with Smart Checkout and all per-branch actions, plus a persistent Branches TreeView for native context-menu parity.

**Depends on:** P1 (status widget entry point, SCM refresh loop).
**Exit criteria:** every §2 bullet works against the fixture repo, including Smart Checkout with a conflicting pop.

---

## Tasks

### P2-T1 · RefService: recency, favorites, tracking metadata
**Depends:** P0-T3 · **Complexity:** S
**Output files:** `src/branches/refService.ts` + unit tests.
**Steps:**
1. Merge `for-each-ref` model with per-branch metadata: ahead/behind vs upstream (batch `for-each-ref --format='%(upstream:track)'`), last-commit subject + date.
2. **Recent branches**: parse reflog `checkout: moving from X to Y`; score = frequency × recency decay (half-life 14 days); top `gittree.branches.recentCount` (default 5), excluding current.
3. **Favorites**: `globalState` set keyed by repo remote-URL hash (survives re-clones); toggle API + event.
**Accept:** unit tests on synthetic reflogs (renames, deleted branches filtered); favorites persist across reload.

### P2-T2 · Branches QuickPick popup
**Depends:** T1 · **Complexity:** M
**Output files:** `src/branches/branchesPopup.ts`.
**Steps:**
1. `window.createQuickPick`; sections via `QuickPickItemKind.Separator`: **Current** (checked-out branch w/ `$(check)`), **Favorites** (`$(star-full)`), **Recent**, **Local**, **Remote** (grouped `origin/…`). `matchOnDescription` so short-sha/subject also filter.
2. Item description: `↑1 ↓2 · a3f9c12 · fix: …`; detail only for current (upstream + state).
3. Item buttons: star toggle (`$(star-empty)`/`$(star-full)`), `$(ellipsis)` opens the **actions QuickPick** for that branch (T3 actions). `onDidTriggerItemButton` routes.
4. Enter = default action (`gittree.branches.defaultAction`: `checkout` | `showActions`). Remote branch checkout creates a tracking local (name pre-filled, validated via `git check-ref-format --branch`).
5. Global buttons (title bar): New Branch, Fetch, open Branches view. Busy indicator while refreshing.
**Accept:** popup opens < 150 ms from cached refs on 500-branch fixture; type-to-filter narrows across sections; star pins to Favorites immediately.

### P2-T3 · Branch operations service
**Depends:** T1 · **Complexity:** M
**Output files:** `src/branches/branchOps.ts`.
**Commands/flows (all via OperationQueue, all l10n'd, all with progress):**
- `checkout` (→ T4 interceptor), `checkoutRemote` (tracking local), `newBranchFrom` (input + validate + optional checkout), `renameBranch` (`branch -m`, warns if upstream exists → offer push new + delete old), `deleteBranch` (`-d`; on not-merged error modal explains and offers `-D`; option to also delete remote), `pushBranch` (set-upstream flow when missing), `checkoutAndRebaseOntoCurrent` (`git rebase <current> <sel>` semantics: checkout sel then rebase onto previous current; conflicts → P6 handoff or marker-guidance toast until P6 ships).
**Accept:** integration tests per op incl. failure paths (delete unmerged, rename with upstream); all destructive ops snapshot-flagged.

### P2-T4 · Smart Checkout interceptor
**Depends:** T3 · **Complexity:** M
**Output files:** `src/branches/smartCheckout.ts`.
**Steps:**
1. Catch `GitError.kind === 'would-overwrite-checkout'`; parse blocking file list from stderr.
2. Modal (IntelliJ wording parity): "Your local changes would be overwritten by checkout. (N files)" → **Smart Checkout** / **Force Checkout** (discard, destructive-flagged) / **Cancel**; "always smart-checkout" setting `gittree.smartCheckout.behavior: ask|auto|never`.
3. Smart flow: `git stash push -u -m "gittree-smart:<target>:<ts>"` → checkout → `git stash pop`. Pop conflict: **keep the stash entry**, notify "Conflicts while restoring changes — resolve then drop stash", open P6 conflicts session (files are in unmerged state); stash auto-dropped only on clean pop.
4. Force flow: snapshot (P9) → `checkout -f`.
**Accept:** integration: dirty-conflicting fixture → smart path ends with changes restored on target branch; conflicting-pop path leaves stash present and conflicts view populated; force path recoverable via snapshot (post-P9).

### P2-T5 · Compare with Current / Diff with Working Tree
**Depends:** T1 · **Complexity:** M
**Output files:** `src/branches/compare.ts`.
**Steps:**
1. **Compare with Current** (`sel` vs `HEAD`): commits panel = QuickPick-less dedicated TreeView `gittree.compare` (two sections: "Commits on <sel>" / "Commits on <current>" from `git log --left-right --format… A...B`; click → commit details via P4 once available, interim: show `git show` in diff editor) + title action "Show file diff" → multi-diff editor via `vscode.changes` with `gittree-rev:` pairs from `git diff A...B --name-status -z` (rename-aware).
2. **Show Diff with Working Tree**: `git diff <sel> --name-status -z` → `vscode.changes` (right side = real file URIs).
3. Register both in popup actions + Branches view context menus. Mark upgrade hook: P4-T5 replaces the commits TreeView with the log webview filtered to `A...B` (keep command ids stable).
**Accept:** fixture branches show correct left/right commit split and openable per-file diffs incl. renames.

### P2-T6 · Branches TreeView (persistent, native context menus)
**Depends:** T1, T3 · **Complexity:** S
**Output files:** `src/branches/branchesView.ts`, view `gittree.branches` in the SCM container.
**Steps:**
1. Nodes: Favorites / Local / Remote(per remote) / Tags(collapsed); inline actions: checkout `$(arrow-right)`, star; full `view/item/context` menu mapping every T3 op + T5 compares (contextValues `branch:local`, `branch:remote`, `branch:current`).
2. Description shows track info; current branch bolded via `TreeItemLabel.highlights` + `$(check)` icon.
3. `TreeDragAndDropController`: drag branch onto branch → QuickPick "Merge / Rebase / Compare" (IntelliJ drag affordance parity).
**Accept:** right-click parity vs FEATURES §2 action list; drag-merge flow triggers correct op with confirm.

---

## Contributions added this phase
Commands `gittree.branches.{open,new,checkout,checkoutRemote,rename,delete,push,rebaseOntoCurrent,compareWithCurrent,diffWithWorkingTree,toggleFavorite}`; views `gittree.branches`, `gittree.compare`; `view/item/context` + `view/title` menus.

## Parity checklist (FEATURES.md §2)
- [x] Instant search filter over all branch sections (QuickPick native type-to-filter, matchOnDescription for sha/subject)
- [x] Categories: Current / Recent (frequency×recency-decay reflog scoring) / Local / Remote (per remote) — plus Favorites
- [x] Favorites star pinning (item buttons; persisted per remote-URL hash so favorites survive re-clones)
- [x] Smart Checkout (stash -u → checkout → pop; conflicting pop keeps the stash and reports; force path snapshotted by P9 — verified recoverable byte-exact in the integration test)
- [x] Context actions: Checkout · Checkout and Rebase onto Current · New Branch from Selected · Compare with Current (commits + file diffs) · Show Diff with Working Tree · Rename (w/ remote update offer) · Delete (w/ force fallback + remote delete offer) · Push — in both the popup actions QuickPick and the Branches view context menus

## Deviations
- **P2-T5:** the commits list uses `--left-right A...B` per plan; the *file* diff compares branch tips directly (`git diff A B`) instead of three-dot — IntelliJ's "Compare with Current" file semantics. Command ids stay as specified for the P4-T5 upgrade.
- **P2-T2/T3/T6:** input boxes / QuickPick choices have env-var test seams (`GITTREE_TEST_BRANCH_NAME`, `GITTREE_TEST_BRANCH_MODE`, `GITTREE_TEST_SMART_CHOICE`, `GITTREE_TEST_DROP_CHOICE`) because native dialogs cannot be driven by the harness; production behavior unchanged.
