**What this document is.** The parity contract for GitTree, rewritten (P13-T9) against
JetBrains' documentation and the reference layouts transcribed in
[docs/intellij-gap-analysis.md](docs/intellij-gap-analysis.md) §2A.

The version before 2026-08-20 specified *capabilities* without the *containers* they live in,
and an audit passed against it while the product looked nothing like IntelliJ — the root cause
identified in the gap analysis §1. **Every item below therefore carries a shape criterion —
which container, which toolbar, which menu — next to what it does**, and states what GitTree
ships. Accepted divergences are named here and registered once in
[docs/deviations.md](docs/deviations.md); anything not listed there is a gap, not a deviation.

---

## 1. Global UI & Editor Integration

### Editor gutter annotations (shape + behaviour)

* **IntelliJ:** color bars in the left gutter — green added, blue modified, grey deleted —
  with a floating inline diff on click carrying Rollback / Show Diff / Copy actions.
* **GitTree:** **its own** bars, painted with `TextEditorDecorationType` against the index (or
  HEAD — `gittree.changeBars.base`), plus matching overview-ruler marks. P14-T3 replaced the
  `SourceControl.quickDiffProvider` route, which died with the SourceControl itself. Colours
  are `editorGutter.*`, a VS Code **core** token, so they theme correctly whether or not the
  built-in Git extension is installed.
* **Popup:** previous text plus **Rollback · Stage · Commit View · ↑ ↓**, on hover over a
  changed line or from `gittree.change.showActions` (`Ctrl+Alt+G H`).
* **Bounds:** untracked and ignored files get no bars (as in IntelliJ); files over
  `gittree.changeBars.maxFileLines` (default 20 000) are skipped loudly in the trace rather
  than stalling the editor. Recompute is debounced and measured — p95 0.6 ms at 5 000 lines.
* **Deviations:** the bars sit ~21px right of VS Code's own lane, which no public API can
  target (D18); the popup opens on hover or a key rather than by clicking the bar, because
  decorations expose no click handler (D19); and anchoring can differ from VS Code's by one
  line where an insertion sits between equally plausible anchors (D21).

### Diff controls and cross-file navigation (shape + behaviour)

* **IntelliJ:** the Differences Viewer's own toolbar, and — the part that matters daily — at
  the last change of a file the next-change button offers to continue into the *next file*.
* **GitTree:** its own controls on its own diffs (`isInDiffEditor && gittree.diff.active`):
  **↑ ↓ change · side-by-side/inline · ignore whitespace · collapse unchanged**, with
  `F7`/`Shift+F7` under the IntelliJ keymap.
* **Cross-file navigation:** the changed-files list you clicked from *is* the sequence. At the
  last change the first press **arms** and names the next file; the second press crosses,
  landing on its first change (or its last, going backwards). At the end of the last file it
  says so and **never wraps** — which is exactly what VS Code's own arrows do instead.
* **Deviations:** the renderer is still VS Code's, so IntelliJ's per-change apply arrows,
  highlight granularity and three-way view modes remain out of reach (D1, narrowed); and VS
  Code's own change arrows stay in the toolbar beside GitTree's, because an extension cannot
  unregister a core menu item (D20).

### Git blame (shape + behaviour)

* **Toolbar/menu:** `gittree.blame.toggle` (`Ctrl+Alt+G B`), also in the editor title menu.
* **Shape:** a fixed-width annotation column drawn as `before` decorations at the content
  edge: author · date · short sha on **every** line. Each cell's background is shaded by the
  commit's age (`gittree.blame.heatmap`) on a five-step ramp of themable colours, newest
  strongest — ranked against the other commits in the same file, as IntelliJ's annotation
  colouring is.
* **Behaviour:** hovering shows the full commit message; clicking reveals that commit in the
  Git tool window's log. Incremental (`blame --incremental`), so a large file paints as it
  streams rather than blocking.
* **Follows history, and never reports a sha that history no longer has.** Committing the
  lines you just edited, amending, resetting or rebasing re-attributes them, and the column
  repaints without the buffer being touched — a commit leaves the bytes identical, so the
  document version alone cannot see it. *Shape:* until the recomputed answer lands, the
  hover, the status-bar item and `Show in Log` fall silent rather than offering the previous
  commit's sha behind `Copy sha` / `Show Diff`; after an amend that sha is reachable from
  nothing. Coalesced across a burst, and only the annotated file is recomputed.

### The VCS status widget (shape + behaviour)

* **Location:** the **status bar** (left group), showing `branch ↑ahead ↓behind` plus a
  spinner while fetching, and a warning glyph when the upstream is gone.
* **Click:** opens the **Branches popup** (§2).
* **Deviation:** IntelliJ's New UI puts this in a top toolbar; VS Code has no such surface
  (D4).

---

## 2. Branch Management (the Branches popup as an action hub)

### The popup itself (shape)

* **Native `QuickPick`**, not a webview — chosen for real focus, type-ahead and keyboard
  parity (master §6), and vindicated by the reference, whose field reads *"Search for branches
  **and actions**"*.
* **Top-level verbs first, before any branch:** `Update Project… Ctrl+T` · `Commit… Ctrl+K` ·
  `Push… Ctrl+Shift+K` · `New Branch… Ctrl+Alt+N` · `Checkout Tag or Revision…`. They carry
  search keywords, so typing `merge` finds an action and not only branches.
* **Sections:** `Current` · `Favorites` · `Recent` · `Local` · `Remote: <name>` per remote ·
  `Tags`, favorites first, with `↑/↓` counts, short sha and subject as the dim description.
* **Folder rows:** `feature  12 branches` folds a prefix; picking it drills into a scoped popup
  with a `‹ Back` row and a breadcrumb title. **Typing collapses the folders** and searches
  flat across every level, so drill-in never traps anyone.
* **Header buttons:** new branch · **fetch (every root, as IntelliJ's is — the tooltip says
  *Fetch all repositories* whenever there is more than one)** · **incoming/outgoing toggle** · **gear** (branch
  settings) · reveal the Branches tree view (off by default behind `gittree.sidebar.extraViews`, D26 — the
  branch surfaces IntelliJ has are this popup and the log's Branches pane; the button arms the
  view's own context key, so it works whether or not the setting is on).
* **Deviation:** drill-in rather than in-place collapse — `QuickPick` cannot render a
  collapsible tree (D5).

### The `›` row submenu (shape + behaviour)

One registry (`branchActions.ts`) feeds the popup, the Branches tree view and the log's
Branches pane, so the three cannot drift. Labels interpolate the real names, separators mark
the reference's groups, and **items that do not apply are hidden, not disabled**:

`Checkout` · `New Branch from 'X'…` · `Checkout and Rebase onto '<current>'` · ——
`Compare with '<current>'` · `Show Diff with Working Tree` · ——
`Rebase '<current>' onto 'X'` · **`Merge 'X' into '<current>'`** · —— `New Worktree from 'X'…`
· —— **`Update`** · `Push…` · —— **`Tracked Branch 'origin/X'…`** · —— `Rename… (F2)` ·
`Delete` · `Toggle Favorite`.
Remote rows swap in `Pull into '<current>' Using Merge`, **`Pull into '<current>' Using
Rebase`** and `Delete 'origin/x' on Remote`.

**The checked-out branch is a branch.** It keeps everything that can mean something on it —
`New Branch from 'X'…`, `Show Diff with Working Tree` (which on HEAD is the uncommitted
work), `New Worktree from 'X'…`, `Update`, `Push…`, `Tracked Branch…`, `Rename…`,
`Toggle Favorite` — and drops only what cannot: checking it out, comparing it with itself,
merging it into itself, deleting it. Both the tree's context menu and the popup submenu now
show that same set, in the reference's own order.

**`Update`** appears only while the branch tracks a remote branch that still exists. On the
checked-out branch it *is* Update Project (fetch, then merge or rebase per
`gittree.update.strategy`). On any other branch git cannot integrate without a checkout, so
GitTree fast-forwards the ref in place — `git fetch . <upstream>:<branch>`, which git performs
only when it is a genuine fast-forward. A diverged branch is reported with its counts, never
rewritten.

**`Tracked Branch 'origin/X'`** is the upstream's own action list, re-aimed: a real submenu in
the Branches tree, a drill-in row in the popup. Nothing new runs — the rows behave exactly as
they do on the remote branch itself. **Deviation:** VS Code menu titles are static, so the
tree's submenu reads `Tracked Branch` without the ref name; the popup, which builds its labels
in code, names it.

### Core behaviour

* **Smart Checkout:** a checkout blocked by local changes is intercepted, not just reported —
  GitTree offers stash → checkout → unstash (`gittree.smartCheckout.behavior`), routing any
  resulting conflicts into the merge flow.
* **Compare with Current** opens the log filtered to the range with side badges;
  **Show Diff with Working Tree** opens the native diff.

---

## 3. The Commit Lifecycle (Commit Tool Window)

The gap analysis (§1) found the old form of this section listed behaviours without their
**shape**, and the audit passed while the product looked nothing like IntelliJ. Every item
below therefore carries a shape criterion — which container, which toolbar, which menu —
next to what it does. Reference layouts: `docs/intellij-gap-analysis.md` §2A.

### The window itself (shape)

* **One tool window**, not stacked sidebar trees: webview view `gittree.commit`, placed
  **first in the GitTree activity-bar container** (P14-T1), holding tabs `Commit | Shelf`, a
  toolbar strip, the change tree, and a bottom block (amend row · message editor · action
  buttons · options gear) — all in a single panel. There is no SCM input box to hide: P14-T4
  deleted the `vscode.scm` SourceControl entirely.
* **Toolbar** (icon buttons with tooltips): Refresh · Rollback · Show Diff · Shelve Changes ·
  Preview Diff toggle · Expand all · Collapse all.
* **Context menus:** right-click a changelist row for Commit / Set Active / New / Rename /
  Delete / Shelve, or a file row for Show Diff / Open File / Move to Changelist / Roll Back
  (P14-T2a). These were the changelists tree view's menus; they moved here with it.

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
  and icons (GitTree's own `gittree.color.*` theme colours, `gittree.colors.<status>`  overrides); a folder
  whose descendants share one status wears it, mixed folders read as modified.
* **Multi-root: one `Changes`, one `Unversioned Files`, repository rows beneath** — IntelliJ's
  shape. The same changelist in several repositories is a single row; repositories with nothing
  in it contribute no row, and the empty default list stays as one anchor however many roots are
  open. Changelist actions on a merged row fan out to every repository behind it, and a new
  changelist is created in all of them so `Move to…` offers the same names everywhere; the
  repository row carries the scoped versions, including shelve (a shelf belongs to one
  repository). Storage stays per repository
  ([D23](docs/deviations.md#d23--changelists-are-stored-per-repository-presented-per-project)).

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
* **Multi-root commit (IntelliJ's behaviour):** the tree spans every repository, so `Commit`
  commits *every* repository that has something ticked — one message, one commit each, run in
  order and stopped at the first refusal with a report of what already landed. The button says
  what it will do (`Commit to 3 repositories`, or `Commit to repoA`), sourced from the same
  predicate the commit path uses so the label cannot promise a repository the flow skips.
* **Amend stays single-repository** — it rewrites only the repository the message box is bound
  to. With changes ticked elsewhere it asks first, naming what will and will not be committed,
  rather than silently narrowing the gesture.
* Invoking `gittree.commit` **with** an explicit repository (a context menu) stays scoped to it.

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
  **multi-select dropdowns with search**: `Branch ▾` (both presets named —
  `HEAD (Current)` and `All branches` — then refs, favorites-first), `User ▾`
  (`Me` + author autocomplete), `Date ▾` (presets + from/until), `Paths ▾` (see below).
  Filters intersect. **Saved presets** live in the toolbar's Saved filters menu
  (`gittree.log.filterPresets`).
* Right toolbar: refresh · **Go to Hash/Branch/Tag** · Show Details (folds the right
  column) · Highlight my commits.
* **The graph also refreshes itself.** Any history change — a commit, amend, checkout,
  merge, rebase, reset or pull, from GitTree, the built-in Git extension or a terminal —
  re-pages the graph without the button. *Shape:* the rows rebuild but the user's place
  does not move — the focused commit stays selected with its Changed Files and Commit
  Details panes, and with nothing selected the scroll position holds. Coalesced across a
  burst (a rebase moves refs once per step) and deferred entirely while the panel is
  hidden, so a closed log costs no git. A dirty worktree alone never re-pages it.

### `Paths ▾` and the repository on show

* **`Select…`** opens the file/folder chooser; **`Select in Tree…`** ticks paths out of the
  repository's own tracked tree (tree order and depth, searchable). Both *add* to the
  selection, as typing into the panel's `path or glob` box always did. A very large
  repository offers folders only rather than truncating the alphabet — the title says so.
  Anything the chooser could not show — a glob, a withheld file — survives the pick untouched.
* **`Roots`** lists every repository in the workspace, each with its graph-palette swatch.
  "In the workspace" means found by the same search VS Code's built-in git performs: each
  open folder, the repository enclosing it, **and the repositories below it** —
  `gittree.repositoryScan.maxDepth` levels down, default one, skipping
  `gittree.repositoryScan.ignoredFolders`. Opening a plain directory of checkouts therefore
  lists exactly what opening each checkout as its own folder would, and a repository cloned
  or `init`-ed afterwards joins the list without a reload.
  The log renders **one repository at a time**, so the rows are radios: picking one moves the
  log there. The panel title carries the name of the repository on show, and the list
  follows folders joining or leaving the workspace without disturbing the rows on screen.
* **Which repository the log shows is a decision, not a guess.** The focused editor seeds it
  the first time and nothing else moves it afterwards except an explicit act: a `Roots` row,
  or a command that names its repository (`Show File History`, `Compare with Current`,
  `Show in Log` from blame or the rebase editor). The choice survives a restart. Moving root
  drops the parts of a filter that only mean something in one repository — the paths and any
  explicit ref list or range — and keeps the parts that travel: author, date, text, sort.

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
* **Every jump to a commit either lands or says why.** `Go to Hash/Branch/Tag`, `Go to
  Parent`/`Child`, `Show in Log` from blame and from the rebase editor all reveal through one
  path, and a commit the current filter excludes — a commit on an unmerged branch under the
  default `refs: HEAD`, or, under `Show File History`, a parent that never touched the file
  — is reported with **Show All Branches** offered, rather than the click doing nothing at
  all. A commit no ref can reach (a sha from before an amend) says exactly that instead.

---

## 5. 3-Way Merge Conflict Resolution

### The gate (shape)

* A conflicted operation opens **`Files Merged with Conflicts`** — a dialog listing every
  conflicted file with its kind, and the actions `Accept Yours` · `Accept Theirs` ·
  `Resolve Simple Conflicts` · `Merge…` (which opens the first file that *has* a line-level
  merge). It fires **once per session** and can be switched off
  (`gittree.merge.conflictsDialog`).
* The **`gittree.conflicts` tree view remains** the persistent surface for ongoing work —
  IntelliJ gates on the modal and keeps a view; so does GitTree.

### The tri-editor (shape)

* Clicking `Merge…` opens **three real VS Code editors**: Left "Yours" (`:2`, read-only),
  **Center "Result"** (writable `gittree-merge:` document), Right "Theirs" (`:3`, read-only).
* **Deviation, and a win:** the centre pane is a real editor, so autocomplete, diagnostics and
  formatting all work while resolving. A webview merge view would lose them (D14).

### Toolbar (shape)

* **`Apply non-conflicting changes:` Left · All · Right** — three actions, not one.
* **Live counter** in IntelliJ's wording: `No changes. 2 conflicts.` / `3 changes, 1 conflict.`
  / `All changes applied.`, shown in the status bar beside the resolved/total and file position.
* **Per-side `Show Details`** — the revision behind each pane: short sha · author · date ·
  subject.
* **`Accept Yours` / `Accept Theirs`** as explicit whole-file verbs, distinct from the
  non-conflicting applies.
* **Magic Wand** (per file and per session) — the rule cascade: identical → one-side-is-base →
  disjoint interleave → whitespace-only divergence.
* **Deviation:** git applies every non-overlapping change itself before the tri-editor opens,
  so `Left`/`Right` act on what remains inside the conflict blocks and say so when there is
  nothing one-sided to take (D17).

### Resolution mechanics (behaviour)

* **Chevrons** per block as CodeLenses on all three panes: `Accept Yours ≫`, `≪ Accept Theirs`,
  `Accept Both`, plus the block's live state in the centre.
* **Keyboard:** `F7` / `Shift+F7` next/previous conflict, `Alt+Enter` accept the focused side,
  `Ctrl+Alt+Enter` apply.
* **Sync scroll** across the three panes, toggleable.

---

## 6. Stash and Shelve

### Git stash (shape + behaviour)

* **Shape:** the **`Stash` tab of the Commit tool window** (`Commit | Shelf | Stash`), where
  IntelliJ keeps it — one row per entry (`stash@{N} · message`, relative time, origin branch),
  expanding to its files, each opening a real diff against the working tree. Files are read on
  expand, because `git stash show` costs a run per stash. Actions carry the stash **sha**, not
  `stash@{N}`, so a row acted on after the list shifted cannot hit a different stash.
  `gittree.stash.combineWithShelf` is IntelliJ's *Combine stashes and shelves in one tab*
  (off by default, as there): on, the third tab folds into the Shelf tab. The
  `gittree.stashes` tree view survives behind `gittree.sidebar.extraViews` (off by default, D26).
* **Dialogs (P13-T4):** `Stash Changes…` — message plus **Modify options** revealing
  `--keep-index`, `--include-untracked`, `--all` and `--staged` (offered only when the git
  build has it, with the reason stated when it does not). `Unstash Changes…` — the stash list,
  `[x] Pop stash`, `[ ] Reinstate index`, a target-changelist selector and an inline diff of
  the selected file *inside* the stash.
* **Behaviour:** a conflicted pop is demoted to apply semantics by git and routed into the
  merge flow, with the entry kept.

### Git shelve (shape + behaviour)

* **Concept parity:** patches stored **outside** `.git`, so they survive deleting or
  re-initializing the repository — the whole point of shelving.
* **Shape:** a **`Shelf` tab in the commit tool window** plus the `gittree.shelf` tree, and the
  `Shelve Changes` dialog (toolbar → changelist selector → checkbox file tree → `N modified` →
  message → collapsible `∨ Diff` with per-change include checkboxes → `[Shelve Changes]`).
* **Behaviour:** partial shelving down to individual changes; export/import as `.patch`;
  unshelve with or without removing the shelf.

---

## 7. Deep Provider Integrations (GitHub / GitLab)

**Not implemented, by owner decision — this is a standing project constraint, not a gap.**
GitTree performs no remote-account actions of any kind: no sign-in, no pull-request tool
window, no in-IDE review, no CI status. Phase 8 was skipped deliberately. `Clone…` accepts a
URL and does not enumerate a provider's repositories. Registered as D11.

---

## 8. The Failsafe: Local History

* **Shape:** `Show Local History` opens the `gittree.localHistory` view **on demand**, the
  way IntelliJ's `Show History` opens its own window — the view is not contributed at all
  until either `gittree.sidebar.extraViews` is on or the command arms its context key, rather than standing open
  as a sidebar section (D26). Snapshots are grouped by day, each expanding to the
  files it holds, with `Show Diff`, `Restore` and `Restore Selected Files…`.
* **Behaviour:** a snapshot is taken **before every destructive operation** (checkout on a
  dirty tree, reset, rebase, merge, cherry-pick, revert, stash pop/apply/drop/clear, unshelve,
  rollback, clean, force branch delete, smart checkout), plus optional save- and task-end
  snapshots. Restores are byte-exact, including CRLF and missing final newlines, and take a
  paranoia snapshot first so a restore is itself undoable.
* **Recovery:** dangling-commit recovery from the reflog for the cases a snapshot cannot cover
  (a bad `reset --hard` of committed work).
* **Deviation:** a bespoke store rather than VS Code's Timeline — `TimelineProvider` is a
  proposed API and cannot ship in a published extension (D12).

---

## 9. Dialogs, Popups and the Action Hub

IntelliJ drives its Git operations through **option-bearing dialogs**; before P13 GitTree stood
25 of them up as QuickPick/InputBox chains that hid every real flag.

* **Shape shared by all of them:** a focus-trapped editor-area panel (D2) with a title row, a
  scrollable body, and a footer carrying `?` on the left and the actions on the right. Where
  IntelliJ shows *Modify options*, GitTree shows the same: a compact primary form plus a
  dropdown of the actual git flags, each ticked option revealing its control — and un-ticking
  one **turns the flag off**, so a flag the user cannot see never survives into the command.
  Contradictory combinations are reported **with reasons** and disable the action.
* **Every dialog shows the exact command it will run** in a dim `will run:` line, built by the
  same argv function the host executes (`gittree.dialogs.showCommandLine`).
* **The set:** `Push` (per-repo sections, editable target row, the push's changed-file tree,
  tags/hooks footer, `[Push ▾]` with Force Push) · `Update Project` (merge/rebase radio,
  `Do not show again` → `Ctrl+T` runs directly, `Reset to the Remote Branch`) · `Merge` ·
  `Rebase` · `Reset` (four modes including **Keep**, with a live impact line) · `Rollback`
  (checkbox tree + inline diff + `Delete local copies of added files`) · `Cherry-Pick` ·
  `Stash` · `Unstash` · `Apply Patch` (pre-apply summary with missing-file warnings) ·
  `Clone` · `Manage Remotes` · `New Worktree` · `Files Merged with Conflicts`.
* **VCS Operations Popup:** `` Alt+` `` opens every action applicable *right now*, enumerated
  from the dialog and branch-action registries rather than a hand-kept list, with an
  in-progress group first (continue / skip / abort), diff and commit groups when their context
  is present, and recently used actions floated to the top.

---

## 10. Worktrees

* **Shape:** the **`Worktrees` tab of the Git tool window** (`Log | Console | Worktrees`),
  where IntelliJ keeps it — one row per worktree showing its branch (or `detached at <sha>`)
  and its path, a `Locked` or `Prunable` label **only** in those two states, double-click to
  open, and a toolbar of `New Worktree…`, `Remove`, `Lock`/`Unlock`, `Prune`, `Refresh`.
  The `gittree.worktrees` tree view survives behind `gittree.sidebar.extraViews` (off by default, D26).
* **`New Worktree` dialog:** three branch modes (existing branch · new branch from a start
  point · detach at a revision), a location defaulting to the sibling `../<repo>-<branch>`, and
  `--no-checkout` / `--force` behind Modify options.
* **Behaviour:** removing a **dirty** worktree is refused with git's own reason, `--force`
  being the explicit escape hatch; the main worktree cannot be removed.
* **Deviation:** on git < 2.36 the lock/prunable flags are derived from git's on-disk layout,
  because the porcelain does not report them there (D16).
