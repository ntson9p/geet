# Phase 1 — Core SCM, Gutter Quick-Diff, Status Widget

**Goal:** FEATURES.md §1 (gutter annotations except blame, VCS status widget) plus the baseline SCM provider and everyday operations (open diff, rollback, commit MVP, fetch/pull/push) that make the extension usable before P3 lands the full commit lifecycle.

**Depends on:** P0 complete.
**Exit criteria:** with `git.enabled: false`, a user can see change bars, peek+rollback hunks, view status groups, commit, pull/push, and see branch + ahead/behind in the status bar — entirely through Geet.

---

## Tasks

### P1-T1 · SourceControl registration & resource groups
**Depends:** P0-T4/T5/T6 · **Complexity:** M
**Output files:** `src/scm/sourceControl.ts`, `src/scm/resourceDecorations.ts`, `registerPhase01`.
**Steps:**
1. `scm.createSourceControl('gittree', 'Geet', rootUri)` per repo; `count` = changed files; `inputBox.placeholder` with branch name.
2. Groups (baseline, P3 refines): `merge` (unmerged, hideWhenEmpty), `staged` (index), `changes` (worktree), `untracked`. Map porcelain-v2 entries → `SourceControlResourceState` with light/dark icons, strike-through for deletions, faded for ignored, tooltips, `contextValue` (`file:modified`, `file:untracked`, …) for menu `when` clauses.
3. Click command per resource = open diff (T4). Group context menus: stage all / unstage all / rollback group.
4. Respect ModeManager (companion mode: still register — SCM is our primary surface — but see T2/T6 skips).
**Accept:** integration: fixture with staged+unstaged+untracked+conflicted shows 4 groups with correct counts/decorations; updates < 500 ms after external change.

### P1-T2 · QuickDiffProvider (gutter bars + peek)
**Depends:** T1 · **Complexity:** S
**Output files:** `src/scm/quickDiff.ts`, `src/core/vdocs/revContentProvider.ts` (register `gittree-rev:`).
**Steps:**
1. `provideOriginalResource(uri)` → `gittree-rev:` URI serving index content (fallback HEAD when not in index) via `git show :0:<path>` / `HEAD:<path>`; respects rename detection (status model).
2. Skip registration entirely in companion mode (built-in git already provides bars).
3. Setting `gittree.quickDiff.base`: `index` (default) | `head`.
**Accept:** bars appear for add/mod/del lines; clicking a bar opens the native peek showing correct original text; no double bars in companion mode.

### P1-T3 · Peek-widget hunk actions (rollback / stage / open in commit view)
**Depends:** T2 · **Complexity:** M
**Output files:** `src/scm/hunkActions.ts`, `src/core/patch/patchBuilder.ts` (shared — also used by P3-T4, P7-T5), menus in `package.json`.
**Steps:**
1. Contribute to `menus.scm/change/title`: `gittree.hunk.rollback` (`$(discard)`), `gittree.hunk.stage` (`$(plus)`), `gittree.hunk.openCommitView` (`$(git-commit)`). Handlers receive `(uri, changes: LineChange[], index)`.
2. **Rollback** = compute the hunk's original text from quick-diff base and apply as a reverse `WorkspaceEdit` (keeps editor undo stack — IntelliJ parity for instant "oops"). Marked destructive → P9 snapshot hook (soft dep: no-op until P9 lands).
3. **Stage** = `PatchBuilder.fromLineChange(...)` → unified diff with correct `@@` headers (`--unidiff-zero` zero-context mode) → `git apply --cached --unidiff-zero -` via stdin.
4. `PatchBuilder`: pure lib building minimal patches from `(originalText, modifiedText, ranges)`; exhaustive unit tests (EOL-at-EOF, CRLF, adjacent hunks, insert-only, delete-only).
**Accept:** peek toolbar shows 3 icons; rollback of a middle hunk leaves neighbors intact and is Ctrl+Z-able; staged hunk moves to Staged group; patch round-trip tests green.

### P1-T4 · File-level operations & diff commands
**Depends:** T1 · **Complexity:** M
**Output files:** `src/scm/fileOps.ts`.
**Commands:** `gittree.openDiff` (worktree↔index or HEAD per group), `gittree.openDiffHead`, `gittree.add`, `gittree.unstage`, `gittree.rollbackFile` (multi-select; modal listing files; `git restore --source=HEAD --worktree [--staged]`; untracked → delete with confirm; destructive-flagged), `gittree.cleanUntracked` (preview list modal), `gittree.refresh`, `gittree.openFile`.
**Steps:** wire into `scm/resourceState/context` + `scm/resourceGroup/context` menus with sensible groupings; diff titles mimic built-in (`file.ts (Working Tree)`).
**Accept:** integration coverage per command incl. rename entries and multi-select rollback.

### P1-T5 · Status-bar widget (branch + incoming/outgoing) & sync ops
**Depends:** T1, P0-T6 · **Complexity:** M
**Output files:** `src/ui/statusBar.ts`, `src/scm/syncOps.ts`.
**Steps:**
1. `SourceControl.statusBarCommands` = `[checkoutItem, syncItem]`. Checkout item: `$(git-branch) <branch>` (`$(git-commit) <shortsha>` when detached; `$(warning)` suffix during in-progress op, e.g. `main | REBASING 3/7`). Command → `gittree.branches.open` (P2; until then, minimal checkout QuickPick stub behind the same command id).
2. Sync item: `$(sync)` idle, `$(arrow-down) N $(arrow-up) M` when diverged (from `rev-list --left-right --count @{u}...HEAD`), spinner while fetching. Command = pull-then-push sync with progress.
3. `gittree.fetch` / `pull` / `push` / `pushForceWithLease` commands (+ `scm/title` menu entries). Pull honors `pull.rebase` config. No-upstream push offers "Publish branch".
4. Auto-fetch timer (`gittree.autofetch.*`), paused while a mutation runs or the window loses focus > 30 min.
**Accept:** widget reflects fixture divergence (2 down/1 up); sync round-trips against a local bare remote fixture; detached + rebase states render.

### P1-T6 · Explorer file decorations
**Depends:** T1 · **Complexity:** S
**Output files:** `src/scm/fileDecorations.ts`.
**Steps:** `window.registerFileDecorationProvider`: badge/color per status (M yellow, A green, D strike, U green-italic, conflicted red `!`), propagate to parents. Skip in companion mode (built-in provides). Colors via `ThemeColor('gitDecoration.*')` for theme consistency.
**Accept:** explorer shows IntelliJ-style colored filenames on the fixture; toggling mode removes/restores without reload.

### P1-T7 · Commit MVP
**Depends:** T1, T4 · **Complexity:** S
**Output files:** `src/scm/commitMvp.ts` (superseded by P3-T8; keep the command id `gittree.commit` stable).
**Steps:** `acceptInputCommand` = commit staged (or all-tracked when nothing staged, after modal confirm); empty-message guard; `--amend` variant command stub; post-commit input clears, model refreshes.
**Accept:** commit from SCM input works end-to-end on fixture; amend updates HEAD message.

---

## Contributions added this phase
SCM provider "Geet"; commands `gittree.{openDiff,openDiffHead,add,unstage,rollbackFile,cleanUntracked,refresh,openFile,fetch,pull,push,pushForceWithLease,sync,commit}`; hunk commands + `scm/change/title` menu; `scm/title`, `scm/resourceState/context`, `scm/resourceGroup/context` menus; file decoration provider; status-bar items via `statusBarCommands`.

## Parity checklist (FEATURES.md §1)
- [x] Green/blue/grey gutter bars for added/modified/deleted lines (native quick diff over `gittree-rev:` index/HEAD base; takeover-mode only per §3)
- [x] Click bar → floating inline diff (peek) (native behavior once quickDiffProvider is registered)
- [x] Rollback hunk from the popup (undoable — full-doc WorkspaceEdit keeps the editor undo stack; P9-snapshotted)
- [x] Stage / send-to-commit hunk from the popup (`PatchBuilder` zero-context patch → `git apply --cached --unidiff-zero`; verified against real git in 8 round-trip tests)
- [x] Status-bar widget: branch name + incoming/outgoing arrows with counts (+ detached sha, REBASING/MERGING step suffix)
- [x] Widget click opens Branches popup (stub QuickPick until P2; same command id `gittree.branches.open`)

## Deviations
- **P1-T4/T7:** modal confirmations go through `src/ui/confirm.ts`, which auto-accepts when `GITTREE_TEST_AUTOCONFIRM=1` — native dialogs cannot be driven by the integration harness. Production behavior is unchanged.
- **P1-T1:** resource-state icons use codicon `ThemeIcon`s with `gitDecoration.*` theme colors instead of shipped SVG pairs — theme-correct in light/dark/HC without asset maintenance.
