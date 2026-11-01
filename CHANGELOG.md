# Changelog

All notable changes to GitTree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the VS Code
pre-release convention (odd minor = pre-release).

## [Unreleased]

### Added — select several commits in the log, as in IntelliJ

The log now selects several commits the way IntelliJ's does:

- **Ctrl+click** (⌘+click on macOS) adds or removes a commit.
- **Shift+click** selects every commit between the last one you clicked and this one.
- **Shift+↑/↓** grows or shrinks that run, and **Ctrl+A** selects every loaded commit.

Every selected commit is highlighted, not just the one you clicked last.

With several commits selected:

- **Changed Files** shows the combined changes of those commits only, each file once,
  from before the first change to after the last. Commits in between that you did not
  select are left out. The multi-diff button opens the same set.
- **Commit Details** shows each commit's details, one under the other, up to 50.
- **The right-click menu** offers what IntelliJ offers: Copy Revision Number, Create
  Patch, Cherry-Pick, **Revert Commits**, **Drop Commits**, **Squash Commits…**, and
  **Compare Versions** when exactly two are selected. Actions that need a single commit
  are greyed out or hidden, as in IntelliJ.

**Squash Commits…** combines the selected commits into one, even when they are not next
to each other, and lets you edit the combined message first. **Drop Commits** removes
the selected commits. Both offer **Undo** afterwards.

### Changed — the commit right-click menu uses IntelliJ's order and names

The menu is now in IntelliJ's order, starting with Copy Revision Number, Create Patch
and Cherry-Pick. Some items were renamed to match: **New Branch…** (was New Branch from
Here…), **New Tag…** (was New Tag Here…) and **Cherry-Pick** (was Cherry-Pick Commit).
Copy Revision Number now puts several hashes on one line, separated by spaces.

### Added — fetch one repository from the Branches section

With more than one repository open, right-click a repository in the sidebar's
**Branches** section and choose **Fetch** to fetch that repository alone. The
header's Fetch button still fetches every repository, as IntelliJ's does. While
the fetch runs, the repository's icon spins.

The same right-click menu has the repository's other actions, the same ones
the Repositories section offers: Update Project, Push, Commit, New Branch,
Checkout Tag or Revision, Stash, Unstash and Manage Remotes. Each one acts on
that repository only. Right-clicking a branch now opens the same menu as its
**›** button, and **Shift+F10** opens the menu from the keyboard.

Fetching a single repository that has no remote now says so, instead of
showing git's "No remote repository specified" error.

### Changed — the commit list has IntelliJ's columns

Each commit row is laid out the way IntelliJ's log is:

- The message, with the graph on its left and the branch and tag labels at its
  right end.
- **Author** and **Date**, each in its own column that lines up down the list.
- **Hash**, if you switch it on from **Presentation Settings › Columns**.
  It is off by default, as in IntelliJ.

Drag a column's left border to resize it, and double-click the border to fit
it again. Each Log tab keeps its own widths.

The Author column adds IntelliJ's **\*** when someone else committed the change,
for example after a rebase or a cherry-pick. Dates use IntelliJ's format:
**9/5/2026 3:07 PM** in US English.

Branch and tag labels look like IntelliJ's: a coloured tag icon and a grey name,
instead of bordered chips. By default a commit's labels are combined into one,
as with IntelliJ's **Compact References View**. **Presentation Settings** now
has **Compact References View**, **Tag Names**, **References on the Left** and
**Columns** (Author, Hash, Date).

Fixed: a local branch with a slash in its name, such as `feature/x`, was
labelled as a remote branch, and `refs/stash` showed as a branch label.

### Added — Graph Options in the log, as IntelliJ's

The log's sort dropdown is now IntelliJ's **Graph Options** button. Its menu has
two groups:

- **Sort:** **By Commit Date** or **Topologically** (IntelliSort).
- **Options:** **First Parent** follows only each merge's first parent, in place
  of the sort. **No Merges** hides merge commits.

A dot on the button shows when anything differs from By Commit Date with no
option ticked. Each Log tab keeps its own Graph Options. With No Merges on, the
graph still connects each merge's child to the commit before the merge.

### Changed — Log tab titles use IntelliJ's wording

A tab with one filter is still titled by its value (**Log: main**). With several
filters, each now gets IntelliJ's prefix, joined by spaces:
**Log: on main by Ava --no-merges**.

### Added — more than one Log tab, as IntelliJ's Open Another Log Tab

The Git tool window's strip has IntelliJ's **+** after its last tab. It
opens another Log tab with the same filters as the one you were in, so you
can try a different filter without losing the first. Each tab keeps its own
filters, selection, scroll and pane layout. A new tab starts with the Branches
pane folded. Each tab is titled by what it shows: **Log** when unfiltered,
**Log: 2026.1** with a branch filter, **History: store.ts** for a file's
history. Close an extra tab with its **×**, a middle-click, or the right-click
menu (**Close Tab**, **Close Other Tabs**, **Close All Tabs**). The first Log
tab, Console and Worktrees always stay.

**File History**, **Compare with Current** and an update's **Show in Log** now
open in a tab of their own instead of replacing the filter you had set.
Running one again for the same thing brings its tab back rather than opening
another. Blame's Show in Log and Go to Hash/Branch/Tag still move within the
tab in front.

Tabs come back after a restart without slowing it down: a restored tab runs no
git until you first look at it. Only the tab in front refreshes when history
changes. The others catch up when you bring them forward.

### Added — Presentation Settings: Tag Names, and Show Tags for the Branches pane

The log's toolbar has IntelliJ's **Presentation Settings** button (the eye,
between Refresh and Go to Hash/Branch/Tag). Under **Show**, **Tag Names**
decides how a commit's tags are drawn. Off, which is IntelliJ's default and
now GitTree's, they are a tag icon without a name, and hovering over it shows
their names. On, the label carries the first tag's name. The setting is
`gittree.log.showTagNames`. Branches are always named either way.

The Branches pane's rail has IntelliJ's **Branches Pane Settings** gear, with
**Show Tags**. Turning it off removes the **Tags** node. Like IntelliJ's Show
Tags, it is one setting for every branch list: the Branches popup and the
sidebar's Branches views drop their tags too (`gittree.branches.showTags`, on
by default). The log's **Branch ▾** filter still offers tags.

Changing either setting, from its menu or from the Settings editor, redraws
the log in place, keeping the selection and scroll position.

### Changed — Commit and Push… opens the Push dialog first

**Commit and Push…** pushed the moment its commit landed. It now does what
IntelliJ does by default: once the commit is made, the Push dialog opens for
the repositories it committed — one dialog when the commit spans several — so
you can check the commits and where they are going before anything leaves your
machine. The commit window is free for the next commit while the dialog is
open. To push straight away as before, turn off
`gittree.push.showDialogForCommitAndPush` (IntelliJ's *Show Push dialog for
Commit and Push*).

### Added — a rejected push asks Merge or Rebase, then pushes again

When the remote had commits you did not have yet, a push stopped at an error:
"Pull (or fetch and rebase) before pushing", or, from the Push dialog,
"Push failed: To <url>" — the remote's address, not the problem. GitTree now
does what IntelliJ does. A **Push Rejected** question — *Push of the current
branch "main" was rejected. Remote changes need to be merged before pushing.* —
offers **Merge**, **Rebase** and Cancel. Your answer runs the same update as
Update Project, setting your uncommitted changes aside and putting them back,
then pushes again: *Pushed 2 commits to origin/main*.

- It covers every way you push the branch you are on to the branch it tracks:
  the Push dialog (`Ctrl+Shift+K`), **Commit and Push**, Sync, and a branch's
  **Push…**. Any other rejected push is reported with the remote's reason.
- The default button is your last Merge/Rebase answer, shared with Update
  Project, as IntelliJ keeps one update method for both.
- In a workspace with several repositories, the update also covers every
  other repository that tracks a remote branch, as IntelliJ's *Update all
  repositories* does. The question names them, and nothing is pushed again
  unless every update went through. Turn it off with
  `gittree.push.updateAllRepositoriesIfRejected` to update only the
  repositories whose push was rejected.
- **Don't Ask Again** on the result — IntelliJ's *Remember the update method
  and update silently in the future* — turns on
  `gittree.push.autoUpdateIfRejected` (*Auto-update if push of the current
  branch was rejected*); a rejected push then updates and pushes without asking.
- With merge commits of your own not yet pushed, it recommends Merge, offers
  *Rebase Anyway*, and asks even with auto-update on: rebasing would flatten
  them.
- If the update stops on conflicts nothing is pushed — *Push was canceled,
  because there were conflicts during the update* — and the merge is left for
  you to finish. Cancel reports *Push to origin/main was rejected*. **Show
  Details** opens the Console tab.
- Every push now reports in IntelliJ's words (*Pushed 1 commit to
  origin/main*, *Pushed feature to new branch origin/feature*); a plain push
  used to say nothing at all.
- A branch's **Push…** now pushes to the remote its upstream is on; it always
  used `origin`.

### Fixed — Commit Details now uses the whole pane you gave it

The Commit Details pane wrapped its text inside roughly the left half of itself
and left the rest blank, and widening the window made the empty strip *bigger*,
not smaller. Dragging the separator to give the pane more room handed it less
than half of what you dragged. Squeezed the other way, past about 240 px, the
text stopped reflowing and ran off the edge behind a scrollbar instead. The
commit message had a matching problem of its own: it was capped at 30% of the
pane's height and scrolled inside that cap, with empty pane sitting directly
below the words it had just cut off.

All of it came from three sizing rules the panel had carried since it sat
*beside* the commit list rather than in a pane of its own. Back then they
described how wide it could get; once it became a pane, the splitter decided
that, and the old rules were left arguing with it on the wrong axis.

The pane's size is the splitter's business now, as it already was for Branches,
Commits and Changed Files. The commit message takes whatever height is left over
and scrolls within it, so the subject, hash and author stay in view while you
read a long one — and if a commit carries so many refs that they alone outgrow a
short pane, the pane scrolls rather than hiding them.

### Fixed — selecting a commit no longer resizes the panes

In the Git tool window, clicking a commit could re-proportion the whole
window: Branches and Commits narrowed, Changed Files shortened, and the right
column swelled to take the room — all without touching a separator. It looked
random because it depends on the commit: those with a long message line or a
deep file path moved the layout, and the next commit moved it back.

Separators are set by dragging, and by nothing else. The two panes either side
of a separator were sized so that the second one's *content* took part in the
calculation, and flexbox pays for an over-wide pane by shrinking its
neighbours. A wide commit message was therefore charged to the Branches pane.
Each pane now keeps exactly the fraction it was given, and content that does
not fit scrolls inside its own pane, as it already did for long file names.

### Fixed — a folder full of repositories now shows its repositories

Opening one directory that *contains* several checkouts — the ordinary way to
keep related projects together — left GitTree **completely empty**: no
repositories, no branches, no log, every panel blank. Listing the same
checkouts individually in a `.code-workspace` file worked. The two are now the
same.

The search only ever looked *upward*. `git rev-parse --show-toplevel` walks
parents, so an open folder resolved to the repository it sits *inside*, and a
folder that merely holds repositories resolved to none of them. Nothing ever
looked down.

- **Repositories below each open folder are now found**, the same search VS
  Code's built-in git runs, with the same defaults: one level down, skipping
  `node_modules`. Tune it with `gittree.repositoryScan.maxDepth` (`0` restores
  the old upward-only search, `-1` is unlimited) and
  `gittree.repositoryScan.ignoredFolders`. Changing either re-searches
  immediately rather than at the next reload.
- **A repository that appears later joins on its own** — clone or `git init`
  inside the workspace and it shows up, where before it needed a window reload.
  One that is deleted leaves the same way.
- **A nested repository found directly is kept**, so opening the parent folder
  and listing every checkout in a `.code-workspace` file give the identical
  list. A repository still reached only by walking *up* out of a subfolder
  loses to the outermost one, exactly as before — with the search off, the rule
  is unchanged in every case.
- Candidate directories are filtered on a `.git` entry before git is spawned,
  so the search costs one process per real repository rather than one per
  directory, and it is bounded: an unlimited depth stops after 2 000
  directories and **says so in the trace** instead of quietly reporting a short
  list.
- Rediscovery is now serialized. With three triggers instead of one, two
  overlapping runs could both open the same repository and leak the first one's
  file watchers.

### Fixed — multi-root workspaces commit what you ticked

In a workspace with several repositories, the commit window listed them all but
**`Commit` only ever committed one of them** — whichever the active editor
pointed at — while the counter above it described every repository on screen.
Ticking files in two repositories and pressing Commit silently committed one and
left the other ticked, with nothing on screen naming which.

- **`Commit` now commits every repository that has something ticked**, IntelliJ's
  behaviour: one message, one commit per repository, in order. If one is
  refused, the run stops and says what already landed.
- **The button says what it will do** — `Commit to 3 repositories`, or
  `Commit to repoA` — computed from the same predicate the commit path uses.
- **Amend still rewrites only its own repository**, but now asks first when
  changes are ticked elsewhere instead of quietly narrowing the gesture.
- **One `Changes` row, one `Unversioned Files` row, repositories beneath** —
  IntelliJ's shape. A workspace of twenty repositories no longer renders twenty
  identical `Changes  0 files` rows above the one that has work: the same
  changelist across repositories is a single row, repositories with nothing in
  it contribute no row, and the empty default list stays as one anchor.
- **Changelist actions on a merged row fan out** to every repository behind it,
  and a new changelist is created in all of them, so `Move to…` offers the same
  names everywhere. The repository row keeps the scoped versions — including
  shelve, which belongs to a single repository.
- Invoking `gittree.commit` **with** an explicit repository — a context menu —
  is unchanged and stays scoped to that repository.

### Changed — GitTree now owns its own surfaces (Phase 14)

GitTree no longer builds on VS Code's Source Control framework or shares
surfaces with the built-in Git extension. **There is no mode to choose any
more**, and nothing about the built-in extension is changed on your behalf.

- **Its own container.** All GitTree views moved out of VS Code's Source
  Control sidebar into a **GitTree** container in the activity bar. View IDs
  are unchanged, so existing keybindings and layouts keep working.
- **No Source Control provider.** GitTree registers no `vscode.scm` provider
  and contributes nothing to VS Code's Source Control menus. The branch and
  sync indicators are its own status-bar items; the pending-change count is a
  badge on the commit view.
- **Its own change bars.** The gutter bars are GitTree-painted against the
  index (or HEAD — `gittree.changeBars.base`), with overview-ruler marks, and
  work whether or not the built-in Git extension is installed. Press
  `Ctrl+Alt+G H` on a changed line for Rollback / Stage / Commit View. Turn on
  `gittree.changeBars.hoverActions` to get the same actions, with the previous
  text and navigation, by hovering the line instead — it is off by default,
  because IntelliJ opens nothing on hover and the popup would otherwise sit on
  top of your language server's hover on every line you have edited.
- **Cross-file change navigation** — the thing VS Code's diff editor cannot do.
  At the last change of a file, next-change offers to continue into the *next
  file* instead of wrapping to the top of the current one; press again and it
  goes. At the end of the last file it says so and stops. `F7`/`Shift+F7` under
  the IntelliJ keymap. GitTree also contributes side-by-side/inline,
  ignore-whitespace and collapse-unchanged controls to its own diffs.
- **Its own status colours** (`gittree.color.*`), so file status stays coloured
  with the built-in Git extension disabled — previously it went blank.
- **Removed:** the takeover/companion consent modal and `gittree.mode`; the
  `gittree.commit.window: "native"` fallback surface (the commit tool window is
  the only commit surface, and its change tree now carries the changelist
  context menus); the `gittree.merge.ui: "native"` bridge onto VS Code's
  internal merge-editor command; and the read of the built-in `git.path`
  setting.
- **Migration:** if a workspace still carries the `"git.enabled": false` that an
  earlier GitTree wrote for takeover mode, it is removed on first launch with a
  notification. GitTree only ever removes what it wrote — a `git.enabled` you
  set yourself is left alone.

New deviations D18–D22 in [docs/deviations.md](docs/deviations.md) record what
the VS Code API made impossible: bar position, popup invocation, VS Code's own
diff arrows remaining beside GitTree's, and one-line anchoring differences.

### Added

- **The Commit tool window (Tier-1 rebuild, Phase 11).** One panel, first in
  the GitTree container, replacing the stacked sidebar trees:
  - `Commit | Shelf` tabs, an 8-action toolbar, and IntelliJ folder rows with
    single-child chains collapsed, `N files` badges on every node, and
    tri-state checkboxes on group, folder and file rows.
  - **Tick what you commit — down to a single change:** unversioned files are
    tickable (default unticked), and the Preview Diff pane offers per-change
    include checkboxes with `N differences, M included`; a file row reads
    `M of N changes`. Stale selections fall back to whole-file, loudly.
  - **Message editor** with a working native undo stack (history picks and
    amend loads are undoable), IME-safe composition, the 🕘 message-history
    dropdown, an `Amend  last commit ▾` reuse-message dropdown, and a soft
    72-character subject hint.
  - **Commit options gear popup:** `Author:` override with completion
    (`--author=`), `Sign-off commit` (`-s`), the check toggles, Cleanup
    profile, and *Run advanced checks after a commit is done*.
  - **Shelf tab** with the full action set (Unshelve…, Unshelve Silently,
    Unshelve Files…, Compare with Local, Rename, Delete, Import, the
    Show-already-unshelved toggle); damaged entries surface inline and refuse
    to unshelve.
  - **Shelve Changes dialog** with an embedded diff and per-change shelving:
    the stored patch contains exactly the ticked changes and the rest stays
    in the worktree byte-identically.
  - Status-colored names and folder highlighting, with per-status overrides
    (`gittree.colors.*`).
- Prefer the classic surface? `gittree.commit.window: "native"` restores the
  pre-11 changelists tree, SCM input box and shelf tree without a reload.
- **The Git tool window (Tier-1 rebuild, Phase 12).** The log becomes a real
  tool window instead of a single panel:
  - `Log | Console` tabs, and **four synchronized panes** — Branches (with its
    own vertical icon rail), Commits, Changed Files and Commit Details — in
    nested splitters whose sizes persist.
  - **Changed Files pane** with folder rows, `N files` counts and status
    colors; a multi-commit selection shows the aggregate diff.
  - **Presentation and highlight menus** (compact refs, tag names, timestamps,
    root names; My Commits, Merge Commits, Current Branch, Not Cherry-Picked),
    **Go to Hash / Branch / Tag**, and the full 28-item commit context menu —
    fixup and squash-into with autosquash, *Push All up to Here*,
    *Show Repository at Revision*, parent/child navigation, and reset
    including git's **Keep** mode.
  - **Patches**: create from local changes or a commit, copy to clipboard,
    and an apply engine that replays mailbox patches as commits.
  - **Console tab** recording every git command GitTree runs — argv, exit
    code, duration and output — with URL credentials, askpass values and
    author identities redacted before anything enters the buffer.
- **Dialogs, popups and the action hub (Tier-1 rebuild, Phase 13).**
  - **Eleven option-bearing dialogs** replace the QuickPick/InputBox chains:
    Push, Merge, Rebase, Reset, Rollback, Cherry-Pick, Stash, Unstash, Apply
    Patch, Clone and **Manage Remotes** (which had no command at all before). Each follows IntelliJ's *Modify options* pattern — a
    compact form plus a dropdown of the real git flags — rejects contradictory
    combinations **with reasons**, and shows the exact command it will run.
  - **Push dialog**: per-repository sections, an editable
    `branch → remote : branch` target row, the push's full changed-file tree,
    `Push tags` / `Run Git hooks`, and a `[Push ▾]` split button whose Force
    path is always `--force-with-lease`.
  - **Update Project** on `Ctrl+T` asks Merge or Rebase in a modal box that
    names the branch, its upstream and the exact commands, with your last
    answer as the default and *Reset to the Remote Branch* behind a
    confirmation and a Local History snapshot. *Don't Ask Again* on the result
    makes `Ctrl+T` act directly. Like IntelliJ's, it does not refuse because
    you are mid-work: uncommitted changes are set aside and put back, files you
    added to VCS stay added, and if putting your changes back conflicts you get
    a warning and the conflict view, with a copy kept in the stash. In a
    workspace with several repositories it updates all of them after one
    question, stopping at the first that fails — it used to update only the
    repository of the file you had open, and nothing at all with no file open.
  - **Reset** finally offers git's fourth mode, **Keep**, with a live
    "this will discard N local changes" line.
  - **Branches popup becomes an action hub**: top-level verbs before any
    branch, folder rows that drill in while typing searches flat across every
    level, and a `›` submenu per row — including **`Merge 'X' into '<current>'`,
    which was previously reachable only by drag-and-drop**.
  - **Worktree management**: a Worktrees view and a New Worktree dialog
    (create · open · remove · lock · unlock · prune).
  - **VCS Operations Popup** on `` Alt+` ``, listing every action applicable
    in the current context, enumerated from the dialog and branch registries.
  - **Merge**: `Apply non-conflicting changes` split into **Left · All ·
    Right**, a live `No changes. N conflicts.` counter, per-side
    *Show Details*, and a `Files Merged with Conflicts` dialog gate after a
    conflicted operation (the Conflicts view is retained).

### Changed

- Advanced commit checks (Analyze code, TODO) now run **after** the commit
  and report via notification by default — IntelliJ's shipped behaviour
  (*"Failed checks will not prevent a commit"*). Untick *Run advanced checks
  after a commit is done* in the gear popup (or set
  `gittree.commit.checks.deferAdvanced: false`) to restore pre-commit gating.
- Under the IntelliJ keymap, `Ctrl+T` now asks before updating and
  `Ctrl+Shift+K` opens the **Push** dialog, rather than acting silently — as
  they do in IntelliJ. The no-questions `gittree.pull` and `gittree.push`
  commands are unchanged and still in the palette.
- `FEATURES.md` has been rewritten so every item carries a *shape* criterion
  (which container, which toolbar, which menu) beside its behaviour, and
  `docs/parity-audit.md` re-scored against it: **118 at parity, 33 partial,
  79 absent**, from 75 / 36 / 122 before the rebuild.

### Fixed

- The commit window's intents (checkboxes, message typing, Commit) were
  posted on a channel no handler listened to and silently did nothing; the
  Shelve toolbar button executed a command id that never existed; and a
  layout race could render the change tree zero-height with unclickable
  rows. All three shipped with the first commit-window build and are fixed.
- **The log's `Branch ▾` filter now names HEAD.** Filtering to the current
  branch was always reachable — the Branches pane's `HEAD (Current)` row, the
  chip's `×`, or typing `HEAD` into the ref combo — but the dropdown listed only
  `All branches`, leaving its opposite unnamed and looking unsupported.
  `HEAD (Current)` is now the first row, ticked whenever no branch filter is
  set. Neither preset reads as active while a two-branch range is showing (a
  range outranks refs in the command GitTree runs), and picking one now clears
  the range instead of leaving a ticked box the log ignores.

### Fixed — the log showed a repository you never chose

In a multi-root workspace the Log panel picked which repository to show from
**whichever file happened to be focused**, and it re-picked on every filter
change, refresh and reload. Changing a filter while a file from another
repository was focused moved the log there and re-ran the filter against it —
and a `Paths` entry is relative to one repository while a `Branch` entry names
one repository's branches, so the log either went empty or the read failed
outright. Nothing on screen said which repository was on show, and nothing let
you pick one.

- **`Paths ▾` now has a `Roots` section** listing every repository in the
  workspace, each with its graph colour. Picking one moves the log there. The
  panel title carries the name of the repository on show.
- **The choice is now a decision, not a guess.** The focused editor seeds it the
  first time; after that only an explicit act moves it — a `Roots` row, or a
  command that names its repository. It survives a restart.
- **Moving root drops only what cannot travel** — the paths, and any explicit
  branch list or two-branch range. Author, date, text and sort survive.
- **`Show File History`** on a file in another repository now opens *that*
  repository's history. It used to filter the repository on show by a path
  belonging to a different one, which simply came back empty. **`Compare with
  Current`**, and **`Show in Log`** from a blame hover or the rebase editor,
  were wrong in the same way and are fixed with it.
- **`Paths ▾` gained `Select in Tree…`** — tick paths out of the repository's
  own tracked tree, in tree order. A very large repository offers folders only
  rather than silently truncating the alphabet, and says so. Anything the
  chooser could not show — a glob, a withheld file — survives the pick.
- **`Browse…` is now `Select…`**, IntelliJ's name, and it *adds* to the
  selection like the panel's own text box rather than replacing it. Picking a
  file outside the repository on show used to be dropped in silence, and if
  every pick was outside, the filter silently widened to unfiltered; it now says
  so and points at `Roots`.

The log still renders **one** repository at a time, where IntelliJ merges every
root into one graph — so the `Roots` rows are radios, not checkboxes. That is
recorded as **D24** in `docs/deviations.md`, with what it would take to lift.

### Fixed — the Branches context menu on the branch you are on

Right-clicking the checked-out branch in the Branches view offered four rows
where IntelliJ offers seven. The cause was not a missing feature: the tree marks
the current branch with its own `contextValue`, but nine of the menu's
visibility rules were written for two values (`local`, `remote`) and quietly
excluded it. The branches popup was worse still — its predicates tested
`type === 'local'` while the current branch is typed `head`, leaving it a single
row for HEAD.

- **`Show Diff with Working Tree`** and **`New Worktree from…`** now appear on
  the checked-out branch, where both have always worked. On HEAD the diff is
  your uncommitted work; the worktree dialog opens in *create a new branch*
  mode, since git cannot check a branch out twice.
- **`Update`** is new: fetch and bring a branch level with the remote branch it
  tracks. On the checked-out branch it updates straight away, as IntelliJ's
  does — merge or rebase, whichever you last chose in Update Project (Merge
  until you choose otherwise); only **Update Project…** asks. On any other branch it fast-forwards the ref in
  place without checking it out, and **refuses rather than rewrites** when the
  branch has diverged — it reports how far apart the two are instead.
- **`Tracked Branch`** is new: a submenu carrying the upstream's own actions —
  checkout, compare, diff, both pulls, merge, rebase, worktree, delete on
  remote — aimed at `origin/<branch>` instead of the row. Nothing new runs; the
  rows behave exactly as they do on the remote branch itself.
- **`Pull into Current Using Rebase`** joins the merge variant on remote
  branches, so both integrations are named rather than only one.
- The menu now follows the reference's order, so `New Worktree` no longer sorts
  after `Delete`, and rows are grouped as the popup groups them.
- Both menus are gated on whether the branch actually tracks anything, and the
  tracking bit is re-read from the repository — an upstream deleted on the
  remote takes `Update` and `Tracked Branch` away with it.
- `New Worktree from…` no longer builds the worktree from the **first**
  repository in a multi-root workspace: the row now names its own repository.
  A remote branch chosen as the start point is also no longer silently replaced
  by whichever local branch sorted first.

## [0.0.1] — 2026-07-16

First feature-complete build — IntelliJ IDEA Ultimate Git parity per
[FEATURES.md], built local-first.

### Added

- **Commit lifecycle** — both IntelliJ paradigms: index-bypassing
  changelists (multiple lists, active list, auto-adoption of new changes)
  and native staging with hunk/line-level stage from the diff editor;
  pre-commit checks (reformat changed lines, optimize imports, analyze,
  TODO scan, cleanup), amend, GPG sign toggle, message history.
- **Branches** — categorized popup (current/recent/local/remote),
  favorites, smart checkout (auto-stash → checkout → unstash → conflict
  flow), compare-with-current, rename/delete/push actions.
- **Log & history** — virtualized 100k-commit graph (Date/Topo/IntelliSort),
  intersecting Branch/User/Date/Path filters with author autocomplete,
  revision actions (cherry-pick, revert, undo, drop, reword, reset,
  checkout revision), file history with rename following.
- **Interactive rebase** — drag-and-drop editor with pick/reword/squash/
  fixup/drop, keyboard reorder, message editing, paused-state
  continue/skip/abort.
- **3-pane merge editor** — real editor in the result pane, chevron
  accepts, magic-wand auto-resolution of non-overlapping conflicts,
  F7/Shift+F7 navigation, per-file and per-session accept-all.
- **Stash & shelve** — full stash GUI; IntelliJ-style shelf storing patches
  outside `.git` (survives repo deletion), patch editing with validation,
  full/partial unshelve with conflict-safe apply ladder.
- **Local History** — snapshot failsafe around every destructive operation
  plus save-time snapshots, Timeline integration, diff/restore/recover.
- **Blame** — toggleable gutter annotations with age heat-map, click-through
  to the log, dirty-buffer-aware.
- **Accessibility** — full keyboard parity (docs/keyboard.md), screen-reader
  labels on graph rows, live-region announcements, high-contrast and
  reduced-motion support, color-blind-safe graph palette
  (`gittree.log.graphPalette`), optional IntelliJ keymap
  (`gittree.keymap.intellij`).
- **Onboarding** — Getting Started walkthrough with a generated local
  playground repository (`gittree.generatePlayground`).

### Not included (by decision)

- GitHub/GitLab pull-request review (FEATURES.md §7) — skipped by project
  decision; see `docs/plan/PHASE-08-provider-integrations.md`.
