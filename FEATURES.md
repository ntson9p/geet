> **⚠️ Obsolete contract — do not cite as a parity standard.** A 2026-08-20 review
> against JetBrains' documentation and a live IntelliJ install found this document
> undercounts IntelliJ's real Git surface by roughly 6–8×, and specifies
> *capabilities* without the *containers* they live in — the two root causes behind
> [docs/intellij-gap-analysis.md](docs/intellij-gap-analysis.md). It is scheduled for
> rewrite by P13-T9 (see [docs/plan/PHASE-13-dialogs-and-popups.md](docs/plan/PHASE-13-dialogs-and-popups.md)),
> after which every item will carry a *shape* criterion alongside its behaviour.
> Until then, treat the gap analysis as the parity standard.

Below is the exhaustive, structured specification of IntelliJ IDEA Ultimate’s Git features, broken down by UI/UX components and underlying functionalities.

---

## 1. Global UI & Editor Integration

### Editor Gutter Annotations

* **Color-Coded Line Tracking:** The left editor gutter shows vertical color bars indicating line status: **Green** (added), **Blue** (modified), **Grey** (deleted).
* **Click-to-Diff:** Clicking a color bar opens a floating inline diff viewer showing the original code versus the current code.
* **Inline Rollback:** From this floating popup, the user can click a "Rollback" icon to revert just that specific hunk, or a "Stash/Commit" icon to manage it.

### Git Blame (Annotations)

* **Toggleable Gutter Blame:** Right-clicking the gutter allows users to enable "Annotate with Git Blame."
* **Visual History:** The gutter expands to show the author's name, date, and commit hash for every line.
* **Color Fading:** Recent commits are highlighted in darker/bolder colors, while older commits fade, providing a heat-map of code age.
* **Interactivity:** Clicking a blame annotation opens the corresponding commit in the Git Log tool window.

### The VCS Status Widget

* **Location:** Bottom right of the status bar (or top left in the New UI).
* **Function:** Displays the current branch name, sync status (arrows with numbers for incoming/outgoing commits). Clicking it opens the **Branches Popup** (detailed below).

---

## 2. Branch Management (The Branches Popup)

IntelliJ abandons command-line branch switching for a highly categorized, searchable, and protective GUI.

### Structure & UI

* **Search Bar:** Filters branches by name instantly.
* **Categories:** Branches are strictly categorized into: **Current Branch**, **Recent Branches** (automatically populated based on checkout frequency), **Local Branches**, and **Remote Branches**.
* **Favorites:** Users can click a star icon next to any branch to pin it to the top.

### Core Functionalities

* **Smart Checkout:** If local uncommitted changes conflict with the target branch, IntelliJ intercepts the `git checkout` failure and offers a "Smart Checkout." It automatically stashes the changes, checks out the target branch, and unstashes the changes, initiating a merge conflict resolution if necessary.
* **Context Menu Actions per Branch:**
* *Checkout*
* *Checkout and Rebase onto Current*
* *New Branch from Selected*
* *Compare with Current* (Opens a unified tree view showing all commits and file diffs between the two branches).
* *Show Diff with Working Tree*
* *Rename / Delete / Push*

---

## 3. The Commit Lifecycle (Commit Tool Window)

The gap analysis (§1) found the old form of this section listed behaviours without their
**shape**, and the audit passed while the product looked nothing like IntelliJ. Every item
below therefore carries a shape criterion — which container, which toolbar, which menu —
next to what it does. Reference layouts: `docs/intellij-gap-analysis.md` §2A.

### The window itself (shape)

* **One tool window**, not stacked sidebar trees: webview view `gittree.commit`, placed
  **first in the SCM container**, holding tabs `Commit | Shelf`, a toolbar strip, the change
  tree, and a bottom block (amend row · message editor · action buttons · options gear) — all
  in a single panel. The native SCM input box is hidden while this window owns the message.
* **Toolbar** (icon buttons with tooltips): Refresh · Rollback · Show Diff · Shelve Changes ·
  Preview Diff toggle · Expand all · Collapse all.
* **Escape hatch:** `gittree.commit.window: "native"` restores the pre-P11 surface (the
  `gittree.changelists` tree + SCM input box + `gittree.shelf` tree) without a reload.

### The change tree (shape + behaviour)

* Group rows per changelist (plus **Unversioned Files**), IntelliJ **folder rows** beneath
  with single-child chains collapsed (`src/main/java` is one row), files at the leaves.
* **Tri-state checkboxes on group, folder and file rows** — ticking a folder resolves to its
  leaf set; a partially ticked folder renders the mixed state `TreeItemCheckboxState` cannot.
* **Unversioned files are tickable** and start unticked; a ticked untracked file joins a
  whole-repo commit but never a "commit this changelist".
* **Per-change inclusion:** selecting one file with Preview Diff on shows its changes with an
  include checkbox each and an `N differences, M included` counter; the tree row says
  `M of N changes`. Excluding the last change unticks the file. Stale selections (the file
  moved) fall back to whole-file, loudly — renumbered hunks are never committed.
* **Density:** `N files` badge on every group and folder node; status-colored file **names**
  and icons (theme `gitDecoration-*` colors, `gittree.colors.<status>` overrides); a folder
  whose descendants share one status wears it, mixed folders read as modified.

### Paradigm A: Changelists (the default)

* Bypasses the index entirely; changes live in IDE-managed lists (default list, active list,
  auto-adoption of new changes). Commit = tick what you want — group, folder, file, or an
  individual change inside a file.
* Partial commits build the target tree in a scratch index (`GIT_INDEX_FILE`); the working
  tree is never written, so an interrupted commit cannot damage a file.

### Paradigm B: Git Staging Area

* Mirrors native `git add`: Staged/Unstaged groups, hunk/line staging from the diff editor.
  Switchable via `gittree.commit.paradigm` / `gittree.commit.switchParadigm`.

### The message editor (shape + behaviour)

* Multi-line, autogrowing from 6 rows, in the window's bottom block — with a working native
  **undo stack** (programmatic inserts are undoable) and **IME-safe** composition (nothing
  round-trips mid-composition).
* **Amend row:** `[ ] Amend  last commit ▾  🕘  N of M files` — the checkbox keeps the P3
  semantics (loads the previous message, pushed-HEAD guard); the `▾` lists recent commits so
  their message can be reused; the 🕘 clock opens the 50-entry **message history** dropdown
  (first line + relative time) in place.
* Soft subject hint: a right-aligned counter past 72 characters; never blocks.

### Commit options gear popup (shape)

The `⚙` beside the action buttons opens the §2A popup inside the window:

* **Git** — `Author:` field (`Name <email>`, completion from recent authors, validated,
  `×` to clear; lands as `--author=`) · `[ ] Sign-off commit` (`-s`).
* **Commit Checks** — `Reformat code` (modified lines only) · `Optimize imports` ·
  `Cleanup` + `Choose profile` (the code-action kind it applies).
* **Advanced Commit Checks** — `Analyze code` + severity picker · `Check TODO` + pattern ·
  `[x] Run advanced checks after a commit is done` with the caption *"Failed checks will not
  prevent a commit"* — the IntelliJ default: Analyze/TODO run **after** the commit and report
  via notification; untick to restore pre-commit gating.

### Shelf (shape + behaviour)

* The **Shelf tab** lists entries (name · relative time · `N files` · origin branch)
  expanding to their files; toolbar: Unshelve… · Unshelve Silently · Unshelve Files… ·
  Rename… · Delete · Import Patch… · Show-already-unshelved eye toggle. Context menus are
  native per row (entry and file). Damaged entries (sha256 mismatch) render inline with a
  warning and refuse to unshelve. Applied-but-kept entries grey out behind the eye toggle.
* **Shelve Changes dialog** (`gittree.shelve.dialog`, also the toolbar's Shelve button):
  toolbar → `Changelist: ▾` selector → checkbox tree → `N modified` → message → collapsible
  `∨ Diff` section with **per-change include checkboxes** → `[Shelve Changes] [Cancel]`, plus
  `[x] Remove shelved changes from the worktree`. Shelving selected changes stores exactly
  them and leaves the residue in the worktree byte-identically.

### Commit Actions

* `[Commit]` `[Commit and Push…]` in the bottom block; amend alone commits without a new
  message; GPG sign toggle (`-S`) kept from P3.

---

## 4. Git Log & History (Git Tool Window)

Like §3, every item here carries its **shape criterion** — which container, which pane,
which toolbar — because the pre-P12 audit passed on behaviours while the product was a
single-pane list. Reference layout: `docs/intellij-gap-analysis.md` §2A ("Git tool window —
docked bottom, tabs `Log | Console`").

### The window itself (shape)

* **One bottom-docked tool window**: webview view `gittree.log` in the `gittree-panel`
  panel container, holding tabs **`Log | Console`** (active tab persisted), simultaneously
  visible with the left-docked Commit window and the editor. `gittree.log.focus` (`alt+9`)
  focuses it on the last active tab.
* **Log tab = filter row + four synchronized panes** in nested splitters:
  `[Branches | Commits] | [Changed Files / Commit Details]` — the right column splits
  vertically. Every splitter ratio persists; double-click resets. Each pane has a header row
  (chevron · name · per-pane toolbar); panes collapse to slim bars keeping their state — the
  Commits pane, the window's centre, deliberately never collapses. `Tab`/`Shift+Tab` cycle
  the pane headers with a visible focus ring; panes carry aria names.
* **One selection model, host-side:** the graph's multi-select is mirrored to the host and
  drives Changed Files, Commit Details, and every selection-scoped menu action from a single
  list — no pane keeps its own copy.

### The Branches pane (shape)

* Sections `HEAD (Current)` → `Local` (favorites ★ flat-first, then **folder nodes** —
  `feature/f1`, `f1-1`, `f2` collapse under one `feature` row) → `Remote` per remote →
  `Tags`, with a **vertical icon rail** on the pane's left edge: new branch · delete ·
  compare-with-current · search · favorites-only · show-my-commits · collapse.
* **Selecting a ref filters the Commits pane** through the filter model (Ctrl adds;
  `HEAD (Current)` restores). Branch rows have a native context menu (checkout, new from,
  compare, diff with working tree, rebase onto current, push, rename, delete, favorite)
  backed by the same action registry the Branches popup uses (§2), so surfaces cannot drift.

### The graph and its filters

* Color-coded topological graph, canvas-drawn, **virtualized to 60 fps at 100k commits**
  (§13 budgets re-validated with all four panes mounted — see `docs/perf.md`); refs render
  as typed chips; `Date`/`Topo` sort (IntelliSort is a recorded deviation).
* **Filter row, §2A order:** `Branch or tag` combo (datalist over every ref) · `Text or hash`
  with `.*` regex and `Cc` match-case toggles (a hash navigates instead of grepping) · four
  **multi-select dropdowns with search**: `Branch ▾` (favorites-first), `User ▾`
  (`Me` + author autocomplete), `Date ▾` (presets + from/until), `Paths ▾` (chips +
  `Browse…`). Filters intersect. **Saved presets** live in the toolbar's Saved filters menu
  (`gittree.log.filterPresets`).
* Right toolbar: refresh · **Go to Hash/Branch/Tag** · Show Details (folds the right
  column) · Highlight my commits.

### Changed Files & Commit Details panes (shape)

* **Changed Files:** repo row (`repo · N files · path`) → folder rows with counts →
  status-colored files with rename pairs; tree/flat toggle, preview-on-click, multi-diff,
  Show History for Revision. A **multi-commit selection shows the aggregate diff**
  (`oldest^..newest`), and file clicks open range-scoped diffs. Population is lazy —
  selection pushes ids, each pane fetches its own data.
* **Commit Details:** subject → `<hash> <author>` (+ copy actions) → `<email> on <date> at
  <time>` → typed ref chips → committer-when-different → **GPG signature state** → clickable
  parent links → lazy `Contained in branches: Show all`. Body URLs and issue keys
  (`gittree.log.issuePattern`/`issueUrl`) are linkified.

### The Console tab (shape)

* A read-only structured mirror of **every git command the extension runs**: one collapsible
  row per run — time · `git argv` · exit code · duration · output head — failures
  pre-expanded and colored; filter box; Copy command / Copy output; Clear. The ring holds
  `gittree.log.console.limit` entries (default 2 000) and is **redacted before storage**
  (URL userinfo, askpass values, `--author` identities). No re-run affordance — deliberate
  (deviation D10).

### Commit context menu (complete)

Right-clicking commits in the graph (native menu, multi-select aware):

* **Interactive Rebase** (P5's bespoke editor: drag-and-drop reorder, Pick/Squash/Reword/
  Fixup/Drop per row, force-push acknowledgement on published ranges, pause/continue monitor).
* **Undo Commit** · **Revert Commit** · **Cherry-Pick** · **Drop Commit** · **Reword**.
* **Create Patch…** (`format-patch`-faithful, binary-safe) and **Apply Patch…**
  (`git am -3` for mailboxes with degrade-to-`apply --3way`; conflicts land in the §5 flow).
* **Fixup… / Squash Into…** — commits the ticked changes as `fixup!`/`squash!`, then offers
  a non-interactive `--autosquash` fold.
* **Push All up to Here** (exact-sha push, non-fast-forward refused) · **Reset Here**
  (Soft/Mixed/Hard/**Keep**, destructive modes snapshot first) · **Checkout Revision** ·
  **New Branch/Tag here** · **Compare with Local** · **Branches ›** (lazy `--contains`) ·
  **Go to Parent / Child** · **Show Repository at Revision** (read-only `gittree-tree:`
  virtual tree) · Copy Revision Number · Open on remote (browser URL only).

---

## 5. 3-Way Merge Conflict Resolution Engine

This is widely considered IntelliJ's strongest feature. When a merge conflict occurs, the "Conflicts" dialog appears.

### The UI Layout

* Clicking "Merge" opens a dedicated three-pane window.
* **Left Pane:** Local version (Your changes).
* **Right Pane:** Server/Remote version (Their changes).
* **Center Pane:** The "Result" file being built.

### Resolution Mechanics

* **The Magic Wand:** A button in the toolbar that automatically resolves all "simple" (non-overlapping) conflicts instantly.
* **Chevrons (`>>`, `<<`):** Conflicts are highlighted with colored blocks. Clicking the chevron on the left pulls your code into the center; clicking the chevron on the right pulls their code in.
* **Manual Editing:** The center pane is a fully functional editor with syntax highlighting and autocompletion, allowing manual rewriting if `>>`/`<<` isn't sufficient.
* **Accept Left / Accept Right:** Global buttons to blindly overwrite with one side's version.

---

## 6. Stash and Shelve

IntelliJ supports native Git stashing and its own proprietary shelving.

### Git Stash

* Standard `git stash` GUI. Allows saving the working directory, viewing the stash list, diffing stashes against the current working tree, and popping/applying them.

### Git Shelve

* **Concept:** An IDE-specific feature that stores uncommitted changes as `.patch` files on the local disk, entirely outside of Git's `.git` directory structure.
* **Why it exists:** It allows users to store changes safely even if they need to delete the Git repository or perform destructive Git operations that might wipe native stashes.
* **UI:** A dedicated "Shelf" tab in the Commit Tool window allows users to view shelved patches, edit them, and unshelve them to the current working tree.

---

## 7. Deep Provider Integrations (GitHub / GitLab)

Ultimate Edition integrates cloud provider APIs to move code review into the IDE.

* **Pull Requests Tool Window:** Lists all open PRs. Users can filter by assignee, author, or state.
* **In-IDE Review:** Clicking a PR opens its diffs. Users can add comments directly to lines of code inside the IDE, submit reviews (Approve, Request Changes), and merge the PR.
* **Timeline View:** Shows the conversation thread, CI/CD pipeline status (e.g., GitHub Actions results), and commit list.

---

## 8. The Failsafe: Local History

While not strictly a Git feature, no implementation plan of IntelliJ's VCS capabilities is complete without **Local History**.

* **Function:** The IDE independently records every file save, test run, and Git operation in an offline, invisible timeline, completely independent of Git.
* **UX:** If a user accidentally runs a destructive Git command (e.g., a bad `git reset --hard` or deleting an uncommitted file), they can right-click the project root, select "Local History -> Show History," and restore the exact state of the files from 5 minutes ago. Your VSCode extension should bridge to VSCode's native "Timeline" feature to replicate this safety net.
