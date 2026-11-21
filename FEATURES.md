**What this document is.** The parity contract for Geet, rewritten (P13-T9) against
JetBrains' documentation and the reference layouts transcribed in
[docs/intellij-gap-analysis.md](docs/intellij-gap-analysis.md) §2A.

The version before 2026-08-20 specified *capabilities* without the *containers* they live in,
and an audit passed against it while the product looked nothing like IntelliJ — the root cause
identified in the gap analysis §1. **Every item below therefore carries a shape criterion —
which container, which toolbar, which menu — next to what it does**, and states what Geet
ships. Accepted divergences are named here and registered once in
[docs/deviations.md](docs/deviations.md); anything not listed there is a gap, not a deviation.

---

## 1. Global UI & Editor Integration

### Editor gutter annotations (shape + behaviour)

* **IntelliJ:** color bars in the left gutter — green added, blue modified, grey deleted —
  with a floating inline diff on click carrying Rollback / Show Diff / Copy actions.
* **Geet:** **its own** bars, painted with `TextEditorDecorationType` against the index (or
  HEAD — `geet.changeBars.base`), plus matching overview-ruler marks. P14-T3 replaced the
  `SourceControl.quickDiffProvider` route, which died with the SourceControl itself. Colours
  are `editorGutter.*`, a VS Code **core** token, so they theme correctly whether or not the
  built-in Git extension is installed.
* **Popup:** **Rollback · Stage · Commit View** at the cursor from `geet.change.showActions`
  (`Ctrl+Alt+G H`). The full popup — previous text plus those actions and **↑ ↓** — also opens
  on hover over a changed line when `geet.changeBars.hoverActions` is on (off by default).
* **Bounds:** untracked and ignored files get no bars (as in IntelliJ); files over
  `geet.changeBars.maxFileLines` (default 20 000) are skipped loudly in the trace rather
  than stalling the editor. Recompute is debounced and measured — p95 0.6 ms at 5 000 lines.
* **Deviations:** the bars sit ~21px right of VS Code's own lane, which no public API can
  target (D18); the popup opens from a key — or, opted in, on hover — rather than by clicking
  the bar, because decorations expose no click handler (D19); and anchoring can differ from
  VS Code's by one line where an insertion sits between equally plausible anchors (D21).

### Diff controls and cross-file navigation (shape + behaviour)

* **IntelliJ:** the Differences Viewer's own toolbar, and — the part that matters daily — at
  the last change of a file the next-change button offers to continue into the *next file*.
* **Geet:** its own controls on its own diffs (`isInDiffEditor && geet.diff.active`):
  **← → file · side-by-side/inline · ignore whitespace · collapse unchanged**, with
  `Shift+Alt+←`/`→` for the files and `F7`/`Shift+F7` for the changes under the IntelliJ keymap.
* **Cross-file navigation, on VS Code's own ↑ ↓ and `Alt+F5`:** the list you clicked from *is* the
  sequence, a commit's Changed Files, the Commit window's changes or the Compare pane's files, in the
  order the list shows it, or only the rows selected when there are several. At the last change the first press shows a tooltip, **Press again to go to the next
  file**, with that file's name and position. The second press crosses in the same tab, landing on
  its first change (or its last, going backwards). At the end of the last file it says so and
  **never wraps**. Other diffs keep VS Code's behaviour, and
  `geet.diff.goToNextFileAfterLastChange` turns this off.
* **The Commit window's list is live**, and spans every changelist and repository with Unversioned
  Files last, as IntelliJ's does. A file that starts changing joins the walk, one that is reverted
  or committed leaves it, and the file on screen stays up either way. The right side is the real
  file, so you can edit it as you go.
* **The Compare pane's list stays as it was read**, as IntelliJ's does, so every diff keeps agreeing
  with it when a branch moves. Refresh reads it again. Against the working tree the right side is the
  real file, so you can edit it as you go.
* **What a row compares:** with changelists, `HEAD` against the working tree, which is what the
  commit will produce and what the preview pane shows. With staging, what is not staged yet against
  the index, or else what is staged against `HEAD`.
* **Along the way:** the tab says where you are (`foo.ts (62c3e1a) 3/7`), and the list shows it too:
  the name of the file on screen is highlighted, the way VS Code highlights a name in a tree, until
  the diff is closed or another editor comes in front. A walk over the whole list moves the
  selection with it, as IntelliJ's does; one over several selected rows leaves them selected, and
  the highlight says which of them is open. An added or deleted file is a stop like any other; one
  with no text change is skipped by ↓, though `→` still shows it. A binary file reads as
  `Binary file, 79 bytes (7d1ad7a)`.
* **Deviations:** the renderer is still VS Code's, so IntelliJ's per-change apply arrows,
  highlight granularity and three-way view modes remain out of reach (D1, narrowed); the walk
  itself differs in four small ways, images among them (D20).

### Git blame (shape + behaviour)

* **Toolbar/menu:** `geet.blame.toggle` (`Ctrl+Alt+G B`), also in the editor title menu.
* **Shape:** a fixed-width annotation column drawn as `before` decorations at the content
  edge: author · date · short sha on **every** line. Each cell's background is shaded by the
  commit's age (`geet.blame.heatmap`) on a five-step ramp of themable colours, newest
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

### Completion notifications (behaviour)

When an operation you started finishes, a notification says what it did, in IntelliJ's words
(`src/ui/notify.ts`):

* **Fetch** (every repository, or one) says *Fetch successful*, and names the remote branches
  it pruned. Automatic background fetch stays silent, as IntelliJ's does.
* **Pull** says *Already up to date*, or *Pulled 3 commits from origin/main: 7 files changed*.
  The same goes for a remote branch's *Pull into Current*.
* **Commit** says *2 files committed: Fix the parser*. A commit spanning several repositories
  says it once, counting all their files.
* **Branches:**
  - *Checked out main*, and *Checked out new branch x from origin/x*;
  - *Branch x was created*, and *Branch x was renamed to y*;
  - *Merged x to main* or *Already up to date*;
  - *Rebased main on x*, and *Checked out x and rebased it on main*;
  - *Deleted remote branch origin/x*;
  - **Delete** says *Deleted branch x* (adding *Unmerged commits were discarded* when it had to
    force), with **Restore**, which puts the branch back at its old tip, tracking what it
    tracked, and **Delete Tracked Branch** while it tracked one. These two buttons replace
    the question Geet used to ask after a delete.
* **Log:** *Created tag v1*, *Checked out 1393301c* and *Reset successful*. **Edit Commit
  Message** says *Commit message changed*, with **Undo**, which works while nothing has
  happened to the branch since. **Undo Commit** says *Undo commit successful*.
* **Rebase, merge, cherry-pick and revert:** *Rebase successful* when a rebase finishes
  (continued, skipped past a conflict, or from the interactive editor); *Abort rebase
  succeeded*, *Merge abort succeeded*, *Cherry-pick abort succeeded*; *Cherry-pick continue
  successful*.
* **Stash and shelf:** *Files stashed successfully*, *Stash successfully applied*, *Changes
  shelved successfully*, *Successfully created patch …*.
* **Several repositories at once:** a branch action run "in all N repositories" says it once
  (*Checked out develop*) rather than once per repository.
* **Files:** `Roll Back…` says *Rolled back 2 files.*, as the Rollback dialog does, and
  `Delete Untracked Files…` says how many it deleted.
* **Already reporting before:** push, Update Project, revert, drop, squash, the option dialogs
  and worktrees. They keep their own reports. The Merge, Rebase and Reset dialogs now use the
  same wording as above.

**How long they stay** (new-way-6). A notice with nothing to click leaves after 5 seconds
(`geet.notifications.durationSeconds`), and so do Geet's other plain information
messages: *Nothing to stash.*, *No changes to commit.*. A long one gets a second for every
four words past ten, up to twice the setting.

* The time counts only while VS Code is in front: away in another application, the notice
  waits for you, and finishes what is left of its time when you are back, as IntelliJ's
  balloons do. VS Code's own toasts stay 10 seconds, more while the pointer rests on them.
* VS Code cannot hide a notification on a timer and still keep it in the Notifications list
  (the bell), so these leave no entry there. The **Geet** output keeps a copy:
  `[notice] 13:27:54 Checked out develop`.
* Such a notice has no `×`: VS Code draws none while a timed notification runs. `Escape` hides
  it, and VS Code then shows its words in the status bar until the time is up.
* `0` makes them ordinary notifications again, kept in the Notifications list.
* A notice with buttons (**Restore**, **Undo**), a warning or an error is always an ordinary
  notification: it asks for a decision, or says something went wrong. So is the one-time
  notice at startup, and the merge editor's **Show Details**.

Staging, unstaging, rolling back one change from the gutter, `Add to .gitignore` and
changelist edits stay quiet,
as they do in IntelliJ: their effect is in front of you the moment they finish. Dropping or
clearing stashes, and renaming or deleting shelved changes, stay quiet for the same reason.

---

## 2. Branch Management (the Branches popup, and the sidebar's Repositories and Branches panels)

### The popup itself (shape)

* **Native `QuickPick`**, not a webview — chosen for real focus, type-ahead and keyboard
  parity (master §6), and vindicated by the reference, whose field reads *"Search for branches
  **and actions**"*.
* **Top-level verbs first, before any branch:** `Update Project… Ctrl+T` · `Update Project
  Without Fetching…` · `Commit… Ctrl+K` · `Push… Ctrl+Shift+K` · `New Branch… Ctrl+Alt+N` ·
  `Checkout Tag or Revision…`. With several repositories, `Checkout Tag or Revision…` gives
  way to `Checkout Branch in All Repositories…`: it checks out in one repository, and the top
  level could not say which. Each repository's own verbs keep it, and so does a search
  confined to one repository. From the Command Palette with several repositories, **Geet:
  Checkout Tag or Revision…** asks which repository first, the one with the open file listed
  first and marked, so `Enter` takes it. They carry
  search keywords, so typing `merge` finds an action and not only branches. The keys are
  named only with the IntelliJ keymap on (`geet.keymap.intellij`), the one that binds
  them. Every menu that names IntelliJ's keys follows the same rule.
* **Sections:** `Current` · `Favorites` · `Recent` · `Local` · `Remote: <name>` per remote ·
  `Tags`, favorites first, with `↑/↓` counts, short sha and subject as the dim description.
* **Folder rows:** `feature  12 branches` folds a prefix; picking it drills into a scoped popup
  with a `‹ Back` row and a breadcrumb title. **Typing collapses the folders** and searches
  flat across every level, so drill-in never traps anyone.
* **Header buttons:** new branch · **fetch (every root, as IntelliJ's is — the tooltip says
  *Fetch all repositories* whenever there is more than one)** · **incoming/outgoing toggle** · **gear** (branch
  settings) · reveal the Branches tree view (off by default behind `geet.sidebar.extraViews`, D26 — the
  branch surfaces IntelliJ has are this popup and the log's Branches pane; the button arms the
  view's own context key, so it works whether or not the setting is on).
* **Multi-root — the project level:** with more than one repository the popup **opens at the
  project**, not inside a guessed root: the verbs, then a row per repository (name · current
  branch · `↑↓`, `›` to drill in), then `Common Local Branches` · `Common Remote Branches` ·
  `Common Tags` — the refs *every* root carries. Drilling into a repository gives its own
  popup unchanged, titled with its name, with `‹ Back` to the project. The status-bar widget
  opens the project level with its own repository's row selected. A single-root workspace is
  unchanged.
* **Common rows act on every root:** `Checkout` · `Update` · `Merge into the current branch` ·
  `Rebase the current branch onto it` · `Pull into the current branch using Merge`/`… Rebase` ·
  `Push` · `Stop tracking`, each dispatched per root through the same registry, labelled with the count it will
  actually touch (`Checkout in 5 of 7 repositories`) and stopping at the first refusal.
* **Deviation:** drill-in rather than in-place collapse — `QuickPick` cannot render a
  collapsible tree (D5); and the all-roots set is the operations needing no per-root input,
  since Geet's take their input inside the per-repository call (D27).
### The sidebar's Repositories and Branches panels (shape + behaviour)

Under the Commit window, two panels of Geet's own design, not the popup standing open
(D34): **Repositories** (`geet.repositoryList`), with several repositories, and
**Branches** (`geet.branches`). Until POST-P14co they were one panel titled
*Repositories*, with a REPOSITORIES and a BRANCHES pane; before that, one titled *Branches*.
The Branches panel kept the id, so layouts and keybindings carry over. Together they answer
three questions, top to bottom.

**Where am I?**

* **One repository:** there is no Repositories panel. The Branches panel's first row is the
  current branch — name, what it tracks, `↓ ↑` counts, changed files — and a double-click (or
  its chevron, or Enter) opens its card.
* **Several repositories:** the **Repositories** panel, one row per repository in the order the
  user reads them, each with a coloured dot (its colour in the log's `Roots`), what it has
  checked out, `↓ ↑` and changed files. Over them, its own filter, **Fetch** and **`⋯`**
  (below); no heading inside it, no count: VS Code's own header names the panel. The branches
  are the **Branches** panel under it (below).
* **Two panels, so VS Code folds, sizes and scrolls each** (POST-P14co): twenty repositories
  never push the branches out of sight, a panel folded stays folded, and VS Code keeps the
  sizes. They were two panes of one panel with a divider of their own (new-way-6).
  - **A line marks the divider between them**: a 2px line along the Repositories panel's foot,
    in `geet.sectionBorder`, as under the Commit window (POST-P14bu).
* **The Repositories panel's filter** (POST-P14cp), at its top, lists only the repositories
  whose names match what is typed: every word, anywhere in the name the panel shows, in either
  case, matched letters marked. A banner (a rebase, a merge) goes with its repository; with
  nothing matching, it says so. Typing on a repository's row, or Ctrl+F, goes to it.
  - **It only filters the list.** What is picked, and so the Branches panel and the Commit
    window, stays as it was: a picked repository the filter hides is still picked.
  - **`Enter` shows the first match alone**, as a click on its row does, and puts the keyboard
    on that row. A second `Enter` keeps it so (a second click would show every repository).
    `↓` moves to the first match and picks nothing; `↑` from the top row goes back to the
    filter; `Escape` clears it, and again goes back to the row.
  - **Fetch** (every repository; it spins until done) is to the filter's right. It was in the
    Branches panel's toolbar, where it stays with one repository, which has no Repositories
    panel.
  - **`⋯`** (POST-P14cq), last on the line, is the panel's own menu; a right-click in the
    list's empty space (or on its *No repository matches*) opens it too, at the pointer:
    - **Update, Update Without Fetching, Commit and Push act on what is in view**
      (POST-P14bx, POST-P14by), and say so:
      - with every repository shown, the project's: **Update Project…**, **Update Project
        Without Fetching…**, **Commit…**, **Push…**, as `Ctrl+T`, `Ctrl+K` and `Ctrl+Shift+K`
        (the keys are shown beside them under the IntelliJ keymap, and only then);
      - with one picked: **Update Repository…**, **Commit Repository…**, **Push
        Repository…**;
      - with two: **Update 2 Repositories…**, **Commit 2 Repositories…**, **Push 2
        Repositories…**.

      Commit commits what is ticked in those repositories, with the message typed in the
      Commit window, one commit each; the Amend box applies only when its repository is among
      them. Push opens the Push dialog with every repository listed and those ticked. They used
      to act on the project with two of four picked, and on the one picked under the project's
      words. They were the Branches panel's `⋯`'s until POST-P14cq: they act on the
      repositories, here beside the highlighted rows they mean, and the Branches panel keeps
      the work on branches. With one repository they stay there (below), as Fetch does;
    - *Show*: **Incoming / Outgoing Counts**, the one switch that changes this panel's rows
      (their `↓ ↑`). It is one setting with the Branches panel's, so either menu changes both.
  - A name on the Commit window's filter bar whose row the filter hides clears the filter, so
    the row can take the keyboard.
* Every repository row has **Update Repository…**, **Push…**, **Fetch** (that repository
  alone; it spins while it runs) and **`⋯`** on hover. Right-click or `⋯` gives the
  repository's menu, whose update is **Update Repository…** and **Update Repository Without
  Fetching…** too (POST-P14bx; it said *Update Project…*, which everywhere else updates every
  repository). With one repository, the current-branch row has the same buttons, and there the
  update is **Update Project…**: that repository is the project.
* **A narrow sidebar keeps the names.** What a branch tracks gives way before the branch's own
  name does, and its hover still has it. Below about 250px the hover buttons fold into `⋯`,
  whose menu has the rest (a Fetch still turning stays); below about 190px the changed-file
  count and what the branch tracks go, and the card says the latter in full.
* **An operation in progress** gets a banner under its repository: *Rebasing 2/5 · 2
  conflicts* with **Resolve…** (the *Files Merged with Conflicts* dialog), **Continue**
  (**Skip** too for a rebase) and **Abort**. For a merge the button is IntelliJ's **Commit
  Merge**: it commits at once with git's prepared message. A message of your own is
  written in the Commit window.

**Where can I go?**

The branches sit under four **tabs**, one list at a time, since the four overlap: every recent
branch is a local one, and most local ones have a remote twin. Each tab counts what it holds,
and its hover says so in words (*18 local branches*). The panel starts again on the tab last
picked; at first, on Recent while anything is recent, else Local.

* **Recent** — the starred branches, then the ones checked out lately (from the reflog), at
  most eight.
* **Local** — folded into folders on `/` (*Group by Folder*), starred first, then by name; the
  folder holding the current branch starts open.
* **Remote** — one group per remote, folded the same way.
* **Tags** — newest first. Not there while *Show Tags* is off.
* **Scrolled past, the tabs stay at the top** of the list, and a click on one starts the new
  list right under them. On the tabs, `←` and `→` switch, round the ends, and `↓` goes into the
  list.
* **In a narrow sidebar the counts go first**, then some padding: every tab keeps its name down
  to VS Code's narrowest sidebar.
* **An empty tab says so**, and what would fill it: *No recent branches yet. The ones you check
  out or star appear here.*
* Every branch row shows its `↓ ↑` against its upstream, its last commit's age (`3h`, `2d`,
  `5mo`) and up to three chips:
  - **merged**: all its commits are on the main branch (`origin/HEAD`'s target, else
    `origin/main`, `origin/master`, `main`, `master`);
  - **gone**: the remote branch it tracked was deleted;
  - **`→ origin/x`**, in the warning colour: it tracks a remote branch of another name, so a
    push goes there. The current-branch row says the same in place of its upstream.
* **Several repositories are one list.** A branch name is one row however many repositories
  have it. Its actions run in every repository it stands for and say so: *Checkout in 2
  repositories*.
* **Each row says which repositories have its branch** (with several in view, in the tabs and
  in a search alike), between its `↓ ↑` counts and its age, so the words line up down the
  list: *in api, web* (up to three named, in the Repositories panel's order), *in both* or *in
  all 20* (every repository in view: said, not left blank), *in 13 of 20* (more than three).
  They come after the row's hover buttons, so they hold still when those show; the branch's
  name gives way instead (on a hovered checked-out branch at 300px, down to a letter or two),
  and a long list of names ends in `…` at about a third of the row. Below about 250px they become a count
  (*in 2*); below about 190px they go. The row's hover names every repository, the ones
  without it when there are three or fewer (*Not in shared*), and where it is checked out when
  that is only some of them (*Checked out in api*); a screen reader hears *develop, in api and
  web*. Narrowed to one repository, rows say nothing of where: the scope pill names it. Narrowed
  to some, they speak of those.
* **Repository Dots** (off by default, `geet.branches.showRepositoryDots`) put a dot per
  repository in view on each row in place of those words: filled where the branch is checked
  out, ringed where it exists, small where it does not. They are switched by the toolbar's dots
  button (shown pressed while they are on), by `⋯` › *Show* › **Repository Dots**, and by
  **Geet: Toggle Repository Dots**. Either way a branch's card lists the repositories,
  grouped by what they say about it.
* **A repository's menu** (right-click, or its `⋯`) opens with the ways of looking at it:
  **Show Only This Repository** and **Show in New Log Tab**, its history at HEAD in a Log tab of
  its own (titled with the repository's name wherever another tab would read the same). It is a
  new tab even when the first Log tab shows exactly that; an extra tab already showing it comes
  forward instead of a second. The Repositories (Tree) view, one setting away, has it too, first
  in its menu. With one repository it is left out of the current branch's menu, whose own **Show in
  New Log Tab** stands above it, unless HEAD is detached.
* **Scope.** Clicking a repository in the Repositories panel shows only its branches in the
  Branches panel; Ctrl+click adds or removes one. An `@` in the Branches panel's filter picks
  them too (below). A pill in that filter (`web ×`) names the scope and widens it again. The
  scope narrows what is shown *and* what the rows act on; one pick for both panels.
  - **The Commit window follows it** (POST-P14ce): it lists only the repositories picked, says
    so in a bar over its list with *Show all*, and commits only them
    ([D45](docs/deviations.md#d45--the-repositories-panels-pick-narrows-the-commit-window)). The
    pick is kept for the workspace by Geet, not by the panel, so either one changes it.
  - **Clicking the repository shown alone again shows every repository again.** Clicking one
    of several picked shows it alone. Each row's hover says what its click will do.
  - **A picked repository's row is highlighted, every picked one alike, and only while it is
    picked** (POST-P14bw); the others dim. A row is not highlighted for having been clicked:
    the second click leaves it as the other rows are. The keyboard's place among the rows is
    a focus ring with the row's buttons, shown only for the keyboard (a click leaves no ring);
    `Enter` or `Space` picks the row as a click does.

**What can I do with it?**

* **A click selects a branch, and nothing more:** its hover buttons stay on it, ready to act.
  Its **card** opens under the row on demand: the **chevron** at the row's left (it shows on
  hover, on the selected row and while the card is open), a **double-click**, or **Enter**,
  **Space** or **→**; the same, **←** or **Escape** shut it. A double-click never checks out:
  with many repositories in view, that would be a costly accident. The card holds:
  - the last commit, its author and age;
  - where the branch stands against what it tracks (*2 to push, 1 to pull · origin/x*,
    *Not published*, *Not tracking origin/x*, *origin/x was deleted on the remote*), with a
    **Stop tracking** link while it tracks anything. With several repositories, a repository's
    line has that link only when it tracks a remote branch of another name;
  - where it stands against what is checked out (*3 commits ahead of main, 1 behind*,
    *Already in main*);
  - the actions its state makes likely:
    - **Checkout** and **Merge into `<current>`** for a branch with work of its own;
    - **Checkout** and **Delete** for one that is merged or whose remote branch is gone;
    - **Update** and **Push…** (and **New Branch…**) for the checked-out one;
    - **Checkout** and **New Branch…** for a tag.
  - With several repositories in view, **repositories that say the same about the branch are
    one line**: the group's dots, then its repositories named (up to three: *api, web*) or
    counted (*13 repositories ›*, *All 20* when every one in view is in step), then what they
    share (*checked out*, *→ origin/x* with its **Stop tracking**, *up to date*, *↓2*, *2 ahead, 4
    behind current*). The largest group comes first, then the exceptions. A counted group lists
    its repositories, a line each, when its count is clicked. Twenty repositories in step are
    one line, not twenty. A repository whose facts are still on their way is grouped by what is
    known, and joins its own line if they set it apart.
  - With several repositories in view, the ones that **lack the branch** are a line too: *not in
    shared*, *not in 4 repositories ›*. A branch only one of them has keeps the full tracking and
    relation lines, naming that repository.
  - Its buttons are then the all-repositories operations (*Checkout in 2*).
  - When they do not all fit, the buttons drop their words rather than shrink each to a
    letter: the first keeps its own longest, then they are icons, each named on its hover,
    down to VS Code's narrowest sidebar. A narrow card leaves out who made the last commit
    and keeps when.
* **Hovering a row** (or selecting it) shows **Checkout** (or **Update** and **Push…** on the
  checked-out branch), the **star** and **`⋯`**. They come *before* the counts, the dots and
  the age, as VS Code puts a row's actions before its decorations: they take the free space,
  or the end of a long name, and nothing to their right moves.
* **Right-click or `⋯`** shows every action, from the same registry as the popup and the log's
  Branches pane (below), with real submenus:
  - **Tracked Branch `'origin/x'`** holds the upstream's own actions, and **Stop Tracking
    `'origin/x'`** follows it;
  - with several repositories, the all-repositories operations come first (*Checkout in all 3
    repositories*), then one submenu per repository with its own full menu: listed under *In
    one repository* while the branch is in five repositories or fewer, else held in one **In
    One Repository ›** row, so twenty repositories do not bury the actions (new-way-6).
    IntelliJ's own menu has no such list: its actions run in every repository, and one
    repository's are in that repository's part of the popup;
  - **a menu never runs off the panel.** A Geet menu is drawn inside its webview, so past the
    webview's height it scrolls, the arrow keys bringing the row they reach into view, and past
    its width the labels end in `…`. A row the pointer has not moved onto, because the menu
    opened beneath it or scrolled under it, does not take the keyboard's place. This holds for
    every Geet menu: the log's, the Commit window's and the dialogs' too.
  - **Checkout reaches every repository in view that has the branch, on a remote too.**
    `release/2.0` may be a local branch in one repository and only `origin/release/2.0` in
    three more: its row offers **Checkout in 4 of 5 repositories**, the local branch where
    there is one and a new one tracking the remote branch where not. A remote row does the
    same. A repository with no such branch stays where it is, and one in the middle of a merge
    or with conflicts to resolve is skipped; the result says which.
  - **Show in New Log Tab** opens the branch's graph in a Log tab of its own in the Geet panel
    (`Log: release/2.0`), so the tabs already open keep their filters; a tab already showing it
    comes forward instead. It leads the group that looks at a branch, after the checkout group
    and beside **Compare with `'main'`** and **Show Diff with Working Tree**, and a remote
    branch or a tag has it too. The log draws one repository at a time (**D24**), so a branch
    several repositories have offers **Show in New Log Tab ›** naming each of them.
* **Drag** a local branch onto another to merge or rebase (the branch trees' own prompt).
* **The Branches panel's toolbar** (the one panel's, until POST-P14co): the filter, **Fetch**
  with one repository (every repository; spins until done; with several it is beside the
  Repositories panel's filter, POST-P14cp), **Repository Dots** (with several repositories in
  view; a two-by-two grid of dots, pressed while on), **New Branch**, and **`⋯`**:
  - with one repository only, first, **Update Project…**, **Update Project Without
    Fetching…**, **Commit…** and **Push…**: that repository is the project, and there is no
    Repositories panel to hold them. With several they are the Repositories panel's `⋯`'s
    (above, POST-P14cq), a repository picked or not;
  - New Branch…, Checkout Tag or Revision… (only with one repository in view: with several,
    the `⋯` could not say which it would act on, and each repository's own menu has it),
    **Checkout Branch in All Repositories…** (with
    several repositories in view: every branch any of them has, local or remote, most widely
    held first, *4 of 5 repositories · local in api · from origin in web, docs and tools · not
    in infra*), **Clean Up Branches…**;
  - *Show*: Tags, Incoming / Outgoing Counts (the Repositories panel's `⋯` has it too: one
    setting), Repository Dots (with several repositories in view), Group by Folder;
  - Collapse All: every folder and remote of the tab on show, the ones opened by hand too.
* **The filter** searches every kind at once, whatever tab is picked: the tabs step aside, and
  each kind's matches sit under a heading (*Local*, *Remote*, *Tags*) as whole names, Recent
  stepping aside so as not to list a match twice. Every word must match; matched letters are
  marked; `Enter` opens the first match. When nothing matches it offers **Create branch
  "…"** (not for a name git refuses, `@` alone among them). Typing anywhere in the list starts
  a search (in the Repositories panel, of the repositories: above); clearing it brings the tabs
  back as they were. `↑` from the top of the list goes back to the filter.
* **`@` in the filter picks repositories** (POST-P14co; with several repositories). An `@` at
  the start of the filter or after a space opens a list of every repository under the field,
  a square checkbox each, with its colour and what it has checked out; what follows the `@`
  narrows the list by name (spaces too: `@local - Copy`), matched letters marked. A tick picks
  a repository: the same pick as a click in the Repositories panel, which highlights it, and
  as the pill, which names it; the Commit window follows. **Ticked is picked; none ticked is
  every repository**, which the first row, *All repositories*, says and goes back to. Ticking
  the last one left, or unticking the last picked, is every repository too.
  - `↓` `↑` move the highlighted row, round the ends; **`Enter` ticks it and closes the
    list**; a click ticks a row and leaves the list open for the next; `Escape`, `Tab` or a
    click elsewhere closes it. Closing takes the `@` and what followed it out of the filter;
    what came before it still filters the branches, while the list is open too.
  - An `@` inside a word (`user@host`) is searched for, as a branch name may hold one. With
    one repository there is nothing to pick, and an `@` is searched for. The filter says
    *(type @ to pick repositories)* before anything is typed, as VS Code's Quick Open says
    what its `:` and `@` do.
* **New Branch** is a form in the Branches panel, not a chain of input boxes; a repository's
  **New Branch…** in the Repositories panel opens it there, for that repository:
  - a name, cleaned as you type as IntelliJ's field does (a space becomes `_`);
  - **Check it out** (ticked);
  - **From**: where it starts, typed or picked from what the repositories have, the most
    widely shared first (`main · branch · in all 5`); empty, each repository's own current
    branch. A repository without that start point cannot be chosen;
  - with several repositories, a chip per repository to choose where;
  - from a remote branch, a line saying what the branch will track: nothing, or the remote
    branch whose name it takes.
  - It says what would make Create fail before Create is pressed: an invalid name, a name a
    chosen repository already has, a start point a repository lacks, a repository in the
    middle of a merge. *New Branch from 'x'…* on any branch opens the same form starting at `x`.
* **Across several repositories, local changes in the way are asked about once.** A Checkout,
  or a New Branch checked out, that meets uncommitted changes git would overwrite goes on with
  the other repositories; then one question covers every repository it stopped: **Smart
  Checkout** (set them aside, switch, put them back), **Force Checkout** (throw them away; Local
  History keeps a copy), or Cancel, leaving those repositories where they were (a new branch is
  made there all the same). `geet.smartCheckout.behavior` answers it when set. One repository
  that fails does not stop the others: one notification says what happened in each, problems
  first.
* **Clean Up Branches…** lists the local branches that look finished, grouped by repository:
  - merged into the main branch — ticked;
  - their remote branch deleted but not merged (a squash merge leaves exactly that) — unticked,
    and asked about once more before deleting;
  - sitting on the main branch's very tip — unticked: just created, or merged by fast-forward.
  - The checked-out branch is never offered. The notification after deleting has **Restore**,
    which brings each branch back tracking what it tracked.

### The `›` row submenu (shape + behaviour)

One registry (`branchActions.ts`) feeds the popup, the Branches tree view and the log's
Branches pane, so the three cannot drift. Labels interpolate the real names, separators mark
the reference's groups, and **items that do not apply are hidden, not disabled**:

`Checkout` · `New Branch from 'X'…` · `Checkout and Rebase onto '<current>'` · ——
`Compare with '<current>'` · `Show Diff with Working Tree` · ——
`Rebase '<current>' onto 'X'` · **`Merge 'X' into '<current>'`** · —— `New Worktree from 'X'…`
· —— **`Update`** · `Push…` · —— **`Tracked Branch 'origin/X'…`** · **`Stop Tracking
'origin/X'`** · —— `Rename… (F2)` · `Delete` · `Toggle Favorite`.
Remote rows swap in `Pull into '<current>' Using Merge`, **`Pull into '<current>' Using
Rebase`** and `Delete 'origin/x' on Remote`.

**The checked-out branch is a branch.** It keeps everything that can mean something on it —
`New Branch from 'X'…`, `Show Diff with Working Tree` (which on HEAD is the uncommitted
work), `New Worktree from 'X'…`, `Update`, `Push…`, `Tracked Branch…`, `Stop Tracking…`,
`Rename…`, `Toggle Favorite` — and drops only what cannot: checking it out, comparing it with itself,
merging it into itself, deleting it. Both the tree's context menu and the popup submenu now
show that same set, in the reference's own order.

**`Update`** appears only while the branch tracks a remote branch that still exists. On the
checked-out branch it runs Update Project's fetch-and-integrate **without asking** — IntelliJ's
branch `Update` uses the saved update method, and only `Update Project…` puts the question — with
the remembered strategy: `geet.update.strategy`, else the last answer to that question, else
Merge. On any other branch git cannot integrate without a checkout, so
Geet fast-forwards the ref in place — `git fetch . <upstream>:<branch>`, which git performs
only when it is a genuine fast-forward. A diverged branch is reported with its counts, never
rewritten.

**`Tracked Branch 'origin/X'`** is the upstream's own action list, re-aimed: a real submenu in
the Branches tree, a drill-in row in the popup. Nothing new runs — the rows behave exactly as
they do on the remote branch itself. **Deviation:** VS Code menu titles are static, so the
tree's submenu reads `Tracked Branch` without the ref name; the popup, which builds its labels
in code, names it.

**`Stop Tracking 'origin/X'`** removes the link and nothing else (`git branch --unset-upstream`):
the branch and the remote branch both stay, and the next push offers a branch of the branch's own
name. It appears on any local branch with an upstream, one the remote has deleted included. The
notification has **Undo** while the remote branch still exists. **Deviation:** IntelliJ offers
this only as a checkbox in its Rename dialog (D35).

**`Rename…`** on a tracked branch notes that it still tracks its upstream, and offers **Stop
Tracking**. If the remote branch has the old name it also offers to push the new name and delete
the old one; a remote branch of any other name is not the branch being renamed, so deleting it is
never offered.

### Core behaviour

* **A new branch tracks nothing, unless it takes the remote branch's own name.** `mine` from
  `origin/develop` tracks nothing, so its first push creates `mine` on the remote; `develop` from
  `origin/develop` tracks it, as `Checkout` on a remote branch does. The same goes for the panel's
  form, the input box and New Worktree, and for every start point, whatever
  `branch.autoSetupMerge` says. **Deviation:** git and IntelliJ both make `mine` track
  `origin/develop`, after which its push lands on `develop` (D35).
* **Smart Checkout:** a checkout blocked by local changes is intercepted, not just reported —
  Geet offers stash → checkout → unstash (`geet.smartCheckout.behavior`), routing any
  resulting conflicts into the merge flow.
* **Compare with Current** opens a Log tab of its own, `Compare: main and feature/x`, holding both
  branches' commits, marked ◀ and ▶, under a line that says how many each has alone. Each commit has
  its Changed Files and its menu, as anywhere in the log. **Show Files Diff** on that line lists every
  file that differs between the two tips (D36).
* **Show Diff with Working Tree** lists every file that differs between the branch and the working
  tree. Both lists are in the **Compare pane** in the sidebar, which each request replaces: status
  colours and letters, folders, renames marked `← old/path`. A click opens the diff and leaves the
  keyboard in the list; a double click goes into the diff. **Refresh** reads the list again, **Show All
  Files in Multi-Diff** gives VS Code's page of all of them, and **Close** puts the pane away.

---

## 3. The Commit Lifecycle (Commit Tool Window)

The gap analysis (§1) found the old form of this section listed behaviours without their
**shape**, and the audit passed while the product looked nothing like IntelliJ. Every item
below therefore carries a shape criterion — which container, which toolbar, which menu —
next to what it does. Reference layouts: `docs/intellij-gap-analysis.md` §2A.

### The window itself (shape)

* **One tool window**, not stacked sidebar trees: webview view `geet.commit`, placed
  **first in the Geet activity-bar container** (P14-T1), holding tabs `Commit | Shelf`, a
  toolbar strip, the change tree, and a bottom block (amend row · message editor · action
  buttons · options gear) — all in a single panel. There is no SCM input box to hide: P14-T4
  deleted the `vscode.scm` SourceControl entirely.
* **Toolbar** (icon buttons with tooltips): Refresh · Rollback · Show Diff · Shelve Changes ·
  Preview Diff toggle · View Options (with several repositories) · Expand all · Collapse all.
* **The borders a drag resizes are drawn** (POST-P14bu): a line in the theme colour
  `geet.sectionBorder` runs along each, so you can see where to grab. The Commit window
  has two:
  - **its bottom edge**, on VS Code's own divider between it and the view under it (the
    Repositories panel). VS Code's modern look draws no line between views, and its classic
    look only a faint one;
  - **the divider between the change tree and Preview Diff**, along its middle. Under the
    pointer the whole divider lights instead.

  The Repositories panel draws the third, along its foot, on the divider above the Branches
  panel (§2, *The sidebar's Repositories and Branches panels*; between its two panes until
  POST-P14co). The lines take no clicks of their own: pointing at one shows the resize cursor and
  lights the divider, as before. The colour is see-through white in dark themes, see-through
  black in light ones, and the theme's border colour in high contrast.
  `workbench.colorCustomizations` changes it, and transparent hides the lines.
* **Context menus:** right-click a changelist row for Commit / Set Active / New / Rename /
  Delete / Shelve, or a file row for Add to VCS / Open Changes / Open File / Reveal in File
  Explorer / Move to Another Changelist / Roll Back / Add to .gitignore (P14-T2a). These were the
  changelists tree view's menus; they moved here with it. As in IntelliJ, an action on a row acts
  on every file beneath it:
  - **Reveal in File Explorer** (**Reveal in Finder** on macOS, **Open Containing Folder** on
    Linux, VS Code's own names for it) opens the system's file manager on a file row's folder
    with the file selected, or on a folder row's parent with the folder selected. It is in every
    list: your changelists, Unversioned Files, Merge Conflicts, and Staged and Unstaged with the
    staging area. It shows the row clicked, not the rest of a selection. VS Code's own key for
    it, `Shift+Alt+R` (`⌥⌘R` on macOS, `Ctrl+Alt+R` on Linux), shows the keyboard's row while
    the change tree has focus. It is left out on a deleted file, which has nothing on disk to
    select, and in a remote window, whose files are on another machine; a WSL window has it
    from VS Code 1.113. A file deleted since the tree was drawn, or a deleted row reached by the
    key, says *… is no longer on disk.*
    ([D41](docs/deviations.md#d41--the-commit-windows-rows-open-the-file-manager))
  - **Unversioned Files** (the row, a repository's share of it, or its row under a repository)
    has **Add to VCS**, into the default list, and **Move to Another Changelist…**, and none of
    a changelist's own actions: it is not one.
  - **A folder row** has Add to VCS (with new files in it) · Open Changes (walking its files) ·
    Move to Another Changelist… · Roll Back… · Add to .gitignore (all of it new). For a folder
    git tracks nothing in, Add to .gitignore writes the folder's rule, `/.idea/`, not a line per
    file.
  - **A repository row** (Repository › Changelist) adds Add to VCS (with new files) and Move to
    Another Changelist… for all of its changes.
  - **Move to Another Changelist…** offers each list once across repositories (the one every
    file is already in left out), and New changelist…; a repository without the list gets one
    under the same name. New files it moves are added to VCS in that list, as IntelliJ's Move
    does. **Add to VCS** leaves a file already moved into a list in that list.

### The change tree (shape + behaviour)

* Group rows per changelist (plus **Unversioned Files**), IntelliJ **folder rows** beneath
  with single-child chains collapsed (`src/main/java` is one row), files at the leaves.
* **Merge Conflicts** first while any file is unmerged, in either paradigm, as IntelliJ's
  node: no checkboxes and no changelist actions. A conflicted file opens in the merge
  editor. The row's **Resolve Conflicts…** (on hover and in its menu) opens *Files Merged
  with Conflicts*.
* **Tri-state checkboxes on group, folder and file rows** — ticking a folder resolves to its
  leaf set; a partially ticked folder renders the mixed state `TreeItemCheckboxState` cannot.
* **Tick every change at once** (POST-P14cf,
  [D46](docs/deviations.md#d46--the-commit-windows-counter-ticks-every-change-and-its-blank-space-has-a-menu)):
  the `7 of 120 files` counter has a box in front of it, empty, mixed or ticked as the rows' boxes
  are. A click ticks every change the list shows, new files included, or, all ticked, unticks
  them all; narrowed to some repositories, only those. IntelliJ's keys too: Ctrl+A selects every
  row, and Space on a row of a selection of several ticks them all, or unticks them all when every
  one is ticked. With the staging area there is no box.
* **The list's blank space has its own menu** (under the rows, on "No changes.", on the filter
  bar): New Changelist… while changelist rows are shown, Tick All / Untick All Changes (Stage All /
  Unstage All Changes with staging), Expand All / Collapse All, Show All Repositories while
  narrowed, Refresh. The window's chrome (tabs, toolbar, Amend row) has no menu; the message box
  and the commit options' text fields keep Cut, Copy and Paste.
* **Unversioned files are tickable** and start unticked; a ticked untracked file joins a
  whole-repo commit but never a "commit this changelist".
* **Per-change inclusion:** selecting one file with Preview Diff on shows its changes with an
  include checkbox each and an `N differences, M included` counter; the tree row says
  `M of N changes`. Excluding the last change unticks the file. Stale selections (the file
  moved) fall back to whole-file, loudly — renumbered hunks are never committed.
* **Density:** `N files` badge on every group and folder node; status-colored file **names**
  and icons (Geet's own `geet.color.*` theme colours, `geet.colors.<status>`  overrides); a folder
  whose descendants share one status wears it, mixed folders read as modified.
* **Multi-root: one `Changes`, one `Unversioned Files`, repository rows beneath** — IntelliJ's
  shape. The same changelist in several repositories is a single row; repositories with nothing
  in it contribute no row, and the empty default list stays as one anchor however many roots are
  open. Changelist actions on a merged row fan out to every repository behind it, and a new
  changelist is created in all of them so `Move to…` offers the same names everywhere; the
  repository row carries the scoped versions, including shelve (a shelf belongs to one
  repository). Storage stays per repository
  ([D23](docs/deviations.md#d23--changelists-are-stored-per-repository-presented-per-project)).
  A **repository row wears its repository's colour**, a filled square as IntelliJ draws a root:
  the colour of its chip in the log's `Roots` and its dot in the Repositories panel, in a light
  theme or a dark one and with `geet.log.graphPalette`. Its name is plain text, whatever its
  files' status; the files keep their status colours. After its file count comes **its branch**
  in a tinted label, as IntelliJ shows it (a detached HEAD shows its commit); the hover says
  what the branch tracks. Repositories are named and ordered as the Repositories panel lists
  them, and so does the Commit button (*Commit to api*). In a narrow sidebar the branch gives way
  first, then the count; the name stays.
* **Or repositories first: View Options › Group By** (the eye before Expand all, shown only
  with several repositories, as IntelliJ shows its Repository grouping only then). It offers
  **Changelist › Repository** (the default, IntelliJ's shape) and **Repository › Changelist**:
  one row per repository with changes, its own lists beneath in IntelliJ's order (Changes, your
  lists, Unversioned Files), folders and files as before
  ([D37](docs/deviations.md#d37--the-commit-window-can-put-repositories-first)). The eye gets
  IntelliJ's dot while repositories come first.
  - A repository row's checkbox ticks everything beneath it, new files included. Its menu has
    **New Changelist…**, **Shelve Changes…** (that repository's) and **Rollback…** (its tracked
    changes, ticked in the dialog to untick). A list row under it is that repository's copy of
    the list and has the same menu a repository row under a list has in the other grouping.
  - **Switching keeps your place:** the same files stay selected, the keyboard stays on the same
    row, and the row you were looking at keeps its height on screen. A row with no twin hands
    over to its nearest one: a changelist spanning repositories to its first repository's copy,
    a repository to its first list. Each grouping keeps its own folders open or shut, opens
    everything the first time it is shown, and Collapse all shuts only its own. A repository or
    list row that appears later appears open.
  - Saved in `geet.commit.groupBy` (your settings, or the workspace's if you keep it there); also from the palette, *Geet: Group
    Changes by Repository* and *by Changelist*. With one repository both look the same, and
    neither the eye nor the commands are offered.
  - Nothing else changes: the counter, the message, Amend and *Commit to 2 repositories* work on
    the same ticks whatever the grouping, and a diff walks the files in the order shown.
* **Narrowed to the repositories picked in the Repositories panel** (POST-P14ce,
  [D45](docs/deviations.md#d45--the-repositories-panels-pick-narrows-the-commit-window)): the list
  shows only theirs, still under their repository rows, and a bar over it says so whether that
  panel is open or folded:
  - the repositories shown, in their colours, or *2 of 5 repositories* when the names do not fit;
    then the changes left out, `· 3 changes elsewhere`, or `· 5 ticked elsewhere` in a warning
    colour when some are ticked; its hover lists them. A name brings the Repositories panel up on
    that repository; **Show all** shows every repository again, in both panels;
  - **what you see is what you commit**: the Commit button, *Commit and Push…*, Ctrl+Enter and
    *Commit* from the palette (Ctrl+K) commit only the repositories shown, the button names them,
    and the notification says where the commit went. Ticks out of view stay ticked. With nothing
    ticked in the repositories shown but something elsewhere, *Commit* says so and offers *Show
    All Repositories*;
  - the message box stays the edited repository's, so a message typed before narrowing stays on
    screen; Amend (its hover names the repository), its ▾ list, the options and Shelve act on a
    repository the list shows;
  - the counter counts what the list shows, the view's badge every change. Rollback, Show Diff,
    the preview and Expand/Collapse all act on the rows shown: a selected row left out is no
    longer selected, and Collapse all leaves the rows of the repositories left out as they were;
  - narrowed to repositories with nothing to commit, the list says *No changes in docs.* beside
    *Show all repositories · 9 changes*. A repository row's menu has **Show Only This
    Repository**, or on the repository shown alone **Show All Repositories**.

### Paradigm A: Changelists (the default)

* Bypasses the index entirely; changes live in IDE-managed lists (default list, active list,
  auto-adoption of new changes). Commit = tick what you want — group, folder, file, or an
  individual change inside a file.
* Partial commits build the target tree in a scratch index (`GIT_INDEX_FILE`); the working
  tree is never written, so an interrupted commit cannot damage a file.

### Paradigm B: Git Staging Area

* Mirrors native `git add`: Staged/Unstaged groups, hunk/line staging from the diff editor.
  Switchable via `geet.commit.paradigm` / `geet.commit.switchParadigm`.
* The Commit window draws IntelliJ's staging-area nodes instead of changelists: **Merge
  Conflicts**, **Staged**, **Unstaged** and **Unversioned Files**, without checkboxes. A file
  staged in part is in both Staged and Unstaged. Rows, folders and nodes carry **+** (Stage)
  or **−** (Unstage) on hover and in their menu; unstaging a staged rename takes its old path
  back too, and a new file becomes untracked again. A Staged row's diff is HEAD against the
  index; an Unstaged row's is the index against the file, where the *Stage hunk* lenses are.
  The preview pane shows the row's half with nothing to tick. The counter reads
  *N of M files staged*, and **Commit** commits the index: nothing staged, nothing to commit.

### The message editor (shape + behaviour)

* Multi-line, autogrowing from 6 rows, in the window's bottom block — with a working native
  **undo stack** (programmatic inserts are undoable) and **IME-safe** composition (nothing
  round-trips mid-composition).
* **Amend row:** `[ ] Amend  last commit ▾  🕘  N of M files` — the checkbox keeps the P3
  semantics (loads the previous message, pushed-HEAD guard); the `▾` lists recent commits so
  their message can be reused; the 🕘 clock opens the 50-entry **message history** dropdown
  (first line + relative time) in place.
* Soft subject hint: a right-aligned counter past 72 characters; never blocks.
* **Generate Commit Message**: the ✨ in the box's top right corner, or *Geet: Generate
  Commit Message* in the palette. IntelliJ's *Generate Commit Message with AI Assistant*: a
  language model writes the message for what **Commit** would commit
  ([D48](docs/deviations.md#d48--generate-commit-message-uses-a-model-vs-code-has)).
  - *What it describes:* the ticked changes of the repositories the list shows (with the
    staging area, the staged ones); a file committed in part, as that part; with **Amend**,
    the last commit's own changes and message as well, since the new message is the message
    of both.
  - *Which model:* one VS Code has: GitHub Copilot's once you are signed in, or any added
    under *Chat: Manage Language Models*. With several, Geet asks the first time and keeps
    the answer in `geet.commit.messageGeneration.model`; *Geet: Choose the Model for
    Commit Messages…* changes it. VS Code asks your consent the first time Geet uses
    Copilot's models. With no model, Geet says what gives VS Code one.
  - *What is sent, and only on your click:* the diffs of those changes, the repository's name
    and branch, and the subjects of its last ten commits, whose style the message follows. A
    large diff is cut short; a binary file is only named.
  - *While it writes:* the ✨ is a ⏹ that stops it, and the view shows progress. The message
    then replaces what the box held, and **Ctrl+Z** brings that back.
  - *Your own instructions:* `geet.commit.messageGeneration.instructions` (a format, a
    language, a length), where `$GIT_BRANCH_NAME` stands for the current branch, as in IntelliJ.
  - *Off:* `geet.commit.messageGeneration.enabled`, or VS Code's own
    `chat.disableAIFeatures`, takes the button and the command away.

### Commit options gear popup (shape)

The `⚙` beside the action buttons opens the §2A popup inside the window:

* **Git** — `Author:` field (`Name <email>`, completion from recent authors, validated,
  `×` to clear; lands as `--author=`) · `[ ] Sign-off commit` (`-s`).
* **Commit Checks** — `Reformat code` (modified lines only) · `Optimize imports` ·
  `Cleanup` + `Choose profile` (the code-action kind it applies).
* **Advanced Commit Checks** — `Analyze code` + severity picker · `Check TODO` + pattern ·
  `[ ] Run advanced checks after a commit is done` with the caption *"Failed checks will not
  prevent a commit"*. Ticked, Analyze/TODO run **after** the commit and report via
  notification. Unticked, the default, they run **before** it, and a finding asks *Review…*,
  *Commit Anyway* or *Cancel*.
* Every check starts **unticked**, Analyze code and Check TODO included, which IntelliJ ticks,
  and so does *Run advanced checks after a commit is done*, which IntelliJ ticks too
  ([D38](docs/deviations.md#d38--every-commit-check-starts-unticked)): a commit runs no check
  until you tick one, and a check you tick runs before the commit.

### Shelf (shape + behaviour)

* The **Shelf tab** lists entries (name · relative time · `N files` · origin branch)
  expanding to their files; toolbar: Unshelve… · Unshelve Silently · Unshelve Files… ·
  Rename… · Delete · Import Patch… · Show-already-unshelved eye toggle. Context menus are
  native per row (entry and file). Damaged entries (sha256 mismatch) render inline with a
  warning and refuse to unshelve. Applied-but-kept entries grey out behind the eye toggle.
* **Shelve Changes dialog** (`geet.shelve.dialog`, also the toolbar's Shelve button):
  toolbar → `Changelist: ▾` selector → checkbox tree → `N modified` → message → collapsible
  `∨ Diff` section with **per-change include checkboxes** → `[Shelve Changes] [Cancel]`, plus
  `[x] Remove shelved changes from the worktree`. Shelving selected changes stores exactly
  them and leaves the residue in the worktree byte-identically.

### Commit Actions

* `[Commit]` `[Commit and Push…]` in the bottom block; amend alone commits without a new
  message; GPG sign toggle (`-S`) kept from P3.
* **`Commit and Push…` opens the Push dialog** once its commits have landed — IntelliJ's
  *Show Push dialog for Commit and Push*, on by default (`geet.push.showDialogForCommitAndPush`)
  — for exactly the repositories it committed: one dialog when the commit spans several, and
  nothing pushed until you press Push. The commit window does not wait on the dialog, so it is
  ready for the next commit while the dialog is open. Off — or with the Push dialog off
  altogether (`geet.push.showDialog`, POST-P14cn) — it pushes straight away what the dialog
  would have pushed, publishing a branch that tracks nothing, through the same Push Rejected
  handling as every push.
* **Multi-root commit (IntelliJ's behaviour):** the tree spans every repository, so `Commit`
  commits *every* repository that has something ticked — one message, one commit each, run in
  order and stopped at the first refusal with a report of what already landed. The button says
  what it will do (`Commit to 3 repositories`, or `Commit to repoA`), sourced from the same
  predicate the commit path uses so the label cannot promise a repository the flow skips.
* **Amend stays single-repository** — it rewrites only the repository the message box is bound
  to. With changes ticked elsewhere it asks first, naming what will and will not be committed,
  rather than silently narrowing the gesture.
* Invoking `geet.commit` **with** an explicit repository (a context menu) stays scoped to it.

---

## 4. Git Log & History (Git Tool Window)

Like §3, every item here carries its **shape criterion** — which container, which pane,
which toolbar — because the pre-P12 audit passed on behaviours while the product was a
single-pane list. Reference layout: `docs/intellij-gap-analysis.md` §2A ("Git tool window —
docked bottom, tabs `Log | Console`").

### The window itself (shape)

* **One bottom-docked tool window**, IntelliJ's Git tool window, titled **Geet** after the
  extension: webview view `geet.log` in the `geet-panel` panel container, holding tabs
  **`Log | Console | Worktrees`** (active tab persisted),
  simultaneously visible with the left-docked Commit window and the editor.
  `geet.log.focus` (`alt+9` with the IntelliJ keymap on) focuses it on the last active tab.
* **More than one Log tab, as IntelliJ's `Open Another Log Tab`.** A **`+`** right after the
  last tab opens a new Log tab matching the current tab's filters, appended after the others.
  Each tab has its own filters, repository, selection, scroll and pane layout (a new tab
  starts with the Branches pane folded to its strip). A tab is **titled by what it shows**,
  by IntelliJ's own rule: `Log` unfiltered; one filter reads as its value (`Log: 2026.1`,
  `Log: --no-merges`); several each take IntelliJ's prefix, joined by spaces
  (`Log: on main by Ava made since 2026-10-01 --no-merges`); `History: store.ts` for a
  file's history. The sort and First Parent never show. The full title is the hover. With
  several repositories, two tabs that would read the same while showing different ones each
  name theirs, in IntelliJ's words for a root filter (`Log: on main in api` beside `Log: on
  main in web`), as VS Code's editor tabs add a folder only to two files of one name; the
  hover always names it. Extra tabs close
  with their **`×`**, a middle-click, or the tab menu (right-click): **Close Tab · Close Other
  Tabs · Close All Tabs**. The first Log tab never closes, and Console and Worktrees stay too
  (**D33**). Closing the tab in front brings its left neighbour forward.
* **Commands that used to overwrite your filter open a tab of their own:** File History
  (`History: <file>`), Compare with Current, the Repositories panel's **Show in New Log Tab**
  (`Log: <branch>`) and an update's `Show in Log`. A tab already
  showing exactly that (the sort aside) is brought forward instead, so running File History
  on one file twice lands on one tab. Navigation stays in the tab in front: blame's
  Show in Log, Go to Hash/Branch/Tag, Go to Parent/Child.
* **Cheap to keep open.** Only the tab in front re-pages when history moves; the others
  re-page when brought forward. Tabs are restored after a restart, lazily: a restored tab
  runs no `git` until it is first shown, and a tab already seen keeps its place when another
  is in front.
* **Log tab = filter row + four synchronized panes** in nested splitters:
  `[Branches | Commits] | [Changed Files / Commit Details]` — the right column splits
  vertically. Every splitter ratio persists; double-click resets. Each pane has a header row
  (chevron · name · per-pane toolbar); panes collapse to slim bars keeping their state — the
  Commits pane, the window's centre, deliberately never collapses. `Tab`/`Shift+Tab` cycle
  the pane headers with a visible focus ring; panes carry aria names.
* **One selection model, host-side:** the graph's multi-select is mirrored to the host and
  drives Changed Files, Commit Details, and every selection-scoped menu action from a single
  list — no pane keeps its own copy.
* **Selecting several commits, as IntelliJ's log table does:** **Ctrl+click** (⌘ on macOS)
  adds or removes a commit; **Shift+click** selects the run from the anchor; **Ctrl+Shift+click**
  adds a run; **Shift+↑/↓/PageUp/PageDown/Home/End** grow or shrink the run; **Ctrl+A** selects
  every loaded commit. Every selected row is highlighted; a row Ctrl+click took out keeps only
  its focus outline. **Right-click** outside the selection selects that commit; inside it, the
  menu acts on the whole selection. The selection is always kept newest first, whatever order
  it was clicked in.

### The Branches pane (shape)

* Sections `HEAD (Current)` → `Local` (favorites ★ flat-first, then **folder nodes** —
  `feature/f1`, `f1-1`, `f2` collapse under one `feature` row) → `Remote` per remote →
  `Tags`, with a **vertical icon rail** on the pane's left edge: new branch · delete ·
  compare-with-current · search · favorites-only · show-my-commits · **Branches Pane
  Settings** (gear) · collapse.
* **Branches Pane Settings** holds **Show Tags** (`geet.branches.showTags`, on): off,
  the `Tags` node is gone. As in IntelliJ it is one setting for every branch list, so the
  Branches popup, the sidebar's Branches panel (its Tags tab) and the branch trees drop
  their tags with it; the `Branch ▾`
  filter keeps offering them. IntelliJ's menu also has the single-click action and
  `Group By Directory`; Geet lists neither (a click always filters; branches always
  group by directory).
* **Selecting a ref filters the Commits pane** through the filter model (Ctrl adds;
  `HEAD (Current)` restores). Branch rows have a native context menu (checkout, new from,
  compare, diff with working tree, rebase onto current, push, rename, delete, favorite)
  backed by the same action registry the Branches popup uses (§2), so surfaces cannot drift.

### The graph and its filters

* Color-coded topological graph, canvas-drawn, **virtualized to 60 fps at 100k commits**
  (§13 budgets re-validated with all four panes mounted — see `docs/perf.md`).
* **IntelliJ's columns, no header row:** the message column (the graph drawn at its left,
  the ref labels at its right end) takes what **Author** and **Date** leave; **Hash** (eight
  characters) joins them from `Presentation Settings ▸ Columns`. Author fits its widest name
  over the first thousand rows (at most 300 px), Date and Hash are sized by a sample, so
  every row lines up. **Author** shows IntelliJ's **`*`** when someone other than the
  author committed the change (a rebase, a cherry-pick), comparing names as IntelliJ does
  (`Ben Okafor` = `ben.okafor`); a commit with no author name shows its email's local part.
  **Date** reads `2026/09/05 15:07` by default — year first, two digits each, a 24-hour
  clock, the same in every language (owner's choice;
  [D40](docs/deviations.md#d40--the-date-column-writes-yyyymmdd-hhmm)).
  **`Presentation Settings ▸ Date Format`** (Geet's own row,
  [D47](docs/deviations.md#d47--date-format-is-in-the-logs-eye-menu)) offers three choices,
  each with a sample of today at 14:19:
  - **Year First**: the default above.
  - **IntelliJ**: IntelliJ's log as it ships (`formatPrettyDateTime`). *Moments ago*,
    *A minute ago*, *5 minutes ago* and *1 hour ago* up to an hour and a minute; then
    *Today 2:19 PM* and *Yesterday 2:19 PM*; older commits in the system's short date and
    time. Minutes are rounded as Java's `Math.rint` rounds them. The rows are redrawn every
    half minute while on show, and the column is sized by its rows as IntelliJ sizes it.
  - **System**: the system's short date and time for every commit, as IntelliJ writes them
    with its pretty formatting off.

  On Windows the "system" is the Region settings' short date and time, read from
  `HKCU\Control Panel\International` once per session and turned into Java's pattern
  letters as IntelliJ's `fixWindowsFormat` does (`M/d/yyyy`, `h:mm a`); elsewhere it is VS
  Code's display language. Commit Details always writes the date and time in full, as
  IntelliJ's does. The choice is `geet.log.dateFormat` (`YYYY/MM/DD HH:mm`, `pretty`,
  `locale`).
  **Drag a column's left border** to resize it (the width is kept per tab, across reloads);
  **double-click** the border to fit the column to its content again. Columns give way
  together rather than squeeze the message under the graph plus 80 px.
* **Ref labels as IntelliJ draws them:** a tag icon holding one colour per kind of ref —
  HEAD yellow, local branches green, remote branches purple, tags grey; a kind held more
  than once shows twice; the top one dotted — then the name in grey, one pixel smaller than
  the row. Grouped by IntelliJ's own rules (`GitRefManager.groupForTable`): HEAD joins the
  first label's icon; a branch and the remote branch it tracks are one label
  (`origin & main`); order is current branch, `main`/`master`, `origin/main`, other
  locals, other remotes, tags. A detached HEAD is a **Detached HEAD** label with a warning
  icon. Labels get IntelliJ's width budget and, when they do not fit, fold into one last
  icon; names past 22 characters are shortened (`../feature/…`). Hovering a label opens a
  card naming its refs (for Detached HEAD, IntelliJ's warning) in place of the
  commit-message card. Ref types come from `git log --decorate=full`, so a local
  `feature/x` is no longer taken for a remote branch, and `refs/stash` and a remote's `HEAD`
  pointer get no label.
* **Filter row, §2A order:** `Branch or tag` combo (datalist over every ref) · `Text or hash`
  with `.*` regex and `Cc` match-case toggles (a hash navigates instead of grepping) · four
  **multi-select dropdowns with search**: `Branch ▾`, `User ▾` (`Me` + author
  autocomplete), `Date ▾` (presets + from/until), `Paths ▾` (see below). In `Branch ▾`,
  **`HEAD (Current)` and `All branches` are radio buttons** in a block of their own above
  the list, ruled off from it and not scrolled away with it: each is the whole Branch
  filter on its own, never one of several ticked. Below them, the refs are checkboxes,
  favorites first. Filters intersect. **Saved presets** live in the toolbar's Saved filters
  menu (`geet.log.filterPresets`).
* **Compact filter chips** (the default,
  [D39](docs/deviations.md#d39--the-filter-dropdowns-are-compact)): the four dropdowns are
  small, with the `×` inside, and say what they filter in a few words — a user without the
  e-mail (`me` for you, as IntelliJ says), a date as `Since 2026/10/31` or `Until …`, a path
  by its last part, several values joined with `|`, and anything over IntelliJ's own 20
  characters cut with `…`. Hovering a chip shows its whole value. `geet.log.filterChips:
  full` brings back the larger chips with every value written out.
* **An empty log says why:** IntelliJ's *No commits matching filters*, its **Reset
  filters** link, and — when the Branch selection names something this repository does not
  have — which names those are.
* **Graph Options ▾**, IntelliJ's button after `Paths ▾` (an arrow beside three rows), in
  place of the old sort dropdown. **Sort:** **By Commit Date** (the default, git's date
  order) or **Topologically** (IntelliSort: a merge's incoming commits directly below it;
  a tab already in git's plain topological order, as File History opens, ticks it too).
  **Options:** **First Parent** follows only each merge's first parent and, as in IntelliJ,
  takes the sort's place (no sort is ticked; picking one ends it, unticking it brings the
  sort back); **No Merges** hides merge commits and adds `--no-merges` to the tab's title.
  Geet hides those merges itself rather than through git, so the line from a merge's
  child runs on into its first parent instead of dangling, and the merged branch shows as a
  tip. A dot on the button marks anything but By Commit Date with no option ticked. Each tab
  keeps its own; Reset all filters keeps the sort and First Parent and drops No Merges.
* Right toolbar: refresh · **Presentation Settings** (eye) · **Go to Hash/Branch/Tag** ·
  Show Details (folds the right column) · Highlight my commits.
* **Presentation Settings ▾ · Show**, IntelliJ's rows in IntelliJ's order and defaults, all
  IDE-wide settings, after one of Geet's own:
  - **Graph** (`geet.log.showGraph`, on): the coloured lanes and commit dots. Off, the
    rows are the message, its labels and the columns alone, the message at the row's edge.
  - **Compact References View** (`geet.log.compactReferences`, on): all of a commit's
    refs in one label, named after the first; off, each branch is its own label and the tags
    share one.
  - **Tag Names** (`geet.log.showTagNames`, off): a label of tags alone carries the first
    tag's name; off, it is the tag icon without a name.
  - **References on the Left** (`geet.log.referencesOnLeft`, off): labels before the
    message instead of at its end.
  - **Columns ▸ Author · Hash · Date** (`geet.log.columns.author` / `.hash` / `.date`;
    Hash off).

  A change, from the menu or the Settings editor, redraws the rows in place: no re-page, the
  selection and scroll kept. IntelliJ's Root Names, Long Edges and Commit Timestamp rows and
  its `Highlight` group are not in the menu; *Highlight my commits* is the toolbar toggle
  above.
* **The graph also refreshes itself.** Any history change — a commit, amend, checkout,
  merge, rebase, reset or pull, from Geet, the built-in Git extension or a terminal —
  re-pages the graph without the button. *Shape:* the rows rebuild in place and the list
  comes back as IntelliJ's does: **scrolled to the top, it stays at the top**, so a commit
  just made is the first row on screen; scrolled down, the first selected row on screen (or
  else the row at the top edge) stays where it was, to the pixel. The selection stays with
  its Changed Files and Commit Details panes, and no frame shows the rows shifted on the way.
  Coalesced across a burst (a rebase moves refs once per step) and deferred entirely while
  the panel is hidden, so a closed log costs no git. A dirty worktree alone never re-pages it.
  A change made outside Geet reaches the log within about a second even while something
  keeps writing files in the workspace (a dev server's log, a test run), and one made right
  after a Geet operation is not mistaken for that operation's own.

### `Paths ▾` and the repository on show

* **`Select…`** opens the file/folder chooser; **`Select in Tree…`** ticks paths out of the
  repository's own tracked tree (tree order and depth, searchable). Both *add* to the
  selection, as typing into the panel's `path or glob` box always did. A very large
  repository offers folders only rather than truncating the alphabet — the title says so.
  Anything the chooser could not show — a glob, a withheld file — survives the pick untouched.
* **`Roots`** lists every repository in the workspace, each with its graph-palette swatch.
  "In the workspace" means found by the same search VS Code's built-in git performs: each
  open folder, the repository enclosing it, **and the repositories below it** —
  `geet.repositoryScan.maxDepth` levels down, default one, skipping
  `geet.repositoryScan.ignoredFolders`. Opening a plain directory of checkouts therefore
  lists exactly what opening each checkout as its own folder would, and a repository cloned
  or `init`-ed afterwards joins the list without a reload.
  The log renders **one repository at a time**, so the rows are radios: picking one moves the
  log there. The panel title carries the name of the repository on show, and the list
  follows folders joining or leaving the workspace without disturbing the rows on screen.
* **Which repository the log shows is a decision, not a guess.** The focused editor seeds it
  the first time and nothing else moves it afterwards except an explicit act: a `Roots` row,
  or a command that names its repository (`Show File History`, `Compare with Current`,
  `Show in Log` from blame or the rebase editor). The choice survives a restart. Picking a
  root drops the paths, which belong to one repository, and keeps the rest of the filter —
  **the Branch selection included**, as IntelliJ's filters stay when its roots change —
  author, date, text, sort. A branch the repository on show does not have is left out of the
  read (git would refuse the whole log over it); it stays ticked in `Branch ▾`, first in the
  list and marked *not in this repository*, and when nothing selected is left the log is
  empty and names what is missing. `Branch ▾` and the Branches pane then list the new
  repository's own branches.
* **Switching Log tabs moves nothing.** Every tab's panes are laid out in the same box,
  behind or in front, so bringing one forward changes only which is seen — no pane resizes
  on screen, no second scrollbar appears. The commit list shrinks with its pane as well as
  growing with it.

### Changed Files & Commit Details panes (shape)

* **Changed Files:** repo row (`repo · N files · path`) → folder rows with counts →
  status-colored files with rename pairs; tree/flat toggle, preview-on-click, multi-diff,
  Show History for Revision. **Several selected commits show the combined changes of those
  commits**, as IntelliJ does (`zipChanges`): only the files they touched — a commit between
  them that was not selected adds nothing — each file once, its diff running from before the
  earliest selected commit that touched it to after the latest; a file renamed along the way is
  one row from its first name to its last, and one added and deleted inside the selection drops
  out. The multi-diff opens the same set. The first 1 000 commits count (IntelliJ's
  `MAX_SELECTED_COMMITS`); their files are read in one `git log`. Population is lazy —
  selection pushes ids, each pane fetches its own data.
* **Commit Details:** subject → `<hash> <author>` (+ copy actions) → `<email> on <date> at
  <time>` → typed ref chips → committer-when-different → **GPG signature state** → clickable
  parent links → lazy `Contained in branches: Show all`. Body URLs and issue keys
  (`geet.log.issuePattern`/`issueUrl`) are linkified. **Several selected commits stack**,
  one block each with a rule between, the first 50, then `(showing 50 of N selected commits)`.

### The Console tab (shape)

* A read-only structured mirror of **every git command the extension runs**: one collapsible
  row per run — time · `git argv` · exit code · duration · output head — failures
  pre-expanded and colored; filter box; Copy command / Copy output; Clear. The ring holds
  `geet.log.console.limit` entries (default 2 000) and is **redacted before storage**
  (URL userinfo, askpass values, `--author` identities). No re-run affordance — deliberate
  (deviation D10).

### Commit context menu (complete)

Right-clicking commits in the graph (native menu), **in IntelliJ's order and grouping**:
Copy Revision Number · Create Patch… · Cherry-Pick | Checkout Revision · Show Repository at
Revision | Compare Versions · Compare with Local | Reset Current Branch to Here… · Revert Commit
· Undo Commit | Edit Commit Message… · Fixup… · Squash Into… · Drop Commit · Interactively
Rebase from Here… · Push All up to Here | Branches… · New Branch… · New Tag… | Go to Child /
Parent Commit | Open on Remote.

**With several commits selected** the menu follows IntelliJ's rules: what applies to all of
them runs on all of them — **Copy Revision Number** (the hashes on one line, spaced), **Create
Patch…**, **Cherry-Pick**, **Revert Commits**, **Drop Commits**, **Squash Commits…**, and
**Compare Versions** with exactly two; IntelliJ's single-commit actions it hides are hidden
(Checkout, Compare with Local, Undo, Edit Commit Message, Fixup, Squash Into, Interactively
Rebase, Branches); and the ones it greys out are greyed (Show Repository at Revision, Reset,
Push All up to Here, New Branch…, New Tag…, Go to Child/Parent). A selection holding a merge
greys Revert, Drop and Squash Commits.

* **Drop Commits** removes the selected commits, adjacent or not, and replays the rest; an
  unbroken run is dropped with one `rebase --onto`. **Squash Commits…** folds the selected
  commits into the oldest of them, moving the later ones up behind it, with a message edited
  from all of theirs (IntelliJ's starting text: each message once, three newlines apart, a
  `fixup!`/`squash!` of a selected commit giving only its body) in the Accept/Cancel commit
  editor. Both check IntelliJ's conditions — every commit on the current branch, no merge
  between the oldest and HEAD, not the initial commit — say which one failed, confirm before
  rewriting commits already on the upstream (Geet's published guard, where IntelliJ refuses
  a protected branch), and offer **Undo** afterwards. As in IntelliJ, Undo works while HEAD is
  still where the edit left it and its commits are not on a protected remote branch; it moves
  the branch back with `git reset --keep`, so every local change stays, and refuses rather
  than overwrite one. Staged changes stay staged through the edit and its Undo, and through
  Edit Commit Message, Fixup, Interactive Rebase and Smart Checkout too.
* **Compare Versions** (two commits) opens every file that differs between them, lower to
  upper, kept to the log's path filter, in one multi-diff.

* **Interactive Rebase** (P5's bespoke editor: drag-and-drop reorder, Pick/Squash/Reword/
  Fixup/Drop per row, force-push acknowledgement on published ranges, pause/continue monitor).
* **Undo Commit** · **Revert Commit** · **Cherry-Pick** · **Drop Commit** · **Reword**.
* **Create Patch…** (`format-patch`-faithful, binary-safe) and **Apply Patch…**
  (`git am -3` for mailboxes with degrade-to-`apply --3way`; conflicts land in the §5 flow).
* **Fixup… / Squash Into…** — commits the ticked changes as `fixup!`/`squash!`, then offers
  a non-interactive `--autosquash` fold.
* **Push All up to Here…** (the Push dialog with that commit as the source) · **Reset Here**
  (Soft/Mixed/Hard/**Keep**, destructive modes snapshot first) · **Checkout Revision** ·
  **New Branch/Tag here** · **Compare with Local** · **Branches ›** (lazy `--contains`) ·
  **Go to Parent / Child** · **Show Repository at Revision** (read-only `geet-tree:`
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
  merge). It fires **once per conflicted stop**, as IntelliJ's does: the operation's first,
  and each later one (a rebase's next step, a cherry-pick's next commit). It is the one
  notice: no toast repeats it. It can be switched off (`geet.merge.conflictsDialog`);
  a toast then takes its place. **Resolve…** on the operation banner brings it back.
* **A merge commits from the Commit window** once nothing is left unresolved: HEAD plus what
  is ticked, as IntelliJ commits a merge. Unticked changes of the merging repository are
  asked about first (*Are you sure you want to exclude these changed files from merge
  commit?* · **Commit Anyway**). While a conflict is left nothing commits: *Cannot commit
  changes due to unresolved conflicts.*
* The **`geet.conflicts` tree view remains** the persistent surface for ongoing work —
  IntelliJ gates on the modal and keeps a view; so does Geet.

### The tri-editor (shape)

* Clicking `Merge…` opens **three real VS Code editors**: Left "Yours" (`:2`, read-only),
  **Center "Result"** (writable `geet-merge:` document), Right "Theirs" (`:3`, read-only).
* **Deviation, and a win:** the centre pane is a real editor, so autocomplete, diagnostics and
  formatting all work while resolving. A webview merge view would lose them (D14).

### Toolbar (shape)

* **`Apply non-conflicting changes:` Left · All · Right** — three actions, not one. On the
  Result pane's toolbar, in IntelliJ's order: **Apply** ✓, the three applies (→ from the
  left, ⟷ from both, ← from the right), the one magic wand, **Abort** ↺. Every icon is used
  once.
* **Live counter** in IntelliJ's wording: `No changes. 2 conflicts.` / `3 changes, 1 conflict.`
  / `All changes applied.`, shown in the status bar beside the resolved/total and file position.
* **Per-side `Show Details`** — the revision behind each pane: short sha · author · date ·
  subject.
* **`Accept Yours` / `Accept Theirs`** as explicit whole-file verbs, distinct from the
  non-conflicting applies. They are in the toolbar's `…` menu, beside their all-files
  forms. IntelliJ has them as Accept Left and Accept Right buttons, not toolbar icons.
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
  IntelliJ keeps it — one row per entry (`stash@{N} · message`, its age within the day and
  its date after it, written as the log writes dates, origin branch),
  expanding to its files, each opening a real diff against the working tree. Files are read on
  expand, because `git stash show` costs a run per stash. Actions carry the stash **sha**, not
  `stash@{N}`, so a row acted on after the list shifted cannot hit a different stash.
  `geet.stash.combineWithShelf` is IntelliJ's *Combine stashes and shelves in one tab*
  (off by default, as there): on, the third tab folds into the Shelf tab. The
  `geet.stashes` tree view survives behind `geet.sidebar.extraViews` (off by default, D26).
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
* **Shape:** a **`Shelf` tab in the commit tool window** plus the `geet.shelf` tree, and the
  `Shelve Changes` dialog (toolbar → changelist selector → checkbox file tree → `N modified` →
  message → collapsible `∨ Diff` with per-change include checkboxes → `[Shelve Changes]`).
* **Behaviour:** partial shelving down to individual changes; export/import as `.patch`;
  unshelve with or without removing the shelf.

---

## 7. Deep Provider Integrations (GitHub / GitLab)

**Not implemented, by owner decision — this is a standing project constraint, not a gap.**
Geet performs no remote-account actions of any kind: no sign-in, no pull-request tool
window, no in-IDE review, no CI status. Phase 8 was skipped deliberately. `Clone…` accepts a
URL and does not enumerate a provider's repositories. Registered as D11.

---

## 8. The Failsafe: Local History

* **Shape:** `Show Local History` opens the `geet.localHistory` view **on demand**, the
  way IntelliJ's `Show History` opens its own window — the view is not contributed at all
  until either `geet.sidebar.extraViews` is on or the command arms its context key, rather than standing open
  as a sidebar section (D26). Snapshots are grouped by day, each expanding to the
  files it holds, with `Show Diff`, `Restore` and `Restore Selected Files…`.
* **Behaviour:** a snapshot is taken **before every destructive operation** (checkout on a
  dirty tree, reset, rebase, merge, cherry-pick, revert, stash pop/apply/drop/clear, unshelve,
  rollback, clean, force branch delete, smart checkout), plus optional save- and task-end
  snapshots. Restores are byte-exact, including CRLF and missing final newlines, and take a
  paranoia snapshot first so a restore is itself undoable. A file of the dirty set that was
  deleted is recorded as deleted (its row says so), and restoring the snapshot deletes it
  again: the state before a `reset --hard` comes back whole, not just its edits.
* **Recovery:** dangling-commit recovery from the reflog for the cases a snapshot cannot cover
  (a bad `reset --hard` of committed work).
* **Deviation:** a bespoke store rather than VS Code's Timeline — `TimelineProvider` is a
  proposed API and cannot ship in a published extension (D12).

---

## 9. Dialogs, Popups and the Action Hub

IntelliJ drives its Git operations through **option-bearing dialogs**; before P13 Geet stood
25 of them up as QuickPick/InputBox chains that hid every real flag.

* **Shape shared by all of them:** a focus-trapped editor-area panel (D2) with a title row, a
  scrollable body, and a footer carrying `?` on the left and the actions on the right. Where
  IntelliJ shows *Modify options*, Geet shows the same: a compact primary form plus a
  dropdown of the actual git flags, each ticked option revealing its control — and un-ticking
  one **turns the flag off**, so a flag the user cannot see never survives into the command.
  Contradictory combinations are reported **with reasons** and disable the action.
* **Every dialog shows the exact command it will run** in a dim `will run:` line, built by the
  same argv function the host executes (`geet.dialogs.showCommandLine`).
* **Update Project is the exception** (D30): a native modal message box, not an editor-tab
  panel — `[Merge] [Rebase] [Reset to the Remote Branch] [Cancel]`, the last answer first so
  `Enter` repeats it, the branch, its upstream and each button's commands in the text. Its
  `Don't show again` is `Don't Ask Again` on the result notification, after which `Ctrl+T`
  runs directly. **It never refuses because you are mid-work**: uncommitted changes are set
  aside around the merge or rebase and put back (git's `--autostash`; files added to VCS
  survive as added; staged content is left alone rather than unstaged), and a conflict putting
  them back is a warning plus a `stash-pop` conflict session (D31). **It updates the project**:
  with no repository named — `Ctrl+T`, the popup's verb, the Operations Popup — it **fetches
  every repository first**, together, then asks one question that says what each will pull:
  `api: main ← origin/main · 3 to pull · 1 to push`, `web: … · up to date`, `docs: couldn't
  fetch from origin — Could not resolve host: github.com`. With nothing to pull anywhere it asks
  nothing and says so. Then each repository with something to pull is merged or rebased in
  turn, and **one that stops on conflicts or fails does not stop the others**. One notification
  says what became of every repository, problems first — *api: the merge stopped on conflicts
  in src/app.ts. Updated web and docs: 5 commits, 9 files changed. Skipped tools (no upstream
  branch).* — with **Show Conflicts**, and **Show Details** (the Console) when something
  failed. A repository it cannot update (detached, no upstream, a merge or rebase in progress)
  is skipped and named, and `Reset` is offered only when a single repository is in play. A
  repository's own **Update Repository…** (its menu, in the Repositories panel and the
  Repositories (Tree) view, and its row's `↓`) updates just that one, fetched first the same
  way. **The question says what it updates** (POST-P14bx): *Update Project* for the project,
  *Update api* for one repository's own, *Update 2 Repositories* for the Repositories panel's
  `⋯` with two picked (the Branches panel's until POST-P14cq); its progress, a failure and a
  cancelled run say the same. With one repository in the workspace, every update is *Update
  Project*.
* **Update Project Without Fetching…** (Geet's own, no IntelliJ counterpart) is the same
  update without the fetch: each repository is merged or rebased onto its remote branch as it
  was **last fetched** — instant, and it works offline. It sits right under every update: the
  Repositories panel's `⋯`, or with one repository the Branches panel's (following what is in
  view, as its update does), each repository's
  menu (panel and sidebar, as **Update Repository Without Fetching…**), the Branches popup,
  the VCS Operations popup and the Command Palette; it has no key, but one can be bound to
  `geet.update.withoutFetch`. The question is titled *Update Project Without Fetching*
  (*Update api Without Fetching* for one repository's own),
  opens with *Nothing is fetched first…*, and each line says how old its data is — `api: main ←
  origin/main · 3 to pull · fetched 2 hours ago`, the age read from `FETCH_HEAD`, which every
  `git fetch` rewrites, whoever ran it. A repository whose upstream was never fetched is
  skipped (*origin/x not fetched yet*). The summary never claims plain *up to date*: *web is
  already up to date with what was last fetched*, and one repository says *Already up to date
  with origin/main, as fetched 2 hours ago.* **When Update Project's fetch fails** — offline, a
  VPN down — the failure offers **Update Without Fetching** for the repositories it could not
  fetch, when they have fetched their upstream before.
* **A rejected push asks, updates, and pushes again** (IntelliJ's *Push Rejected*, D32). When
  the remote has commits the branch does not, the push is not left as an error: a warning box —
  *Push of the current branch "X" was rejected. Remote changes need to be merged before
  pushing.* — offers `[Merge] [Rebase] [Cancel]`, the last answer (shared with Update Project)
  first. The answer runs Update Project's update, local changes set aside and all, then the
  same push again; the result reads *Pushed 2 commits to origin/X*. It covers every push of the
  checked-out branch to the branch it tracks — the Push dialog, **Commit and Push**, Sync and a
  branch's `Push…`; any other rejected push is reported with the remote's reason. An update that
  stops on conflicts cancels the push and leaves the merge to finish; unpushed merge commits of
  your own get IntelliJ's *merge is highly recommended* and `Rebase Anyway`. `Don't Ask Again`
  on the result turns on `geet.push.autoUpdateIfRejected` (*Auto-update if push of the
  current branch was rejected*), and `Show Details` opens the Console tab. Every push now
  reports in IntelliJ's words — *Pushed 1 commit to origin/X*, *Push to origin/X was rejected*.
  In a workspace with several repositories the update covers **every repository that tracks a
  remote branch**, as IntelliJ's *Update all repositories* does (`geet.push.updateAllRepositoriesIfRejected`,
  on by default); the question names them, and nothing is pushed again unless every update went
  through.
* **Push, as IntelliJ's dialog** (`VcsPushDialog`), and **every Push opens it**: `Push…`
  (`Ctrl+Shift+K`, the popup's verb, a Repositories row), a branch's `Push…` (that branch;
  a branch common to several repositories opens one dialog for all of them), the log's
  `Push All up to Here…` (that commit and everything before it, from the branch it is on) and
  `Commit and Push…`. Nothing is pushed until you press Push.
  - **Or none of them does** (POST-P14cn, D49): `Don't show this dialog again` in its footer
    (`geet.push.showDialog`) makes every one of those push straight away what the dialog
    would have pushed had Push been pressed the moment it opened: the repositories it would
    tick, each to the target it would show, tags as last chosen, hooks run. A branch that tracks
    nothing is published (a new branch of its name, tracked from then on). A rejected push still
    asks Merge or Rebase, and the report is the same. The dialog still opens when a push cannot
    go ahead without it, with *Shown because …* at its top: a repository with no remote or no
    commits, a commit on no branch, several repositories and nothing to say which. There the box
    is ticked; untick it and push to have the dialog back. It is kept on Push and Force Push,
    never on Cancel.
  - **Left, the push log:** a row per repository, `feature → origin : feature`, the source
    plain and the remote and branch as links, a green **`New`** when the remote has no such
    branch yet. Under it the outgoing commits, subject only, twenty at first and a `...` that
    doubles them; the tooltip is IntelliJ's `hash  date  by author`, the message, and
    *Select to show commit details*. The default target is IntelliJ's: the remote's push spec
    (Gerrit's `HEAD:refs/for/master` included), else the branch's upstream, else a branch of
    its own name on `origin` (or the first remote). The commits are `<remote>/<branch>..<source>`,
    or for a new branch whatever that remote has nowhere.
  - **Several repositories:** every repository is listed, each with a checkbox. The one asked
    for is checked (a Repositories row, the repositories Commit and Push committed), or else
    the one you are in. Checked rows are open and the others closed and faded. `Space`
    toggles the selected rows; the title is *Push Commits* rather than *Push Commits to X*.
  - **Changing the target:** click the branch (or `F2`) to type another. The field suggests
    the branches you recently pushed this one to (`recently pushed`), then every remote
    branch, `origin`'s first. Spaces become `_` and characters git refuses vanish as you
    type; `Enter` applies, `Escape` cancels, and Push waits while you edit. Click the remote
    for the list of remotes and `Define remote`. `Set upstream`, beside the field when the
    target is not the upstream already, makes it the branch's upstream (`Upstream`,
    `New & Upstream` labels). `Edit all targets` (`Alt+F2`) types one target for every
    repository at once.
  - **No remote:** the row reads `main → Define remote`; IntelliJ's Define Remote (Name
    `origin`, URL, `Fetch remote`) checks the URL with `git ls-remote` before adding it, and
    says why it refused. An empty repository reads `Empty repository` in red.
  - **Right, the changes of what is selected:** the repository row means all its commits;
    one or several commits (Ctrl/Shift+click) mean exactly theirs, merged as the log merges
    a selection, each file from before its first change to after its last. IntelliJ's
    toolbar: Show Diff (`Ctrl+D`) · View Options › Group By Directory · Edit Source (`F4`) ·
    Show Details … Expand All · Collapse All. With one commit selected its details sit below.
    The details toggle, grouping and splitters are remembered, as IntelliJ's are.
  - **Footer:** `? · [ ] Push tags: [All | Current Branch]` (remembered) ·
    `[x] Run Git hooks`, shown only when a repository has a pre-push hook and ticked every
    time · `[ ] Don't show this dialog again`. Then `[Push ▾] [Cancel]`, with **Force Push** in
    the split. In a narrow editor the options wrap and the buttons stay in view.
  - **Force Push** (`--force-with-lease`, P5) asks first, in IntelliJ's words: *You're going to
    force push to 'feature'. It may overwrite commits at the remote. Are you sure you want to
    proceed?*, with `Don't warn about this target`. It is not offered for a protected branch.
    The list is `geet.protectedBranches`, `master` and `main` by default, each a regular
    expression matched against the whole name, and the item's tooltip says which branch
    blocked it.
* **The other dialogs:** `Merge` ·
  `Rebase` · `Reset` (four modes including **Keep**, with a live impact line) · `Rollback`
  (checkbox tree + inline diff + `Delete local copies of added files`) · `Cherry-Pick` ·
  `Stash` · `Unstash` · `Apply Patch` (pre-apply summary with missing-file warnings) ·
  `Clone` · `Manage Remotes` · `New Worktree` · `Files Merged with Conflicts`.
* **VCS Operations Popup:** `` Alt+` `` (with the IntelliJ keymap on; the palette's *VCS
  Operations Popup* otherwise) opens every action applicable *right now*, enumerated
  from the dialog and branch-action registries rather than a hand-kept list, with an
  in-progress group first (continue / skip / abort), diff and commit groups when their context
  is present, and recently used actions floated to the top.

---

## 10. Worktrees

* **Shape:** the **`Worktrees` tab of the Git tool window** (`Log | Console | Worktrees`),
  where IntelliJ keeps it — one row per worktree showing its branch (or `detached at <sha>`)
  and its path, a `Locked` or `Prunable` label **only** in those two states, double-click to
  open, and a toolbar of `New Worktree…`, `Remove`, `Lock`/`Unlock`, `Prune`, `Refresh`.
  The `geet.worktrees` tree view survives behind `geet.sidebar.extraViews` (off by default, D26).
* **`New Worktree` dialog:** three branch modes (existing branch · new branch from a start
  point · detach at a revision), a location defaulting to the sibling `../<repo>-<branch>`, and
  `--no-checkout` / `--force` behind Modify options. A new branch follows §2's rule for what it
  tracks, and the command preview spells it out (`--no-track` or `--track`).
* **Behaviour:** removing a **dirty** worktree is refused with git's own reason, `--force`
  being the explicit escape hatch; the main worktree cannot be removed.
* **Deviation:** on git < 2.36 the lock/prunable flags are derived from git's on-disk layout,
  because the porcelain does not report them there (D16).
