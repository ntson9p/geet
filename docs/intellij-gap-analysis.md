# GitTree vs. IntelliJ IDEA Git — gap analysis

Investigation date: 2026-08-20. Compared against JetBrains' own IntelliJ IDEA
documentation (sources at the bottom), twelve reference screenshots of a live
IntelliJ IDEA install (`temp/screenshots/`), and the shipped build
(`gittree-0.0.1.vsix`, 136 commands, 8 views, 38 settings) read alongside its
source.

**Status:** the owner accepted **Tier 1** on 2026-08-22. The remediation in §5 is
now a committed plan — `docs/plan/PHASE-11-commit-tool-window.md`,
`PHASE-12-git-tool-window.md`, `PHASE-13-dialogs-and-popups.md` — and the
divergences we are keeping on purpose moved to `docs/deviations.md`.

Legend: **✅** IntelliJ-equivalent · **🟡** present but different form / partial ·
**❌** absent

---

## 0. The one-paragraph answer

GitTree is at 100% parity with [FEATURES.md](../FEATURES.md) — and that is the
problem. `FEATURES.md` is an ~8-section summary of IntelliJ's Git integration,
not its feature surface. JetBrains' own docs describe roughly **6–8× more**
surface than that document captures. On top of that, almost every feature that
*was* specified got built in **VS Code idiom** (QuickPick, tree view, SCM input
box) rather than **IntelliJ idiom** (tool window with panes + toolbars, modal
dialog with *Modify options*, tree popup with per-row context menus). So the app
diverges on two independent axes at once: *what* it does, and *how it looks and
feels doing it*. That combination is exactly what produces "an upgrade from
VS Code's Git rather than an IntelliJ replica."

---

## 1. Root cause

| | |
| --- | --- |
| **Spec gap** | `FEATURES.md` was the binding contract, and `docs/parity-audit.md` signs off line-by-line against it. Whole IntelliJ subsystems never appear in the spec, so they were never built, and their absence never showed up as a gap. |
| **Idiom gap** | The plan specified *capabilities*, not *containers*. "Branches popup with search and categories" was satisfied by a `QuickPick`; "Commit tool window" was satisfied by the SCM sidebar plus the native input box. Each is defensible in isolation; together they make the product feel like VS Code. |
| **Verification gap** | Acceptance was tests-green, not side-by-side-with-IntelliJ. Nothing in the pipeline could detect "this is shaped wrong." |

Concretely, from JetBrains' Log tab docs alone: IntelliJ's Log tab has **4 panes**,
an 11-item Branches toolbar, an 18-item Branches context menu, an 11-item Commits
toolbar, 11 presentation/highlight options, a **28-item** commit context menu, a
5-item Changed Files toolbar and a 12-item Changed Files context menu.
GitTree's log is a single panel webview with a filter bar, a graph, and a details
panel, and about 12 context-menu actions.

---

## 2. The structural gap — why it *feels* different

This section matters more than any individual missing feature. These are the
container-level decisions that set the product's character.

| # | IntelliJ | GitTree today | Effect |
| --- | --- | --- | --- |
| S1 | **Commit tool window** (`Alt+0`): one panel with file tree, large message editor, toolbar, gear options, and an inline diff preview | VS Code SCM sidebar plus the **native SCM input box**; options scattered across `scm/title` menus and the command palette | The single most-used surface in IntelliJ has no counterpart. Commit feels like stock VS Code. |
| S2 | **Git tool window** (`Alt+9`): 4 synchronized panes — Branches, Commits, Changed Files, Commit Details — plus Console / History / Repository / Update Info tabs | One webview in the bottom **panel**: filter bar + graph rows + details panel | No branches pane, no per-pane toolbars, no tabs. Loses the "control center" feel. |
| S3 | **Branches popup**: a *tree* popup that is also an **action hub** — it opens with Update Project / Commit / Push / New Branch / Checkout Tag or Revision before any branch appears, and the search field matches "branches **and actions**". Real folder nodes (`feature` collapses `f1`, `f1-1`, `f2`), per-row `›` submenus, gear settings | A flat `QuickPick` list with separator headers; branches only | Fine for 20 branches; falls apart at 200. No grouping, no tags, no nested actions, and none of the top-level verbs. |
| S4 | **Dialogs with "Modify options"** — Push, Pull, Merge, Rebase, Update Project, Reset, Rollback, Stash, Shelve, Cherry-pick target, Apply Patch, Clone, Manage Remotes | Chains of `showQuickPick` / `showInputBox` (25 QuickPick call sites) | IntelliJ exposes real git flags through checkable option lists; GitTree hides them entirely. This is the biggest *power-user* gap. |
| S5 | **Differences Viewer** with its own toolbar: side-by-side/unified toggle, ignore-whitespace modes, highlight granularity (words/lines/chars/split), align changes, collapse unchanged fragments, compare-with-clipboard, switch-to-three-side, annotate-in-diff | VS Code's native diff editor (`vscode.diff`) | Every diff in the product loses IntelliJ's diff controls. |
| S6 | **VCS Operations Popup** (`Alt+` + backtick) — one hub listing every applicable VCS action in context | — | Absent entirely. IntelliJ users reach for this constantly. |
| S7 | **Files Merged with Conflicts** dialog: per-file *Accept Yours / Accept Theirs / Merge…*, plus resolve-all-simple | `gittree.conflicts` **tree view** in the SCM container with equivalent actions | Behaviour is close; the shape is a sidebar list, not a modal gate. |
| S8 | VCS widget sits in the **top-left main toolbar** (New UI) as `<project> ▾  ⑂ <branch> ▾`, with incoming (blue) / outgoing (green) arrows | Bottom **status bar** item with ahead/behind counts | Right behaviour, wrong end of the window. VS Code has no top-toolbar surface, so this one may be an accepted deviation. |
| S9 | **File status colors**: 15 named statuses with per-theme colors, customizable on a settings page; directories with modified descendants highlighted | VS Code `FileDecorationProvider` badges | VS Code's decoration API cannot express IntelliJ's palette. |
| S10 | **Console tab** in the tool window showing every executed git command and its output | One `GitTree` output channel | Discoverability only; low impact. |
| S11 | **Checkbox inclusion model everywhere**: tri-state checkboxes on the Changes group, on every **folder** node, on every file — *and on every individual change inside the diff* (`2 differences, 0 included`). What you commit is what is ticked. | Partly present, and the parts that are missing are the load-bearing ones. `changelistsView.ts` does put `TreeItemCheckboxState` on changelist and file rows — but (a) there are **no folder nodes at all** (`getChildren` returns files straight off the list; the directory is a dim suffix), (b) `TreeItemCheckboxState` has **no partial state**, so a half-ticked list renders unticked (`changelistsView.ts:113`), (c) **unversioned files get no checkbox** (`:159`), so an untracked file cannot be included by ticking it, and (d) there is no per-change checkbox anywhere | The gesture exists but not at the two granularities that matter: folder and individual change. Fix needs a webview — `TreeView` cannot do tri-state and `vscode.scm` resource groups have no checkbox affordance at all. **The math is already there**: `core/patch/patchBuilder.buildPatch` + `complementChanges` can build a patch from an arbitrary subset of `LineChange[]`, so `N differences, M included` is a UI gap, not an engine gap. → P11-T3 |
| S12 | Every tree node carries a **file-count badge** (`Changes 2 files`, `api 4 files`), in the commit window, the push dialog and the log's Changed Files pane | Present on changelist and Unversioned nodes (`changelistsView.ts:107`); absent on folder nodes (there are none) and in the log's Changed Files list | Smaller than first assessed — it arrives for free once folder nodes exist. → P11-T8 |
| S13 | **Two tool windows with tabs**: Commit (left) holds `Commit \| Shelf`; Git (bottom) holds `Log \| Console`. Related surfaces are tabs in one window | **Seven separate tree views stacked in the SCM container** (changelists, branches, compare, localHistory, conflicts, stashes, shelf) plus one log webview in the panel | Same information, radically more scrolling and no sense of a "place". The dock positions were already right — left for commit, bottom for log — so this is purely about grouping. → P11-T2, P11-T6, P12-T1 |
| S14 | **Dialogs embed a live diff** with per-change include checkboxes — the Shelve Changes dialog carries a collapsible `∨ Diff` section with a full diff toolbar and `2 differences` | Shelve is a QuickPick prompt; the shelf stores whole-file patches (`shelfStore` writes `git diff --output`), so partial shelve is not expressible | Dialogs in IntelliJ are working surfaces, not just parameter forms. → P11-T7 |

**The merge editor is the exception.** `src/merge/triEditor.ts` composes three
real VS Code editors (Yours / Result / Theirs) with the result pane fully live —
that *is* the IntelliJ shape, and it is arguably better than what any other
VS Code extension does. It proves the approach is possible here; it just was not
applied to the commit window or the log.

---

## 2A. Reference layouts (transcribed from the screenshots)

Transcribed from `temp/screenshots/`. These are the target shapes — use them as
the "shape" acceptance criterion for any rework.

### Commit tool window — docked **left**, full height

```
+- Commit ---------------------------------+
| (refresh) (rollback) (diff) (shelve)     |  8-icon toolbar strip
| (preview) (?) (expand) (collapse)        |
+------------------------------------------+
| [ ] v Changes             2 files        |  tri-state box + count badge
|   [ ] v (dir) 2 files                    |
|     [ ] v (dir) 1         1 file         |
|       [ ] (file) 1.1.txt                 |
|     [ ] (file) 1.txt                     |  selected row = full-width bar
| [ ] v Unversioned Files   1 file         |
|   [ ] v (dir) 1 file                     |
|     [ ] (file) 2.txt                     |
|                                          |
+------------------------------------------+
| [ ] Amend  last commit v      (clock)    |  history clock beside Amend
| +--------------------------------------+ |
| | <multi-line message editor>          | |  ~6 lines tall, not 1
| +--------------------------------------+ |
| [ Commit ]  [ Commit and Push... ]  (gear)|  gear = commit options
+------------------------------------------+
```

The dock position is **left, vertical** — which is where GitTree already puts its
SCM view. The gap is content, not placement.

### Diff opened *from* the commit window

Tab title is **`Commit: 1.txt`** (a plain diff tab is `Repository Diff: 1.txt`).

```
up dn edit < > doc | [Side-by-side viewer v] [Do not ignore v]
                     [Highlight words v] x sync gear ?     2 differences, 0 included
(lock) 0e899a5b 1.txt                  LF | [ ] Current version              CRLF
  abc                              >> 1   | 1 [ ] 123
  def                              >> 2   | 2     abc
                                      3   | 3 [ ] dexf
```

Every change carries its own **include checkbox**, and the header counts
`N differences, M included`.

### Git tool window — docked **bottom**, tabs `Log | Console`

```
+- Git -- [Log] [Console] ---------------------------------------------------+
|rail| Branch or tag | Text or hash .* Cc | Branch v User v Date v Paths v  | run refresh pick eye find
| +  | HEAD (Current)| o 1     master  example-user1  3 minutes ago         | +- Changed Files - exp rev hist eye -+
| -  | v Local       | o 0             example-user1  5 minutes ago         | | v (dir) demo-git  1 file          |
| <> |    (tag)master|                                                       | |    (file) 1.txt                   |
| Q  |               |                                                       | +- Commit Details ------------------+
| *  |               |                                                       | | 1                                 |
| @  |               |                                                       | | 0e899a5b example-user1            |
| >  |               |                                                       | | <...> on 8/20/2026 at 16:24       |
|    |               |                                                       | | (tag)HEAD  (tag)master            |
+----+---------------+-------------------------------------------------------+-----------------------------------+
```

Four panes plus a vertical icon rail on the Branches pane, all in one
bottom-docked window — **simultaneously visible with the left-docked Commit
window and the editor**.

### Branches popup — anchored to the top-left branch widget

```
+----------------------------------------------+
| (find) Search for branches and actions   ^ @ |  <- searches ACTIONS too
+----------------------------------------------+
| Update Project...                     Ctrl+T |
| Commit...                             Ctrl+K |
| Push...                         Ctrl+Shift+K |
+----------------------------------------------+
| + New Branch...                   Ctrl+Alt+N |
|   Checkout Tag or Revision...                |
+----------------------------------------------+
| v Recent                                     |
|     (tag) master                           > |  <- per-row submenu chevron
| v Local                                      |
|     (tag) master                           > |
|   v (dir) feature                            |  <- real folder node
|       (branch) f1                          > |
|       (branch) f1-1                        > |
|       (branch) f2                          > |
+----------------------------------------------+
```

### Push dialog

```
+- Push Commits to sample-app-client ---------------------------------------x-+
| #12345A-dev-feature -> origin : #12345A-dev-feature | diff eye edit group   |
|   #12345A:[consolidate] implement `GET /api/v1/...` | v (dir) sample-app-client 17 files
|   #12345A:[consolidate] implement `GET /api/app/...`|   v (dir) feature-gr 17 files  D:\...
|                                                     |     v (dir) ...pi 4 files
|                                                     |       ArticleDataController.java  (green = added)
|                                                     |       CommentController.java      (blue  = modified)
+-----------------------------------------------------+-----------------------+
| ?  [ ] Push tags: [All v]   [x] Run Git hooks     [ Push v ]  [ Cancel ]    |
+-----------------------------------------------------------------------------+
```

### Update Project dialog

```
+- Update Project ---------------------------------------x-+
| (o) Merge incoming changes into the current branch        |
| ( ) Rebase the current branch on top of incoming changes  |
| ? [ ] Do not show again                                   |
|          [Reset to the Remote Branch]  [ OK ]  [ Cancel ] |
+-----------------------------------------------------------+
```

### Rebasing Commits dialog — 3 panes

```
+- Rebasing Commits --------------------------------------------------------x-+
| up dn undo PAUSE | [Reword] [Squash v] [Drop] [Reset] | diff eye             |
| o temp1                                        | v (dir) web-shop-app 1 file |
| o +------------------------------------------+ |   v (dir) docs 1 file       |
|   | temp2x                                   | |      M guide_upgrade.markdown
|   | Press Ctrl+Enter to apply changes        | +-----------------------------+
|   +------------------------------------------+ | temp2                       |
| o temp3                                        | c6770bdb example-user1      |
|                                                | <...> on 8/20/2026 at 20:01 |
+------------------------------------------------+-----------------------------+
| ?                                        [ Start Rebasing ]   [ Cancel ]     |
+------------------------------------------------------------------------------+
```

`PAUSE` is **Stop to Edit**. `Reset` is **global** (clears every row's action),
not per-row. The right-hand panes update with the selected commit.

### Merge Revisions dialog

```
+- Merge Revisions for D:\...\demo-git.txt -------------------------------x-+
| up dn diff | Apply non-conflicting changes: >>Left  <<All  <<Right | (wand) |
|            | [Do not ignore v] [Highlight words v] x sync gear             |
|                                                    No changes. 1 conflict. |
| (lock) Changes from master  Show Details | Result 1.txt | (lock) Changes from master2  Show Details
| abcx                            x >> 1   | 1  abc      | 1 << x   ab
| def                                  2   | 2  def      | 2        def
+------------------------------------------------------------------------------+
| [Accept Left] [Accept Right]                       [ Apply ]   [ Cancel ]    |
+------------------------------------------------------------------------------+
```

Three *separate* apply-non-conflicting actions (Left / All / Right), a live
conflict counter in the toolbar, and per-side **Show Details**.

### Gutter change-marker popup

```
   +--------------------------------------------------------+
   | up dn rollback diff copy menu | Commit this change  e > |
   +--------------------------------------------------------+
```

An actual commit-message field inline in the gutter popup, with edit and commit
buttons.

### Commit options gear popup (`⚙`, bottom-right of the commit window)

```
+- Git ---------------------------------------------------+
| Author:  [                                          ]   |
| [ ] Sign-off commit                                     |
+- Commit Checks -----------------------------------------+
| [ ] Update copyright                                    |
| [ ] Reformat code                                       |
| [ ] Rearrange code                                      |
| [ ] Optimize imports                                    |
| [ ] Cleanup            Choose profile                   |
| [ ] Check malicious dependencies                        |
+- Advanced Commit Checks --------------------------------+
| [x] Analyze code       Choose profile                   |
| [x] Check TODO         Configure                        |
| [ ] Run Configuration  Choose configuration             |
|                                                         |
| [x] Run advanced checks after a commit is done          |
|     Failed checks will not prevent a commit             |
+- After Commit ------------------------------------------+
| Upload files to: [ <None>            v ]  [ ... ]       |
| [x] Always use selected server or group of servers      |
+---------------------------------------------------------+
```

Two of these are plain git features GitTree simply lacks: **`Author:`** (`--author=`)
and **`Sign-off commit`** (`-s`). `Run advanced checks after a commit is done` is a
real behaviour switch — checks move from gating to reporting. The rest
(copyright, malicious dependencies, Run Configuration, `Upload files to`) are
IntelliJ *platform* features, not Git, and are registered as deviations.

Also visible in this screenshot: the commit window's tabs are **`Commit | Shelf`**,
and the amend row reads `[ ] Amend  last commit v  (clock)`.

### Shelve Changes dialog

```
+- Shelve Changes -------------------------------------------------------x-+
| revert undo refresh eye        expand collapse | Changelist: [Changes v] |
| +---------------------------------------------------------------------+  |
| | [x] v (repo) demo-git  1 file  demo-git                             |  |
| |   [x]   (file) 1.txt                                                |  |
| +---------------------------------------------------------------------+  |
| 1 modified                                                               |
| Commit Message                                              (clock)      |
| [ e1b                                                              ]     |
| v Diff                                                                   |
|   up dn edit < > | [Side-by-side viewer v] [Do not ignore v]              |
|                    [Highlight words v] x sync lock gear ?  2 differences |
|   (lock) f3a5bc77 1.txt            | [x] Current version                 |
|     abcx                       1  1|   abcx                              |
|     ab                         2  2|   ab                                |
|     def                        3  3| [x] 123                             |
|                                4  4|   def                               |
|                                   5| [x] xxx                             |
|                                                                          |
|  ?                                    [ Shelve Changes ]   [ Cancel ]    |
+--------------------------------------------------------------------------+
```

A dialog that is also a diff viewer and also a commit-message editor. The
per-change checkboxes are the same inclusion model as the commit window, which is
why **partial shelve** works in IntelliJ and cannot work in GitTree today.

### Branch row `>` submenu — expanded (on `feature/f1-1`, current branch `master`)

```
+- Branches popup -----------------+
| (find) Search for branches and.. |     +--------------------------------------+
| Update Project...        Ctrl+T  |     | Checkout                             |  <- highlighted
| Commit...                Ctrl+K  |     | New Branch from 'feature/f1-1'...    |
| Push...            Ctrl+Shift+K  |     | Checkout and Rebase onto 'master'    |
| + New Branch...      Ctrl+Alt+N  |     +--------------------------------------+
|   Checkout Tag or Revision...    |     | Compare with 'master'                |
| v Recent                         |     | Show Diff with Working Tree          |
|     (tag) master               > |     +--------------------------------------+
|     (branch) master2           > |     | Rebase 'master' onto 'feature/f1-1'  |
| v Local                          |     | Merge 'feature/f1-1' into 'master'   |
|     (tag) master               > |     +--------------------------------------+
|   v (dir) feature                |     | New Worktree from 'feature/f1-1'...  |
|       (branch) f1              > |     +--------------------------------------+
|       (branch) f1-1            >-+---->| Push...                              |
|       (branch) f2              > |     +--------------------------------------+
|     (branch) master2           > |     | Rename...                        F2  |
+----------------------------------+     | Delete                               |
                                         +--------------------------------------+
```

Eleven actions per branch, with the *other* branch's name interpolated into the
label so the direction of every operation is unambiguous
(`Rebase 'master' onto 'feature/f1-1'` vs `Merge 'feature/f1-1' into 'master'`).
GitTree's rows have none of this. Two items are whole missing capabilities:
`New Worktree from 'X'…` (no worktree commands exist) and
`Checkout and Rebase onto '<cur>'` (a compound action). And
`Merge 'X' into '<cur>'` is the one that today is reachable **only** by dragging a
row in the branches tree.

---

## 3. Feature gaps by area

### 3.1 Editor integration, gutter and blame

| IntelliJ | GitTree | |
| --- | --- | --- |
| Gutter change markers (green/blue/grey) | QuickDiffProvider, `gittree.quickDiff.base` | ✅ |
| Click marker opens a floating toolbar popup | Peek diff plus hunk commands | 🟡 no floating toolbar |
| Popup: **prev/next change** arrows | — | ❌ |
| Popup: **Rollback** hunk | `gittree.revert.hunkAt` / `hunk.rollback` | ✅ |
| Popup: **Stage** chunk | `gittree.hunk.stage` | ✅ |
| Popup: **"Commit this change"** — a real inline message field with edit and commit buttons, right in the popup | — | ❌ |
| Popup: **Amend** button | — | ❌ |
| Popup: **changelist selector** dropdown | — | ❌ |
| Hollow marker means staged chunk | — | ❌ |
| Annotate with Git Blame (toggle) | `gittree.blame.toggle` | ✅ |
| Blame age heat-map fading | `gittree.blame.heatmap` | ✅ |
| Click annotation opens the commit in the log | `gittree.blame.revealCursorCommit` | ✅ |
| Blame **View** menu: revision info / date / author formats, commit number, colors | `gittree.blame.format` string only | 🟡 |
| Blame **Options**: Ignore Whitespaces (`-w`) | — | ❌ |
| Blame Options: Detect Movements Within File (`-M`) | — | ❌ |
| Blame Options: Detect Movements Across Files (`-C`) | — | ❌ |
| Blame Options: Show Commit Timestamp | — | ❌ |
| **Annotate Revision** / **Annotate Previous Revision** | — | ❌ |
| **Hide Revision** / **Restore Hidden Revisions** | — | ❌ |
| **Code author** inlay hints (code vision, on-top / on-right) | — | ❌ |
| Highlight directories containing modified files | — | ❌ |

### 3.2 Branch management

| IntelliJ | GitTree | |
| --- | --- | --- |
| Search / speed-search in popup | QuickPick filter | ✅ |
| Categories: Current / Recent / Local / Remote | Separator sections | ✅ |
| Favorites (star icon, **Space** to toggle) | `branches.toggleFavorite` (button) | 🟡 no Space key |
| **Group by Directory** (prefix folding) | — | ❌ |
| **Tags** node in popup | — | ❌ |
| **Show My Branches** | — | ❌ |
| Popup **settings gear** (group-by / show-recent / show-tags) | — | ❌ |
| **Branches pane** inside the Git tool window (11 toolbar actions) | Separate `gittree.branches` sidebar tree | 🟡 |
| Checkout | `branches.checkout` | ✅ |
| **Smart Checkout** (stash, checkout, unstash) | `smartCheckout` | ✅ |
| **Force Checkout** | offered in the smart-checkout prompt | ✅ |
| Checkout and Rebase onto Current | `branches.rebaseOntoCurrent` | ✅ |
| New Branch from Selected | `branches.newFrom` | ✅ |
| Compare with Current | `branches.compareWithCurrent` plus compare tree | ✅ |
| Show Diff with Working Tree | `branches.diffWithWorkingTree` | ✅ |
| Rename / Delete / Push | `branches.{rename,delete,push}` | ✅ |
| **Merge \<branch\> into \<current\>** | `mergeIntoCurrent` — reachable **only by drag-and-drop** in the branches tree; no menu item, no dialog, no options | 🟡 effectively hidden |
| **Rebase \<current\> onto \<selected\>** (this direction) | only the inverse direction | ❌ |
| **Update** / **Checkout and Update** selected branch | — | ❌ |
| **Pull into \<branch\> Using Rebase / Using Merge** | — | ❌ |
| **New Worktree from \<branch\>** | — | ❌ |
| Multi-select batch branch operations | — | ❌ |
| Delete-branch undo notification | — | ❌ |
| Protected-branch awareness | — | ❌ |

### 3.3 Commit lifecycle

| IntelliJ | GitTree | |
| --- | --- | --- |
| Changelists paradigm | `ChangelistService` | ✅ |
| Staging-area paradigm | staging view | ✅ |
| Switch paradigms | `commit.switchParadigm` | ✅ |
| Hunk / line-level staging | CodeLens plus `stage.selectedRanges` | ✅ |
| Unversioned Files node | untracked group | ✅ |
| **Tri-state checkboxes** on the Changes group, folders and files | — (VS Code SCM has no checkbox API) | ❌ **structural** |
| **Per-change checkboxes inside the diff**, with a live `N differences, M included` counter | range-selection commands | ❌ no checkbox affordance |
| Diff opened from the commit window is a distinct **`Commit: <file>`** tab (with include checkboxes), separate from a plain `Repository Diff: <file>` tab | one diff tab type | ❌ |
| Commit window toolbar: refresh, rollback, shelve silently, show diff preview, expand/collapse (8 icons in one strip) | actions spread across `scm/title` menus and the palette | 🟡 |
| **Move to Another Changelist…** | `changelist.moveTo` | ✅ |
| **Move Lines to Another Changelist…** | — | ❌ |
| **Split Chunks and Include Selected Lines into Commit** | partial via range staging | 🟡 |
| Commit message history dropdown | `commit.showMessageHistory` (`Ctrl+Up`) | ✅ |
| Commit template (`commit.template`) | `applyTemplate` | ✅ |
| Amend checkbox | `commit.toggleAmend` | 🟡 no chevron to pick target commit |
| Sign commit (GPG) | `commit.toggleSign` (`-S`) | ✅ |
| **Configure GPG Key** button | — | ❌ |
| **Author** field in commit options | — | ❌ |
| **Sign-off commit** (`-s`) | — | ❌ |
| Reformat code (changed lines only) | `checks.reformat` | ✅ |
| Optimize imports | `checks.optimizeImports` | ✅ |
| Cleanup (plus **Choose profile**) | `checks.cleanup` | 🟡 no profiles |
| Analyze code (plus **Choose profile**) | `checks.analyze` | 🟡 no profiles |
| Check TODO (plus **Configure** filter) | `checks.todo` plus pattern | ✅ |
| **Rearrange code** | — | ❌ |
| **Update copyright** | — | ❌ |
| **Check malicious dependencies** | — | ❌ |
| **Run Configuration** (run tests) before commit | — | ❌ |
| **Run advanced checks after a commit is done** (async) | checks are blocking only | ❌ |
| Commit-message inspections / spellcheck | — | ❌ |
| **Commit and Push** | `commitAndPush` | ✅ |
| **Push dialog**: left pane = editable target (`branch → origin : branch`) plus the exact commits being pushed; right pane = **the full changed-file tree of the push**, status-coloured, with per-folder counts and its own toolbar; footer = `☐ Push tags [All ▾]`, `☑ Run Git hooks`, `[Push ▾]` split button | plain `git push` | ❌ |
| **Push Rejected dialog** (Rebase / Merge, update-all, remember choice) | — | ❌ |
| *Show Push dialog for Commit and Push* setting | — | ❌ |
| Warn if CRLF separators are about to be committed | — | ❌ |
| Warn when committing in detached HEAD or during rebase | — | ❌ |
| *Do not run Git commit hooks* option | — | ❌ |
| Modal **Commit Changes dialog** (alternative to the tool window) | — | ❌ |
| *Show on Double-Click: Diff \| Source* | — | ❌ |

### 3.4 Log and history

| IntelliJ | GitTree | |
| --- | --- | --- |
| Four panes (Branches / Commits / Changed Files / Commit Details) | filter bar plus graph plus details panel | 🟡 |
| Color-coded topological graph | `GraphCanvas`, 100k commits at 60fps | ✅ |
| Sort: Date / Topo / **IntelliSort** | `sort: 'topo' \| 'date' \| 'intelli'` | ✅ |
| Branch / User / Date / Path filters | filter chips | ✅ |
| Text search plus Regex plus Match Case | search box with toggles | ✅ |
| **Go to Hash / Branch / Tag** (`Ctrl+F`) | `revealCommit` is programmatic only | ❌ |
| **Enable Git Log Indexing** | — | ❌ |
| **Presentation Settings**: Compact References View, Tag Names, Long Edges, Commit Timestamp, References on the Left, Show Root Names, column customization | — | ❌ |
| **Highlight**: My Commits, Merge Commits, Current Branch, Not Cherry-Picked | — | ❌ |
| **Show All Affected Files** (`Alt+Shift+A`) and Paths Affected in Revision dialog | — | ❌ |
| Go to Parent / Child Commit (left/right arrows) | — | ❌ |
| Multi-repo root colour stripe / root names | — | ❌ |
| Refresh | `log.refresh` | ✅ |
| Copy Revision Number | `log.copySha` | ✅ |
| New Branch / New Tag from commit | `createBranchHere` / `createTagHere` | ✅ |
| Checkout Revision | `log.checkoutRevision` | ✅ |
| Reset Current Branch to Here | `log.resetHere` (Soft/Mixed/Hard) | 🟡 no **Keep** mode |
| Compare with Local | `log.compareWithLocal` | ✅ |
| Revert Commit / Undo Commit / Drop Commit / Cherry-pick / Edit Commit Message | `commit.{revert,undo,drop,cherryPick,reword}` | ✅ |
| Interactively Rebase from Here | `rebase.interactive` | ✅ |
| **Create Patch** (from commit) | — | ❌ |
| **Show Repository at Revision** | — | ❌ |
| **Fixup** / **Squash Into** (direct from the log) | only inside the rebase editor | ❌ |
| **Squash Commits** (multi-select) | — | ❌ |
| **Push All up to Here…** | — | ❌ |
| **Add Commits to Remote Branch** | — | ❌ |
| **Rebase \<branch\> onto Selected Commit** | — | ❌ |
| View in browser / Open on GitHub-GitLab | `log.openOnRemote` | ✅ |
| **Changed Files pane toolbar**: Show Diff, Revert Selected Changes, History Up to Here, View Options (Group By / Show Details / Show Diff Preview), Expand/Collapse | details panel with folder rollup only | 🟡 |
| Changed Files context menu: Compare Before with Local, Open Repository Version, Revert Selected Changes, Cherry-Pick Selected Changes, **Extract Selected Changes to Separate Commit**, Drop Selected Changes, Create Patch, Get from Revision, History Up to Here, Show Changes to Parents | open diff only | ❌ (10 actions) |
| File **History** tab with diff preview | `showFileHistory` (log filtered by path) | 🟡 |
| **Console** tab sits directly beside **Log** in the Git tool window (verified) | `GitTree` output channel, a separate VS Code surface | 🟡 |
| **Repository** / **Incoming** / **Update Info** tabs | — | ❌ |
| Branches pane has its own **vertical icon rail** (new branch, delete, update, search, favorite, settings) | sidebar tree with a 2-button title bar | 🟡 |
| Changed Files pane and Commit Details pane are **stacked** on the right, each with its own toolbar | one details panel | 🟡 |

### 3.5 Merge and conflict resolution

| IntelliJ | GitTree | |
| --- | --- | --- |
| Files Merged with Conflicts dialog | `gittree.conflicts` tree view | 🟡 shape |
| Per-file Accept Yours / Accept Theirs / Merge… | `merge.acceptYoursFile` / `acceptTheirsFile` / `merge.open` | ✅ |
| Three panes, centre is a fully functional editor | `TriMergeEditor` (three real VS Code editors) | ✅ **strength** |
| Apply All Non-Conflicting Changes ("magic wand") | `merge.magicWand` / `magicWandSession` | ✅ |
| Apply non-conflicting changes exposed as **three separate links — Left / All / Right** — in one toolbar group | `magicWand` only (equivalent to *All*) | ❌ |
| Live status text in the toolbar: **`No changes. 1 conflict.`** | — | ❌ |
| **Show Details** link on each side header | — | ❌ |
| Global **Accept Left** / **Accept Right** buttons in the dialog footer | `merge.acceptFileYours` / `acceptFileTheirs` in the editor title bar | ✅ |
| Pane headers name the actual refs: *Changes from **master*** / *Changes from **master2*** | pane titles are `(Yours)` / `(Theirs)` | 🟡 |
| Resolve Simple Conflicts | `autoResolver` | ✅ |
| Accept / Ignore per block, Revert conflict resolution | `acceptYours/Theirs/Both`, `ignoreBlock`, `revertBlock` | ✅ |
| Next / Previous Difference (`F7` / `Shift+F7`) | bound in the tri-editor | ✅ |
| Synchronize scrolling toggle | `merge.toggleSyncScroll` | ✅ |
| Undo / redo merge (`Ctrl+Z`) | native editor undo | ✅ |
| **Compare Contents** (of the two sides) | — | ❌ |
| Abort Merge / Continue from the toolbar | `merge.abortOp` / `continueOp` | ✅ |
| *Automatically apply non-conflicting changes* setting | `merge.autoResolveWhitespace` (whitespace only) | 🟡 |
| Line-separators warning dialog (Commit As Is / Fix and Commit) | — | ❌ |

### 3.6 Stash and shelve

| IntelliJ | GitTree | |
| --- | --- | --- |
| Stash tab: Create Stash / Apply / Pop / Drop / Clear | full `gittree.stash.*` | ✅ |
| Unstash **as new branch** | `stash.branch` | ✅ |
| Reinstate Index (`--index`) | `restoreIndex` | ✅ |
| **Keep index** on create (`--keep-index`) | — | ❌ |
| Stash dialog: git-root selector, branch verification, message | QuickPick plus InputBox | 🟡 |
| Shelf tab, patches stored outside `.git` | `gittree.shelf.*` | ✅ **strength** |
| Unshelve (full / partial) | `shelf.unshelve` / `unshelvePartial` | ✅ |
| Import Patches / export | `shelf.import` / `shelf.export` | ✅ |
| **Shelve Silently** (`Ctrl+Shift+H`) | — | ❌ |
| **Unshelve Silently** (`Ctrl+Alt+U`) | — | ❌ |
| **Save to Shelf** (`Ctrl+Shift+A`, keeps local changes) | — | ❌ |
| Drag-and-drop unshelve (Ctrl+drag copies) | — | ❌ |
| **Already Unshelved** filter | — | ❌ |
| **Recently Deleted** node plus **Restore** | — | ❌ |
| Shelve dialog: file list, Group By, Show Differences, Revert | tree view | 🟡 |
| *Combine stashes and shelves in one tab* | two separate views | ❌ |
| *Shelve base revisions of files* / Change Shelves Location | `shelf.path` only | 🟡 |

### 3.7 Remote synchronization

| IntelliJ | GitTree | |
| --- | --- | --- |
| Fetch | `gittree.fetch` (`--prune`) | ✅ |
| *Fetch remote changes automatically* | `autofetch.enabled` | ✅ |
| **Pull Changes dialog**: repository, remote, branch, **Modify options** (`--rebase`, `--ff-only`, `--no-ff`, `--squash`, `--no-commit`, `--no-verify`) | bare `git pull` | ❌ |
| **Update Project** (`Ctrl+T`) with Merge / Rebase / **Reset to the Remote Branch** | — | ❌ |
| **Update Info** tab summarizing what arrived | — | ❌ |
| *Update method* and *Clean working tree using (Stash\|Shelve)* settings | — | ❌ |
| *Fetch tags* (Auto / Sync / Always / Never) | — | ❌ |
| Push / Force push | `push`, `pushForceWithLease` | ✅ |
| **Merge Branches dialog** with `--no-ff`, `--ff-only`, `--squash`, `-m`, `--no-commit`, `--no-verify`, `--allow-unrelated-histories` | drag-and-drop merge, no options | ❌ |
| **Git Rebase dialog** with `--onto`, `--rebase-merges`, `--keep-empty`, `--root`, `--update-refs`, `--autosquash` | — | ❌ |
| **Manage Remotes** dialog (add / edit / remove) | — | ❌ |
| Incoming (blue) / outgoing (green) arrows | ahead/behind in the status bar | 🟡 |
| *Check remote for incoming changes* | — | ❌ |
| *Use credential helper* | askpass implementation | 🟡 |
| **Clone Repository** dialog, shallow clone, **Unshallow Repository** | — | ❌ |

### 3.8 History rewriting

| IntelliJ | GitTree | |
| --- | --- | --- |
| Interactive Rebase dialog: reorderable rows, per-commit action | `rebaseView` webview with drag-and-drop | ✅ **strength** |
| Actions: Pick / Reword / Squash (plus Fixup) / Drop | all five | ✅ |
| **Stop to Edit** (`edit`) action | not in `ACTIONS` | ❌ |
| **Reset** button (discard all actions) | `rebase.row.resetAction` (per row only) | 🟡 |
| The dialog is titled **Rebasing Commits** and confirms with **Start Rebasing** / Cancel | webview panel, no modal framing | 🟡 |
| Dialog is **3-pane**: commit list (left) plus **Changed Files** and **Commit Details** for the selected commit (right) | single-column row list only | ❌ |
| Toolbar: move up / move down / undo / **⏸ Stop to Edit** / Reword / Squash `▾` / Drop / **Reset** (global) | per-row dropdowns; `rebase.row.resetAction` is per-row | 🟡 no global Reset, no toolbar |
| Inline reword editor with a *Press Ctrl+Enter to apply changes* hint | inline editor present | ✅ |
| Rebase status notification with Continue / Abort | `rebase.continue/skip/abort` plus `rebase.actions` | ✅ |
| Undo Commit (reverse patch into staging) | `commit.undo` | ✅ |
| Revert Commit / Drop Commit / Cherry-pick | `commit.{revert,drop,cherryPick}` | ✅ |
| Cherry-pick `-x` origin suffix on protected branches | `cherryPick.recordOrigin` | ✅ |
| Abort / Continue cherry-pick from the VCS widget | command palette only | 🟡 |
| **Rollback dialog** with file list and *Delete local copies of added files* | `rollbackFile` plus confirm | 🟡 |
| **Git Reset dialog**: Soft / Mixed / Hard / **Keep** | QuickPick, three modes | 🟡 |
| Select Target Changelist dialog (on revert / patch / cherry-pick) | — | ❌ |

### 3.9 Patches — entirely absent

`git format-patch` and `git am` never appear in `src/`. The internal
`core/patch/` module builds patches for staging and the shelf only.

| IntelliJ | GitTree | |
| --- | --- | --- |
| Create Patch from Local Changes | — | ❌ |
| Create Patch from a commit (log) | — | ❌ |
| Create Patch from a file revision (history) | — | ❌ |
| Patch File Settings dialog (location, **To clipboard**, base path, **Reverse patch**, encoding) | — | ❌ |
| Copy as Patch to Clipboard | — | ❌ |
| Apply Patch… / Apply Patch from Clipboard | — | ❌ |
| Change Directory Paths (map base dir, strip / restore leading dirs) | — | ❌ |
| Analyze and apply patch from clipboard on the fly | — | ❌ |
| Import to shelf | `shelf.import` | ✅ |

### 3.10 Repository setup, worktrees, submodules

| IntelliJ | GitTree | |
| --- | --- | --- |
| Clone Repository dialog | — | ❌ |
| Create Git Repository / Enable Version Control Integration | `git init` exists only in the playground generator | ❌ |
| Add to VCS (`Ctrl+Alt+A`) | `gittree.add` | ✅ |
| **Add to .gitignore** / **Add to .git/info/exclude** | — | ❌ |
| **Show Ignored Files** toggle | — | ❌ |
| Manage Remotes | — | ❌ |
| **Worktrees tab** plus **New Worktree** dialog plus *New Worktree from \<branch\>* | worktree paths handled internally; no management UI | ❌ |
| Submodule awareness / operations | status parser reads the submodule field only | ❌ |
| Multi-repo, "Execute branch operations on all roots" | multi-repo model exists; no all-roots switch | 🟡 |
| Directory mappings settings page | — | ❌ |

### 3.11 Local History

IntelliJ's Local History is **save-centric** (every save, refactoring, test run);
GitTree's is **git-operation-centric** (snapshots around destructive operations),
with save snapshots off by default (`localHistory.snapshotOnSave: false`). These
are different products solving overlapping problems.

| IntelliJ | GitTree | |
| --- | --- | --- |
| Show History for file / folder / project | `history.show` / `showForPath` | ✅ |
| Records **every save** automatically | opt-in, default off | 🟡 |
| Records refactorings, test runs, VCS operations as labelled events | git-operation snapshots (`SNAPSHOT_LABELS`) | 🟡 |
| **Put Label** (`File \| Local History \| Put Label`) | — | ❌ |
| **Revert Selected and Later Changes** | `history.restoreSnapshot` / `restoreFiles` | 🟡 |
| **Revert Selection** — restore a selected *fragment* only | — | ❌ |
| Chevron to copy a fragment out of the diff pane | — | ❌ |
| **Create Patch** from a local-history revision | — | ❌ |
| Search revisions by content | filter exists, no content search | ❌ |
| Restore deleted files | plus `history.recoverCommit` from the reflog | ✅ **strength** |
| *Duration of storing changes* setting | `retentionDays`, `maxSizeMb`, `maxFileSizeKb` | ✅ |
| Bridge to VS Code Timeline | present | ✅ |

### 3.12 Settings

GitTree has 38 settings. IntelliJ's Version Control settings span **Git, Commit,
Changelists, Confirmation, Shelf, File Status Colors, Background, Issue
Navigation, Diff & Merge** pages. Notable absences: *Test* button for the git
executable ❌, Configure GPG Key ❌, Protected branches ❌, Update method ❌, Clean
working tree using ❌, Fetch tags ❌, Use credential helper ❌, Combine stashes and
shelves ❌, CRLF warning ❌, detached-HEAD warning ❌, File Status Colors ❌, Diff &
Merge preferences ❌, *Highlight files from non-active changelists* ❌.
(*Path to Git executable* is present as `gittree.gitPath` ✅.)

### 3.13 Provider integrations — already a known, accepted gap

Pull Requests tool window, in-IDE review, line comments, Approve / Request
Changes, merge from the IDE, timeline with CI status — **skipped by decision**
(`docs/plan/PHASE-08-provider-integrations.md`). Not counted as a defect here.

---

## 4. Where GitTree matches or beats IntelliJ

Worth protecting during any rework:

- **Tri-pane merge editor** with a genuinely live result pane (IntelliSense, your
  keybindings, your language server). IntelliJ's centre pane is an editor too, but
  achieving this inside VS Code is the hardest thing in the codebase.
- **Interactive rebase editor** — drag-and-drop, hotkeys (`p/r/s/f/d`), inline
  reword editors, live validation. Very close to IntelliJ's dialog.
- **Shelf outside `.git`** with validated patch editing, import/export, and a
  conflict-safe partial-unshelve ladder.
- **Local History tied to git operations** plus reflog-based commit recovery —
  IntelliJ does not do reflog recovery.
- **100k-commit graph at 60fps**, with a colour-blind-safe palette and
  screen-reader labels — better accessibility than IntelliJ's log.
- **Both commit paradigms**, switchable live.

---

## 5. The plan (Tier 1 accepted, 2026-08-22)

The owner chose **Tier 1** — rebuild the containers — over Tier 2 alone (fill in
missing actions, keep the current shape). Tier 2 items are folded into the Tier 1
phases wherever the same surface is being rebuilt anyway, which is most of them.

Three phase documents carry it, each using the §2A layouts as its *shape*
acceptance criterion:

| Phase | Scope | Closes |
|---|---|---|
| [P11 — Commit tool window](plan/PHASE-11-commit-tool-window.md) | Webview UI kit + dialog host · commit window with `Commit \| Shelf` tabs · tri-state folder tree · per-change inclusion · message editor (IME/undo) · options gear with `Author:`/`Sign-off` · Shelf tab · Shelve Changes dialog | S1, S11, S12, S13, S14, §3.3, §3.6 |
| [P12 — Git tool window](plan/PHASE-12-git-tool-window.md) | `Log \| Console` tabs · four synchronized panes · Branches pane with icon rail · Changed Files · Commit Details · filter row + saved presets · patch engine · full commit context menu · `Reset → Keep` | S2, S10, §3.4, §3.8, §3.9 |
| [P13 — Dialogs & popups](plan/PHASE-13-dialogs-and-popups.md) | Twelve option-bearing dialogs · branches popup as an action hub with per-row submenus · worktree management · VCS Operations Popup · merge apply-non-conflicting Left/All/Right · spec + parity re-audit | S3, S4, S6, S7, §3.2, §3.5, §3.7, §3.10 |

Sequencing is forced by one dependency: **P11-T1 builds the webview UI kit and the
dialog host**, and P12 and P13 both consume it. After P11-T1, P12 and P13 are
independent of each other.

Two decisions from the master plan's §6 are **deliberately reversed** by P11, and
the reversal is the honest cost of Tier 1:

- §6 rejected a webview commit dialog — *"loses native SCM input, IME/undo
  quirks"*. Those objections are real; they become acceptance criteria (P11-T4
  covers IME composition and an intact undo stack) and `gittree.commit.window:
  'native'` keeps the old surface as a supported fallback.
- §6 chose `TreeItemCheckboxState` for changelists. It has no partial state, so it
  cannot express S11 no matter how the tree is arranged.

One §6 decision is **confirmed**: the branches popup stays a `QuickPick`. The
reference screenshot's own search field reads *"Search for branches **and
actions**"* — a searchable command hub is exactly what QuickPick is for, and a
webview popup would lose native search and keyboard parity for the sake of
collapsible folders. P13-T5 adds the missing content (top-level verbs, folder
drill-in, per-row submenus) rather than replacing the widget.

**Process change — the root cause fix.** `FEATURES.md` is rewritten from JetBrains'
documentation plus the §2A shapes, with every item carrying a *shape* criterion
(which container, which toolbar, which menu) beside its behaviour, and
`docs/parity-audit.md` is replaced. Leaving a spec in place that undercounts
IntelliJ's surface by 6–8× guarantees a repeat of exactly this outcome.

---

## 6. What we are keeping different on purpose

Moved to **`docs/deviations.md`**, which is now the single register of accepted
divergences. Anything not in that file is a gap to close, not a deviation.

The headline entry is the **Differences Viewer (S5)**, accepted as a deviation at
the owner's direction: every diff continues to use VS Code's native diff editor.
`docs/deviations.md#d1--differences-viewer` records what IntelliJ's viewer has that
the native one cannot express (the three toolbar dropdowns, per-change `≫`/`≪`
apply arrows, per-change include checkboxes, align-changes, compare-with-clipboard,
annotate-in-diff), why the API blocks each one, and **three costed routes to build
it later** — dress the native editor via `editor/title` (small, worth doing
regardless), a companion controls strip driving the native editor (medium), or a
full webview renderer (a phase of its own, with syntax highlighting and the bundle
budget as the real constraints). P11's `InlineDiff` is explicitly *not* that
viewer: it is a scoped component for the commit window and dialogs, where
per-change inclusion is functionally required.

The other standing deviations: no OS-modal dialogs and no anchored popups (no
API), the branch widget in the status bar rather than a top toolbar (no API),
`Show Repository at Revision` as a read-only tree rather than a project frame, the
approximated file-status palette, IntelliJ *platform* features omitted (copyright
profiles, malicious-dependency check, run configurations, post-commit upload), and
no provider integrations at all (standing project constraint).

---

## Sources

All JetBrains official documentation (`jetbrains.com/help/idea`):

- [Git](https://www.jetbrains.com/help/idea/using-git-integration.html)
- [Commit and push changes](https://www.jetbrains.com/help/idea/commit-and-push-changes.html)
- [Manage Git branches](https://www.jetbrains.com/help/idea/manage-branches.html)
- [Log tab](https://www.jetbrains.com/help/idea/log-tab.html)
- [Investigate changes](https://www.jetbrains.com/help/idea/investigate-changes.html)
- [Resolve conflicts](https://www.jetbrains.com/help/idea/resolve-conflicts.html)
- [Edit project history](https://www.jetbrains.com/help/idea/edit-project-history.html)
- [Shelve and unshelve changes](https://www.jetbrains.com/help/idea/shelving-and-unshelving-changes.html)
- [Work on several features simultaneously](https://www.jetbrains.com/help/idea/work-on-several-features-simultaneously.html)
- [Sync with a remote repository](https://www.jetbrains.com/help/idea/sync-with-a-remote-repository.html)
- [Apply changes from one branch to another](https://www.jetbrains.com/help/idea/apply-changes-from-one-branch-to-another.html)
- [Undo changes](https://www.jetbrains.com/help/idea/undo-changes.html)
- [Set up a Git repository](https://www.jetbrains.com/help/idea/set-up-a-git-repository.html)
- [Use Git worktrees](https://www.jetbrains.com/help/idea/use-git-worktrees.html)
- [Using patches](https://www.jetbrains.com/help/idea/using-patches.html)
- [Local History](https://www.jetbrains.com/help/idea/local-history.html)
- [Differences viewer](https://www.jetbrains.com/help/idea/differences-viewer.html)
- [File status highlights](https://www.jetbrains.com/help/idea/file-status-highlights.html)
- [Version Control window](https://www.jetbrains.com/help/idea/version-control-tool-window.html)
- [Settings: Version Control | Git](https://www.jetbrains.com/help/idea/settings-version-control-git.html)
