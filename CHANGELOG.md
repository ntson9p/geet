# Changelog

All notable changes to GitTree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the VS Code
pre-release convention (odd minor = pre-release).

## [Unreleased]

### Changed — the Commit window lists changes as VS Code's Source Control view does

- **No changelist rows by default.** Every changed file is listed under its repository, in path
  order, with its folder after its name. With one repository the files are at the top.
- **Each file shows its status**: VS Code's letter at the end of its row, in the status colour
  (`M`, `A`, `D`, `R`, `U`, and `!` for a conflict). A deleted file's name is struck through.
- **Untracked files are among the others.** They look like the added files they will become, in the
  same colour and icon; their names are in italics and their letter is `U`. They start unticked, as
  before.
- **View Options (the eye) has two toggles**, and is there with one repository too:
  - *Changelist* brings the changelist rows back;
  - *Directory* adds folder rows, with or without changelists.
  With several repositories, which comes first, changelists or repositories, is chosen under them.
- **Right-click a repository** for *Select in Repositories Panel*: the panel shows only that
  repository, as a click on it there does. The menu also has its change actions, *Reveal in File
  Explorer*, and the Repositories panel's own menu for it.
- Changelists still exist: new changes go to the active one, and *Move to Another Changelist…* is
  still on a file's menu. Merge Conflicts is a row of its own, first under its repository.
- Settings: `gittree.commit.groupBy` gains `none`, its new default, and
  `gittree.commit.groupByDirectory` is new. A grouping you had set is kept.

### Changed — a compact Commit tab you can resize

- **Twice the list in the same space.** At the side bar's first size, the list of changes
  shows about 10 rows instead of 5:
  - the toolbar shares the tabs' row; what does not fit there is in `⋯`;
  - the message box starts at 3 lines instead of 6;
  - one full-width **Commit** button replaces the two that wrapped onto two rows. Its ▾ holds
    *Commit and Push…*. The gear moved up to the Amend row.
- **A divider above the Amend row sizes the message box.** Drag it; double-click it (or press
  `Enter` on it) for the first 3 lines; `↑`/`↓` move it a line. The box keeps the height you
  give it, also after a reload. It no longer grows as you type: a longer message scrolls inside.
- **A short Commit view no longer cuts off the Commit button.** Below about 360 px the view
  used to scroll as a whole and lose its buttons. Now it takes room from the list, down to 3
  rows, then from the message box, down to one line, then from the list again. The Commit
  button always stays on screen.

### Fixed — no more doubled badges (`U, U`, `M, M`) in VS Code's own views

- **GitTree's file badges are now off by default** (`gittree.decorations.fileExplorer`). VS
  Code shows an extension's file badges in every view: its Explorer, editor tabs, breadcrumbs
  and its own Source Control view. It joins two extensions' badges for the same file. With
  the built-in Git extension running, as it does by default, every changed file there read
  `U, U` or `M, M`.
- If you disable the built-in Git extension and want GitTree's badges, turn the setting on.

### Changed — the Repositories panel's `⋯` menu commits and pushes what is in view too

- **With some repositories picked, *Commit…* and *Push…* in the `⋯` menu act on those, and
  say so,** as its update already does:
  - one picked: *Commit Repository…*, *Push Repository…*;
  - two picked: *Commit 2 Repositories…*, *Push 2 Repositories…*;
  - every repository shown: *Commit…* and *Push…*, unchanged.
- **Commit** commits what is ticked in those repositories, with the message typed in the
  Commit window, one commit each. Changes ticked in other repositories stay ticked. The Amend
  box applies only when its repository is one of those.
- **Push** opens the Push dialog with every repository listed, and those ticked.
- Before, with two of four picked, they acted on every repository.

### Changed — a repository's own update is *Update Repository…*, and the `⋯` menu updates what is in view

- **A repository's right-click menu and its row's ↓ button now say *Update Repository…* and
  *Update Repository Without Fetching…***, in the Repositories panel and in the Repositories
  (Tree) view. They always updated that repository alone, but said *Update Project…*, which
  everywhere else updates every repository.
- **The Repositories panel's `⋯` menu updates what is in view:**
  - *Update Project…* with every repository shown;
  - *Update Repository…* with one picked;
  - *Update 2 Repositories…* with two picked.

  Before, with two of four picked, it updated all four; with one picked, it updated that one
  under the project's name.
- **The update's question says what it updates:** *Update Project*, *Update api* or *Update 2
  Repositories*. So do its progress and a failure.
- **Unchanged elsewhere:** *Update Project…* in `Ctrl+T`, the Command Palette, the Branches
  popup and the VCS Operations popup still updates every repository. A workspace with one
  repository sees no change: its update is still *Update Project*.

### Fixed — a repository clicked a second time no longer looks picked

- In the Repositories panel, clicking the repository you are showing alone shows every
  repository again, as it did before. Its row, though, stayed highlighted, so it still looked
  picked.
- **Now a repository's row is highlighted while it is picked, and only then.** When you
  Ctrl+click several, every picked one is highlighted, not just the last one clicked.
- Moving through the rows with the keyboard shows a focus ring and the row's buttons. A click
  leaves no ring.
- Each repository's hover now says what a click on it does. With two picked, it said a click
  would show every repository; a click there shows that one alone.

### Changed — *Run advanced checks after a commit is done* starts unticked

- In the Commit window's gear popup, **Run advanced checks after a commit is done** now starts
  unticked: `gittree.commit.checks.deferAdvanced` defaults to `false`. IntelliJ ticks it.
- What that changes: a ticked **Analyze code** or **Check TODO** now runs **before** the commit,
  as the other checks do, and a finding asks *Review…*, *Commit Anyway* or *Cancel*. Until now
  they ran after the commit and only reported in a notification.
- Nothing changes until you tick one of those two: every check still starts unticked.
- Tick the box (or set the setting to `true`) to have them run after the commit again. If you
  set it yourself before, here or in Settings, it keeps your choice.

### Changed — the borders you drag to resize GitTree's side bar are drawn

- **A line now runs along each border in GitTree's side bar that a drag resizes**, so you can
  see where to grab:
  - under the Commit window, on VS Code's own divider between it and the Repositories panel;
  - between the Repositories panel's REPOSITORIES and BRANCHES panes, while both are open;
  - between the change tree and Preview Diff.
- VS Code's modern look draws no line between its views, and its classic look only a faint
  one, so until now nothing showed where those dividers were.
- Pointing at a line shows the resize cursor and lights the divider, as before. The lines
  take no clicks of their own.
- The colour is the theme colour `gittree.sectionBorder`: see-through white in dark themes,
  see-through black in light ones, and the theme's own border colour in high contrast. Set it
  in `workbench.colorCustomizations`; transparent hides the lines:

  ```json
  "workbench.colorCustomizations": { "gittree.sectionBorder": "#00000000" }
  ```

### Fixed — each branch in the Repositories panel says which repositories have it

- **With several repositories in view, every branch row now names the ones that have the
  branch**, so a search's matches say where they are without picking a repository first. The
  words sit between the row's `↓ ↑` counts and its age, lined up down the list:
  - *in api, web*: up to three repositories, named;
  - *in both*, *in all 20*: every repository in view has it;
  - *in 13 of 20*: more than three.
- It is the same in the Recent, Local, Remote and Tags tabs. Narrowed to some repositories, the
  rows speak of those; narrowed to one, they say nothing, as the filter's pill already names it.
- **Hover a row for the full story:** every repository it is in, the ones without it when there
  are three or fewer, and where it is checked out when that is only some of them. A screen
  reader hears it too.
- The words hold still when the row's buttons show. In a narrow sidebar they become a count
  (*in 2*); in VS Code's narrowest they make way for the branch's name, and the hover still says
  it. With **Repository Dots** on, the dots take their place.

### Fixed — Ctrl+Enter in the Commit window's message box commits

- **Type a message, press `Ctrl+Enter` (`⌘Enter` on macOS), and it commits**, as clicking
  Commit does and as VS Code's Source Control box does. Until now the key did nothing there.
- It commits exactly what the button would: what is ticked, with the message as you typed it,
  down to the last character. When the button is disabled (no message, nothing ticked, or a
  commit still running), the key does nothing, and holding it down commits once.
- It works in the message box only, not in the file tree. The key no longer types a line break
  there; `Enter` and `Shift+Enter` still do.
- It can be rebound in Keyboard Shortcuts: **GitTree: Commit from the Message Box**.

### Fixed — GitTree's own menus and popups close when you click elsewhere

- **A menu or popup GitTree draws itself now closes when you click anywhere outside it,
  elsewhere in VS Code included.** Until now it closed only for a click inside its own panel and
  stayed open after a click in the editor, a tab, the status bar, a toolbar or another view. This
  covers:
  - the Repositories panel's branch, repository and `⋯` menus;
  - the Commit window's message history, Amend ▾ and View Options menus, and its options popup;
  - the Log's filter panels, Graph Options and Presentation menus, its tab menu and its Branches
    pane's menu;
  - the menus in GitTree's dialogs.
- They also close when you switch to another application, as VS Code's own menus do. The click
  still does what it was for: a click in the editor puts the cursor there, and the keyboard stays
  where you clicked. A `<select>`'s list or a date picker inside a popup keeps it open.
- The Commit window's options popup no longer takes the keyboard back from its Author field
  whenever the window redraws.

### Added — Reveal in File Explorer from the Commit window

- **Right-click a file in any changelist → Reveal in File Explorer** (*Reveal in Finder* on
  macOS, *Open Containing Folder* on Linux). The system's file manager opens on the file's
  folder with the file selected. On a folder row it opens the folder's parent with the folder
  selected. Every list has it: your changelists, Unversioned Files, Merge Conflicts, and Staged
  and Unstaged with the staging area.
- **VS Code's own key for it works there too:** `Shift+Alt+R` on Windows, `⌥⌘R` on macOS,
  `Ctrl+Alt+R` on Linux, on the row the keyboard is on in the change tree. Until now that key in
  the Commit window revealed the file open in the editor, or the workspace folder, and on
  Windows it also opened VS Code's Run menu.
- It is not offered on a deleted file, which has nothing on disk to show, nor in a remote window
  (SSH, containers), whose files are on another machine. A WSL window has it from VS Code 1.113,
  the first to reach WSL's files from Windows.

### Changed — Checkout Tag or Revision is offered only where it can say which repository

- **With several repositories in view, the `⋯` menu no longer offers Checkout Tag or
  Revision…** It checks out in one repository, and the menu could not say which: it used the
  editor's repository, or the first one. Right-click a repository to check out a tag or a
  revision there. With one repository in view it is still in the `⋯` menu, for that one.
- **The Branches popup and the Branches view do the same at their top level** with several
  repositories, where **Checkout Branch in All Repositories…** is offered instead. Open a
  repository in the popup, or search within one, to find its own **Checkout Tag or
  Revision…**.
- **From the Command Palette, GitTree: Checkout Tag or Revision… asks which repository** when
  there are several, instead of taking the open file's repository, or the first. The open
  file's repository is listed first, so `Enter` still picks it.

### Added — Update Project Without Fetching

- **Update Project Without Fetching…** runs Update Project's merge or rebase without the
  fetch, from each remote branch as it was last fetched. It is instant and works offline. It
  sits right under every **Update Project…**: the Branches panel's `⋯`, each repository's
  menu, the Branches popup, the VCS Operations popup and the Command Palette.
- Its question says how old each repository's data is (*· fetched 2 hours ago*). A repository
  whose upstream was never fetched is skipped and named. The summary says *up to date with
  what was last fetched* rather than plain *up to date*.
- **When Update Project can't fetch** (offline, VPN down, remote unreachable), the failure
  message offers **Update Without Fetching**.

### Added — a repository's Show in New Log Tab

- **Right-click a repository in the Repositories panel → Show in New Log Tab.** This opens that
  repository's history at HEAD in a Log tab of its own. Running it again brings that tab back
  rather than opening a second one. The sidebar's Repositories section has the same item.

### Changed — the bottom panel is titled GitTree

- **The bottom panel that holds the Log, Console and Worktrees is now titled GitTree,** after
  the extension, instead of Git.

### Changed — a branch's card opens when you ask, and stays short however many repositories

- **A click on a branch in the Repositories panel now only selects it.** Its card opens with
  the chevron at the row's left, a double-click, or Enter, Space or →. ←, Escape, the chevron
  or another double-click close it. A double-click never checks out.
- **Repositories that say the same about a branch are now one line on its card.** For example:
  *All 20 · up to date · 2 ahead, 4 behind current*, instead of twenty identical lines. The
  ones that differ get a line each, named (*api, web*) or counted (*13 repositories ›*). Click
  a count to list them.
- **The card also names the repositories in view that don't have the branch:** *not in
  shared*, *not in 4 repositories ›*.

### Changed — the Repositories panel's Repository Dots are a switch, and stay put

- **The dots that show which repositories have a branch are now off by default.** Turn them
  on and off with the new dots button in the panel's toolbar, with **⋯ › Show › Repository
  Dots**, or with **GitTree: Toggle Repository Dots** from the Command Palette. The setting is
  `gittree.branches.showRepositoryDots`. A branch's card still lists every repository.
- **Hovering or selecting a branch row no longer moves its dots.** The row's buttons used to
  replace the age at the end of the row, and being wider, they pushed the counts and dots
  left. They now come before the counts, the dots and the age, which stay where they are.
  The age stays visible too.

### Fixed — a branch's menu across many repositories fits the panel

- **Twenty repositories made a branch's menu about thirty rows long,** twenty of them
  repository names, taller than the sidebar. Past five repositories, they are now one row,
  **In One Repository ›**, holding each repository's own menu; up to five, they are listed
  under *In one repository* as before.
- **A menu taller than its panel ran off the bottom,** its last rows out of the pointer's
  reach. Every GitTree menu now scrolls inside the panel it opens in, and the arrow keys bring
  the row they reach into view. A menu wider than the panel was cut off at the side; its
  labels now end in `…`, its shortcuts and `›` still showing.
- **Fixed on the way:** keyboard navigation in a scrolled menu no longer loses its row to the
  pointer. A menu opens under the pointer, and Chrome reported the row that scrolled beneath
  the resting pointer as entered, which took the selection from the keyboard. A row is now
  taken only when the pointer actually moves onto it. A submenu whose row scrolls away closes.

### Changed — a GitTree message with nothing to click leaves after 5 seconds

- **GitTree's plain messages go after 5 seconds:** *Fetch successful*, *Checked out main*,
  *Nothing to stash.* VS Code kept them 10 seconds (15 before 1.105), stopped counting while
  you were in another application, and never hid one under the pointer, so they could look
  endless. A long one gets a second for every four words past ten, up to twice the setting.
- **The time counts while VS Code is in front.** Away in another application, a message waits
  for you, and finishes what is left of its time when you are back, as IntelliJ's balloons do.
- **`gittree.notifications.durationSeconds`** sets it, from 0 to 60. At `0` they are ordinary
  notifications again.
- **They are not kept in the Notifications list (the bell):** VS Code cannot hide a
  notification on a timer and keep it there. The **GitTree** output keeps a copy, as
  `[notice] 13:27:54 Checked out develop`. Nor do they have a `×` while they show; `Escape`
  hides one, and VS Code then shows its words in the status bar until its time is up.
- Messages with buttons (*Deleted branch x* with **Restore**), warnings and errors are ordinary
  notifications as before: they ask for a decision, or say something went wrong.

### Changed — the Repositories panel: REPOSITORIES and BRANCHES are panes

- **The branches are a pane of their own.** With several repositories, the Repositories panel
  was one list: the repositories, then the tabs and the branches, so twenty repositories pushed
  the branches to the foot of the sidebar. They are now two panes, **REPOSITORIES** over
  **BRANCHES**, headed as VS Code heads its views. Each folds at its header and scrolls on its
  own. BRANCHES is what was there: Recent, Local, Remote and Tags, and the branches under them.
- **The line between them is dragged** to share the height, and double-clicked to go back to
  the automatic share: every repository while they take up to 40% of the panel, else 40%. It
  stops at the last repository, at one repository's row, and at BRANCHES' tabs and two rows.
- **The REPOSITORIES header names the repositories picked,** each with its dot, and keeps
  naming them while the pane is folded. Nothing is named while every repository is shown. In a
  narrow sidebar, *Show all* gives way to the names; the filter's pill still widens the panel.
- Folds and the dragged size are kept across reloads. A search opens a folded BRANCHES, where
  its matches are. On a header, `Enter`/`Space` fold and open, `←` folds, `→` opens, and the
  arrows go on between a pane's header and its rows.
- One repository is one list, as before: its current branch, then the tabs.
- **Fixed on the way:** `Escape` in the panel's empty filter did not go back to the row it
  had come from: asked for the row the list already kept, the list changed nothing and so never
  moved the focus. It now focuses a row it has drawn at once.

### Fixed — the merge editor's toolbar has one magic wand

- **Two magic wands stood in the merge editor's toolbar.** One resolves simple conflicts. The
  other was *Apply Non-Conflicting Changes: All*, which wore the wand too. It now wears ⟷,
  between → (from the left) and ← (from the right), in IntelliJ's order: ✓ → ⟷ ← wand ↺. The
  three applies are all on the toolbar now: *Right* had been pushed into the `…` menu.
- **The arrows mean one thing each.** *Accept All Yours (File)* and *Accept All Theirs
  (File)* wore the same arrows as the applies, pointing the other way. They are now in the
  `…` menu, as IntelliJ's Accept Left and Accept Right are buttons of their own. The
  all-files accepts there say *(All Files)*.
- The wand says *Resolved 0 of 1 conflict*, not *of 1 conflicts*.

### Fixed — a stash has a right-click menu

- **Right-clicking a stash in the Stash tab offers its actions:** Apply Stash, Pop Stash,
  Branch from Stash…, Compare All vs Working Tree, Copy Stash Message, Drop Stash…. Before,
  only the toolbar had them, as a Shelf row's menu has its own. The menu acts on the stash
  clicked, found by its commit, even if the list has moved since.

### Fixed — the log's Branches pane reads its branch names

- **The Branches pane opens wide enough for its names,** 28% of the log's left part where it
  was 22%. At the panel's default size that left `bu…` and `HEA…`. A layout you have set
  stays as it is.
- **One scrollbar, not two.** In a short panel the pane's icon rail outgrew it, and the pane
  scrolled beside the branch list's own scrollbar. The rail now scrolls by itself, with no
  bar of its own.

### Fixed — the Commit window shows the conflicts

- **A merge's unresolved files are in the Commit window, under Merge Conflicts, first.** With
  changelists they were nowhere in it: the lists hold no unmerged file, and a commit was
  refused for conflicts the window did not show. As IntelliJ's node does, the group has no
  checkboxes and offers **Resolve Conflicts…** (on hover, in its menu and in the palette). A
  conflicted file opens in the merge editor, not as a diff of its conflict markers, with
  staging too. A conflicted file is offered no Move to Another Changelist and no Rollback.

### Fixed — counts read as English

- **`1 file`, `3 files` — not `1 file(s)`.** Every message that counted files, commits,
  conflicts, problems or changes said `(s)`. Each now says the singular or the plural, as
  IntelliJ's do, verbs agreeing (*1 conflicted file remains — resolve it first*). A
  conflict's toast names the operation, *Unstash stopped on 1 conflicted file*, where it said
  `stash-pop produced 1 conflicted file(s)`.

### Fixed — the message editor of Edit Commit Message… is GitTree's alone

- **Built-in Git's Commit and Discard buttons no longer float in GitTree's message editor**
  (Edit Commit Message…, Squash Commits…). They belong to built-in Git's own commit editor,
  and they appeared beside GitTree's **Accept** because the editor was a `git-commit`
  document. It is now GitTree's *Commit Message* language, with the same highlighting.

### Fixed — the Commit button keeps its label on one line

- **`Commit to 3 repositories` no longer breaks over two lines inside its button.** Short of
  room, the row of buttons wraps instead: **Commit and Push…** moves below, and both labels
  stay whole.

### Fixed — one way of writing dates

- **Commit Details writes the date the way the Date column does.** It read
  `11/7/2026 at 09:27 PM` under a column reading `2026/11/07 21:27`. It now follows
  `gittree.log.dateFormat` like the column: *on 2026/11/07 at 21:27*, or the locale's own
  with `locale`.
- **Stashes, shelves and the message history give dates the same way.** Past a day they showed
  the locale's `11/5/2026`. They now write `2026/11/05`, or follow the locale as the log does.

### Changed — `gittree.log.sort` is deprecated

- **`gittree.log.sort` had no effect, and now says so.** Each Log tab keeps its own sort,
  chosen under its Graph Options, and a new one starts by commit date. The setting's default
  read `topo`, the opposite of what the log did. The settings reference now marks deprecated
  settings, `gittree.quickDiff.base` among them.

### Fixed — the Commit window's file rows

- **A file's row no longer repeats the folder it sits under.** Every file named its folder
  beside it, `release notes/v1.0 draft.md  docs/release notes`, and in a narrow sidebar the
  repeat squeezed the name to `v1.0 draft…`. The folder rows already say it, as in IntelliJ's
  tree.
- **A renamed file says where it came from:** *renamed from math.ts*, or *moved from
  src/lib/store.ts* when it changed folders. It read `src/utils/math.ts ->`, an arrow at
  nothing.

### Fixed — cleaning or rolling back many files at once

- **Clean Untracked Files and Rollback work on any number of files.** Each passed every path
  to one git command, which outgrew Windows' command line on a big tree and failed. They now
  go in slices, as staging already did. Their confirmations list a dozen files and say how
  many more, instead of growing past the screen.

### Fixed — the Commit window has room for its changes

- **The preview diff is one column in a narrow sidebar,** a change's removed lines above its
  added ones, as IntelliJ's unified viewer shows them. Side by side, a 350px sidebar cut both
  sides to `import {…`. Wider than 640px, it is still side by side.
- **The Commit view starts with more of the sidebar than the Repositories view,** three
  parts to two. Shared half and half, at 1444×818 the change tree showed three rows under
  the message box. A layout you have already set is kept.

### Fixed — the Console: its filter box shows, and each command says where it ran

- **The Console's filter box is whole again.** At the panel's default height its row was
  squeezed to a third of its height, and the box sat half under the tab strip. No toolbar row
  is squeezed under its content any more.
- **With several repositories open, each command names its repository,** `[app] git status`,
  as IntelliJ's console does. The filter finds it by that name too. Times and durations no
  longer wrap in a narrow panel.

### Fixed — menus name IntelliJ's keys only when they are bound

- **The Branches popup, the VCS Operations Popup and the Repositories panel's ⋯ menu name
  Ctrl+T, Ctrl+K, Ctrl+Shift+K, Ctrl+Alt+N and Ctrl+Alt+Z only with the IntelliJ keymap
  on** (`gittree.keymap.intellij`, off by default). With it off they named keys that did
  nothing, or did VS Code's own thing: Ctrl+Shift+K deletes a line. **Rename…** in the
  Branches popup no longer says F2. F2 renames in the Repositories panel, where it still
  says so, and not in a popup.

### Fixed — Enter on Show Change Actions no longer rolls the change back

- **Show Change Actions lists Stage first and Rollback last,** set apart. Rollback was the
  first item, so Enter, the quick way to take the first, threw the change away.

### Fixed — Undo Commit is offered for the last commit only

- **The log greys out Undo Commit on any commit but HEAD,** as IntelliJ does. It was offered
  on every commit and then refused with *only applies to the latest commit*. The palette's
  Undo Commit still undoes HEAD.

### Fixed — Local History brings deletions back; Reset… opens on HEAD

- **Restoring a snapshot deletes again what was deleted then.** A snapshot recorded the files
  there were, and skipped a deleted one as gone. So restoring *Before: reset* after a `reset
  --hard` brought back every edit, while the files deleted before the reset stayed: the
  reset had restored them. The snapshot now records a deleted file of the dirty set (a
  rename's old path too) as deleted. Its row says *deleted*, and **Restore** deletes it,
  after saying how many it will delete. **Undo restore** works both ways: a file the
  restore brought back is deleted again.
- **Reset… opens on HEAD,** as IntelliJ's Reset HEAD dialog does. It opened on `HEAD~1`, so
  the commonest reset, *Hard* to throw away what is uncommitted, threw away the last commit
  as well for anyone who kept the default.

### Fixed — a merge commits from the Commit window, and a conflict says so once

- **A merge whose conflicts are resolved commits from the Commit window.** With changelists,
  git refused the window's `commit --only` mid-merge (*cannot do a partial commit during a
  merge*). In either paradigm the commit then waited behind the conflict pause for good: the
  pause lifts when the merge ends, and only that commit could end it. The window now commits
  HEAD plus what is ticked as the merge commit, as IntelliJ does. Unticked changes of the
  merging repository are asked about first (*Are you sure you want to exclude these changed
  files from merge commit?*). While a conflict is left nothing commits (*Cannot commit
  changes due to unresolved conflicts.*, with **Resolve Conflicts…**). Once none is, Stage
  and Unstage no longer wait for the merge to end either.
- **The banner's button for a merge says Commit Merge.** It read *Continue* and committed at
  once with git's prepared message. That is what IntelliJ's **Commit Merge** does, and the
  button now says so. To write your own message, commit from the Commit window: **All
  conflicts resolved → Commit Merge…** opens it, expanded, with the merge message in it.
- **Resolve… brings the Files Merged with Conflicts dialog back.** It only focused the
  Conflicts view, so once the dialog was closed it could not be had again.
- **One notice per conflict.** A merge, rebase or pull that stopped on conflicts raised the
  dialog and two or three toasts saying the same. A cherry-pick, merge, rebase or unstash
  started from GitTree's dialogs also showed git's *could not apply …* as an error. The
  dialog is the notice now, or one toast with the dialog turned off.
- **Every conflicted stop gets the dialog.** When a rebase's next step or a cherry-pick's
  next commit stopped on conflicts of its own, only the Conflicts view changed. Continuing
  a cherry-pick into such a stop also reported git's *could not apply* as a failure.
- **A notification's button no longer acts after the fact.** *Commit Merge…* clicked after
  the merge was committed, or *Continue* clicked from a stop the operation has since left,
  says *That has already been done.* in the status bar. Before, it acted on the next stop.
- **The rebase banner offers Skip,** as IntelliJ's rebase toolbar does. The toast that
  offered it is gone with the others.

### Fixed — a part of a file is committed and staged where it belongs

- **Committing some of a file's changes no longer moves the lines it commits.** A change
  left out above the committed one shifted where git put it: a line typed above a closing
  brace, with three new lines left out at the top, went into the commit three lines lower,
  after the brace. The same happened to **Stage** in the change popup, the diff editor's
  *Stage hunk* lens and *Stage Selected Ranges*. Each change now lands where it is in the
  file, whatever is left out around it.
- **Unstage Selected Ranges takes out the lines selected.** It read a selection in the
  working-tree file as line numbers of the staged text, so with unstaged edits above, it
  unstaged other lines. It now works where the staged lines are on screen: the right side
  of the *HEAD ↔ Index* diff.
- **Files checked out with Windows line endings work like any other.** Under
  `core.autocrlf=true`, the Git for Windows default, the working tree has CRLF while git
  stores LF. GitTree compared the two byte for byte, so the change bars marked every line
  of every file as changed, a commit of some changes saw one change covering the file, a
  staged change wrote `\r` into the index, and rolling back one change rolled back the
  file. Changes are now measured on the line endings git stores, as IntelliJ's are, and a
  staged or committed part is stored the way `git add` would store it. Shelving part of
  a file leaves the rest with its own line endings.

### Fixed — a failed commit says why

- **A commit refused by a hook shows what the hook said.** The Commit window kept git's first
  line only. A linter's *"notes.md line 3: trailing whitespace"* was shown, its other
  findings and its summary were dropped, and the banner never said which repository refused.
  It now shows the hook's lines, a dozen at most, after the repository's name when several
  are open, with **Show Output** for the full command and **✕** to put it away. The banner no
  longer squeezes the toolbar under it to half its height, and a long one scrolls.

### Fixed — moving a file between changelists keeps it out of the commit

- **A file you left out of the commit stays out when you move it to another changelist.** A
  move ticked it, unversioned files included, so the next **Commit** took a file you had
  unticked. It now keeps its tick wherever it goes.
- **Move to Another Changelist… no longer offers the list the files are already in.** With a
  single changelist, that list was the first choice and had the focus, so **Enter** moved the
  files nowhere. As in IntelliJ, it is left out, and **New changelist…** is offered instead.

### Fixed — the log shows branches, not stashes; File History shows this branch

- **All branches no longer lists your stashes as commits.** It ran `git log --all`, which also
  walks the stash. Every stash added its *On main: …*, *index on main: …* and *untracked files
  on main: …* commits to the graph. It now reads what IntelliJ's log reads: HEAD, every branch,
  remote branch and tag. The User filter's list of authors comes from the same commits.
- **File History opens on the current branch,** as IntelliJ's History does. It showed every
  branch, so a commit made on a hotfix branch read as the newest change to the file here.
  The tab's **Branch** filter still widens it.

### Fixed — GitTree no longer writes settings into your repository

- **A push no longer leaves `.vscode/settings.json` behind.** GitTree saved its remembered
  choices as workspace settings. In a folder, that means the repository's own
  `.vscode/settings.json`, a file teams commit and share, which then showed up in Unversioned
  Files. The Push dialog wrote its tag mode on every push. The commit paradigm, Group By,
  the Show items, the shelf's Show Already Unshelved, the diff editor's whitespace option,
  the commit options, Don't Ask Again and saved Log filters were written there too. Each is
  now saved where you keep that setting already, and otherwise in your user settings, as VS
  Code's own toggles are. Nothing is written when the value does not change.

### Fixed — the staging paradigm has its own Commit window

- **With *Git Staging Area* chosen, the Commit window shows what will be committed.** The
  setting changed what **Commit** did, which was to commit the index, but not what the
  window showed. Changelists and their ticks stayed, so *7 of 10 files* were ticked while
  **Commit** committed the one file staged. The window now has IntelliJ's staging-area
  nodes: **Merge Conflicts**, **Staged**, **Unstaged** and **Unversioned Files**, without
  ticks.
  - A file staged in part appears under both Staged and Unstaged.
  - **+** and **−** on a row, folder or node stage or unstage it, from hover or from the
    row's menu.
  - Each row opens its own half as a diff: HEAD against the index for Staged, the index
    against the file for Unstaged. The preview pane does the same.
  - The counter says how many files are staged, and **Commit** needs something staged.

### Fixed — ticks show in light themes

- **A ticked checkbox is visible in every theme.** Ticked boxes used the colour VS Code
  defines for a checkbox inside a *selected* row, which light themes make near-white, so
  the white tick vanished. In Light Modern the Commit window looked unticked while it said
  *1 of 1 file*. Ticked boxes are now filled with the theme's button colour and ticked in
  its button text colour, the pair VS Code keeps readable, which is IntelliJ's look too.
  High-contrast themes keep their outline. This is checked by reading the colours in Light
  Modern, Dark Modern and both high-contrast themes.

### Fixed — several repositories: the palette asks which one

- **Merge…, Rebase…, Reset…, Stash Changes…, Unstash…, Rollback…, Cherry-Pick…, Apply Patch…
  and Manage Remotes… work from the palette in a multi-root workspace.** With no file open
  they said *Open a repository first.* although three were open. They now ask which
  repository, as IntelliJ's dialogs do with their *Git Root* field. The repository named by
  the command, or the one of the file in front of you, is still taken without asking.
- **Pull, Push, Sync and New Worktree… no longer pick the first repository on their own.**
  With nothing to say which one was meant, they acted on the first repository in the
  workspace, so *GitTree: Push* could push a repository you were not looking at. They now
  ask too.
- **GitTree: Pull works on a branch that has diverged from its upstream.** With neither
  `pull.rebase` nor `pull.ff` set, git refuses to guess, and Pull failed with *A git
  operation failed*. It now merges, as IntelliJ's Pull does and as git did by default. Your
  own `pull.rebase`, `pull.ff` or `branch.<name>.rebase` still decides. When those allow
  only a fast-forward, it says so and offers **Update Project…**, and Sync stops instead of
  pushing.

### Fixed — a rebase conflict shows your side as Yours

- **During a rebase, Yours is your own commit again.** git replays your commits onto the
  other branch, so its "ours" is that branch and its "theirs" is your commit. GitTree
  showed them as git names them: the merge editor's **Yours** pane held the other branch's
  code, **Theirs** held your own change, and **Accept Yours** threw your change away. As in
  IntelliJ, the sides now follow you while a rebase is in progress. This applies to the
  panes, Accept Yours and Accept Theirs for a file, all files or a block, and the deleted-by
  labels. **Show Details** names the right commit: your commit being replayed for Yours,
  and for Theirs the cherry-picked or reverted commit rather than "revision unavailable".

### Fixed — the merge editor opens once and closes quietly

- **A double-click opens one merge editor.** Opening a conflicted file twice in quick
  succession, as a double-click in the Conflicts view does, opened two editors over the same
  three tabs. Each then asked about the other's panes as they closed: after **Apply**, three
  *"… is not resolved yet"* modals came in a row, and six after closing by hand.
- **Closing the merge editor no longer asks a question whose answers do the same thing.**
  *Resolve Later* and *Abort File* both discarded the partial result, though the first
  promised to keep it. Closing a pane now closes the editor. If conflicts had been resolved
  in it, one notification says the file is still conflicted and that this work was
  discarded, with **Reopen**.

### Fixed — a force push is offered only when one is needed

- **Rewording or dropping commits nobody has seen no longer asks for a force push.** After any
  history edit GitTree checked whether the upstream was still part of the branch, which is
  also false whenever a teammate has pushed. So rewording a local commit offered *Push
  --force-with-lease*, on `main` too. It now asks whether the edit replaced commits that were
  already on the upstream. If it didn't, nothing is said, because a normal pull and push will
  do.
- **A force push is not offered where it would do harm.** On a protected branch
  (`gittree.protectedBranches`) GitTree says the branch cannot be force-pushed. When the
  upstream also has commits the branch never brought in, it says a force push would delete
  them. The *Push (Force With Lease)* command refuses protected branches, as the Push dialog
  does. It also checks again when clicked: an offer clicked after the edit was undone says
  no force push is needed.
- **The force-push confirmation says what will happen,** and a push refused by
  `--force-if-includes` says why. The upstream has commits that were fetched but never
  brought in, so the message no longer says "fetch first", which sent you round in a circle.

### Fixed — Undo keeps your work, and history edits keep your staging

- **Undo after Drop Commit(s) or Squash Commits no longer throws away uncommitted work.** It
  ran `git reset --hard` to the commit before the edit: every change in the working tree that
  was not committed went with it, without a word. It also never checked that the branch was
  still where the edit left it, so an Undo clicked later from the notification centre dropped
  every commit made since. Undo now does what IntelliJ's does: it refuses once the branch has
  moved on (*Cannot undo drop: the repository has already been changed.*) or once the edit's
  commits are on a protected remote branch, and goes back with `git reset --keep`, which keeps
  every local change and refuses rather than overwrite one.
- **Staged changes stay staged.** Edit Commit Message, Drop, Squash, Fixup and Interactive
  Rebase let git's `--autostash` put local changes back, which unstages them all; the Undo
  of an edit unstaged them too, and turned a staged new file into an untracked one. Smart
  Checkout popped its stash without `--index`, and Undo Commit followed its soft reset with a
  plain `git reset`, unstaging everything else as well. Each now leaves the staging as it
  was. Only a file the operation itself changes in the commit you are on comes back
  unstaged, its content kept, and GitTree says which. Undo Commit leaves the commit's own
  changes staged, as IntelliJ's does, so a file it added stays added.

### Fixed — a new commit shows in the log

- **A commit made while the log is scrolled to the top now shows as its first row.** When
  history moved, the log put the row that had been at the top back at the top, so a commit
  made on top of it landed one row above the window: the list looked unchanged, apart from
  the branch label leaving the old first row. It happened with a commit from GitTree, the
  built-in Git extension or a terminal, and after **Refresh**. Now, as in IntelliJ, a log
  scrolled to the top stays at the top. One scrolled down keeps the first selected row on
  screen, or else the row at the top edge, exactly where it was. No frame shows the rows
  shifted on the way.
- **A commit made in a terminal shows within about a second even while something keeps
  writing files in the workspace.** Every file event restarted GitTree's wait for the
  repository to settle, so a dev server's log or a test run writing a few times a second
  held off every update. The commit, and anything else done outside GitTree, appeared only
  once the writing stopped.
- **A commit made from outside just after a GitTree operation is no longer missed.** For a
  second after each of its own operations, GitTree treats the repository's file events as
  its own. One from a commit made in a terminal in that second was dropped after GitTree
  had already re-read the repository, so the commit stayed out of the log and the rest of
  GitTree until something else changed.
- **Hiding and showing the panel while the log is re-reading no longer garbles the graph.**
  A re-read waits for a git operation in progress (a push, or a commit with slow hooks).
  If the panel was hidden and shown meanwhile, the same commits were read and laid out
  twice: an extra line ran beside the graph.

### Fixed — the Git tool window's Log tabs

- **Switching between two Log tabs no longer makes the window jump.** A tab behind another
  was laid out a tab strip taller than one in front. Each switch shrank the tab coming
  forward on screen, gave its commit list a second scrollbar for a moment, and redrew the
  graph stretched. Every tab is now laid out in the same box, so a switch changes only which
  one you see.
- **The commit list shrinks with its pane.** It used to grow with the pane but never shrink
  back, so a shorter panel left part of the list below the edge, behind a second scrollbar.
- **Choosing another repository in `Paths ▾` keeps the `Branch ▾` selection**, as IntelliJ
  keeps its filters when the roots change; it used to go back to HEAD. A branch the new
  repository does not have stays ticked, first in the list and marked *not in this
  repository*, and is left out of the log. When nothing selected is left, the log says
  *No commits matching filters*, names the missing branches, and offers **Reset filters**.
- After that switch, `Branch ▾` and the Branches pane list the new repository's branches.
  They used to keep the previous repository's until something changed a branch.

### Changed — the log's filter row and Date column

- **`Branch ▾`: `HEAD (Current)` and `All branches` are radio buttons**, in a block of their
  own above the branches, ruled off from them, and not scrolled away with the list. Each is
  the whole Branch filter on its own; the branches and tags below are ticked several at a
  time.
- **The filter dropdowns are compact.** Smaller chips with the `×` inside, saying what they
  filter in a few words: a user without the e-mail (`me` for you), a date as
  `Since 2026/10/31`, a path by its last part, and anything over 20 characters cut with
  `…`. Hover over a chip for its whole value. **`gittree.log.filterChips: full`** brings back
  the larger chips with every value written out.
- **The Date column reads `2026/09/05 15:07`**: year first, two digits each, a 24-hour
  clock. **`gittree.log.dateFormat: locale`** brings back IntelliJ's own, `9/5/2026 3:07 PM`
  in US English.

### Added — Presentation Settings ▸ Graph

The log's eye menu has **Graph**, first under *Show*: untick it to hide the coloured lanes
and commit dots and keep the message, its labels and the columns. It is also the
**`gittree.log.showGraph`** setting, on by default.

### Changed — no commit check is ticked until you tick it

**Analyze code** and **Check TODO**, in the Commit window's options (the gear beside Commit),
now start unticked, like Reformat code, Optimize imports and Cleanup. IntelliJ ticks those two;
GitTree no longer does, so a commit runs no check you did not ask for. A check you ticked
yourself, here or in Settings, stays ticked. *Run advanced checks after a commit is done* is
still ticked.

### Added — Add to VCS and Move to Another Changelist… for a repository's or a folder's new files

In the Commit window, right-clicking **Unversioned Files**, a repository's row under it, or the
Unversioned Files row under a repository now offers:

- **Add to VCS**: every new file there becomes versioned and moves to the default list.
- **Move to Another Changelist…**: the same, into the list you pick, or a new one. As in
  IntelliJ, the files are added to VCS in that list.

Those rows used to offer a changelist's actions, Rename, Delete and Set Active among them, which
make no sense on Unversioned Files; they are gone from there.

**Folder rows have a menu**, IntelliJ's, acting on every file in the folder: Add to VCS, Open
Changes, Move to Another Changelist…, Roll Back… and Add to .gitignore. They used to show VS
Code's Cut, Copy and Paste. For a folder git tracks nothing in, Add to .gitignore writes one rule
for the folder, `/.idea/`, rather than a line per file. A repository row (Repository ›
Changelist) also has Add to VCS and Move to Another Changelist….

- **Move to Changelist…** is now called **Move to Another Changelist…**, as in IntelliJ. With
  files of several repositories it offers each list once and makes it where it is missing, and it
  leaves out the list every file is already in.
- **Add to VCS** on a file already moved into a list leaves it in that list; it used to move it to
  the default one.
- A folder that appears in the Commit window, files moved to another list for one, now appears
  open, as new changelist and repository rows already did. One you closed stays closed.

### Added — the Commit window can put repositories first

With several repositories open, the Commit window's toolbar has **View Options**, IntelliJ's eye
before Expand all, and under **Group By** two choices:

- **Changelist › Repository**, as before and as IntelliJ shows it: each list at the top, each
  repository's share of it beneath.
- **Repository › Changelist**, GitTree's own: one row per repository with changes, its own
  Changes, your lists and Unversioned Files beneath, then folders and files as before. Ticking
  a repository ticks all of its changes, new files included. Its menu has New Changelist…,
  Shelve Changes… and Rollback… for that repository.

Switching keeps your place: the same files stay selected, the keyboard stays on the same row,
and the row you were looking at stays where it was on screen. Each grouping keeps its own
folders open or shut. The choice is saved for the workspace (`gittree.commit.groupBy`), and the
palette has *GitTree: Group Changes by Repository* and *by Changelist*.

A repository's row now shows **its branch** in a tinted label after its file count, as IntelliJ
does, in both groupings; the hover says what the branch tracks. Repositories are named and
ordered as the Repositories panel lists them, the Commit button's *Commit to api* too.

### Fixed — folding a folder moved the keyboard to another row

In GitTree's file trees, folding or opening a folder above the row the keyboard was on, or a
file appearing above it, left the keyboard on whatever row took that place. It stays on its own
row now, and moves to the folder when its row is folded away, as in VS Code's own trees.

### Fixed — the Commit window's repository rows wore their files' colour

With several repositories, each repository's row under **Changes** and **Unversioned Files**
was drawn as a folder in its files' status colour: a repository holding only new files was
green, one holding modified files took the modified colour, and two repositories looked alike.
A repository's row now wears the repository's own colour, a filled square as IntelliJ draws a
root, the same colour as its dot in the Repositories panel and its chip in the log's `Roots`.
It follows a light or a dark theme and `gittree.log.graphPalette`. Its name is plain text, and
its files keep their status colours.

### Fixed — a narrow Repositories panel cut the current branch's name first

- **The current branch's row** shrank only the branch's own name, so with its buttons showing
  it read `n origin/main`, and in VS Code's narrowest sidebar it was gone. What it tracks gives
  way first now. Below about 250px the row's hover buttons fold into `⋯`, whose menu has the
  rest; below about 190px the changed-file count and what the branch tracks go too. A
  repository's row in a workspace of several does the same.
- **A card's buttons** all shrank together as soon as they did not quite fit, to `U…` and
  `P…`. They drop their words instead: the first keeps its own longest, then each is an icon
  with its name on its hover, and none is cut off, down to 170px. A narrow card also leaves out
  who made the last commit, so its subject keeps more room.

### Changed — the Branches panel is the Repositories panel, its branches under tabs

The sidebar panel that lists every repository and then their branches is titled
**Repositories** now, since that is what it shows first. Its id is the same, so where you put
it and any keybinding you gave it stay. The opt-in tree it replaced is *Repositories (Tree)*.

Recent, Local, Remote and Tags were four sections stacked one under another, and they
overlap: every recent branch is a local one, and most local ones have a remote twin. They are
tabs now, one list at a time:

- **Each tab counts what it holds**, and the panel starts again on the tab last picked: Recent
  at first, or Local when nothing is recent yet.
- **Scrolled past, the tabs stay at the top** of the list, and a click there starts the new
  list right under them. On the tabs, `←` and `→` switch and `↓` goes into the list.
- **In a narrow sidebar the counts go first**, so every tab keeps its name.
- **The filter still searches every kind at once.** The tabs step aside while it does, and come
  back as they were.

### Fixed — Collapse All in the panel left the folders you had opened

It shut only the folders that start open, the one holding the checked-out branch and each
remote. A folder you had opened yourself stayed open. Now every folder of the tab on show
shuts.

### Fixed — file names in GitTree's own panes had lost their status colors

The file lists in the Log's Changed Files, the Commit window with its Shelf and Stash tabs, and
the Push, Rollback, Shelve, Unstash and merge-conflict dialogs show each file's name and icon in
its status color again, as IntelliJ does: modified, added, deleted, renamed. They had been plain
text since GitTree began shipping its own `gittree.color.*` colors. VS Code hands a webview a
theme color under its id with only the first dot replaced, `--vscode-gittree-color.added`, and
GitTree was reading `--vscode-gittree-color-added`. The Compare pane and the editor, which VS Code
draws itself, always had them.

### Added — the list a diff came from shows which file it is on

In the Log's Changed Files, the Commit window and the Compare pane, the name of the file whose diff
is on screen is now highlighted, the way VS Code highlights a name in a tree. It moves with the diff,
whether you walk with ↑ ↓ or ← →, open another file, or bring the diff's tab back, and it goes when
the diff is closed or another editor is in front. It does not depend on the selection: a walk over
several selected files leaves all of them selected, as IntelliJ's does, and the highlight still
says which one you are looking at.

### Fixed — the file you opened stayed lit after the walk had moved on

In the Log's Changed Files and the Commit window, the row you double-clicked kept a strong highlight
while the walk went on to other files. The file actually on screen was selected, but in the fainter
colour, so the old one looked current.

- **A row is lit for the keyboard only while the list has the keyboard**, as in VS Code's own lists.
  A list you are not in shows its selection and nothing else. That also stops the top row of a list
  you never clicked in looking selected.
- **The walk takes the keyboard with it**, so the arrow keys carry on from the file on screen.
- **Enter on a row you reached with the arrow keys selects it** as it opens it. The arrows only move
  the keyboard there, so the selection stayed a row away from the file you opened.

### Added — walking a commit from one file's changes to the next

In a diff opened from a commit's Changed Files, VS Code's own ↓ button and `Alt+F5` now carry on
into the next file, as IntelliJ's do, where they used to loop inside the same file. At the last
change a tooltip says **Press again to go to the next file** and which file that is, and the second
press goes there. ↑ does the same in the other direction, landing on the last change of the previous
file. At the end of the list it says so and stays put. Any diff GitTree did not open keeps VS Code's
behaviour, and `gittree.diff.goToNextFileAfterLastChange` turns this off.

Also in those diffs:

- **`←` and `→` in the toolbar** go to the previous and next file, `Shift+Alt+←` and `→` from the
  keyboard (`Cmd+Shift+Alt+←` and `→` on macOS).
- **One tab.** The next file replaces the one you were on, instead of leaving a tab behind per
  file. Keep the tab (double-click it) and the next file gets its own.
- **The tab says where you are** (`foo.ts (62c3e1a) 3/7`), and the list's selection follows the diff.
- **The order is the list's**, or only the rows selected when several are.
- **Added and deleted files are stops.** They used to be skipped, and clicking one opened it as a
  plain document with no way on. A file with no text change, such as a pure rename, is skipped by ↓,
  since VS Code greys that button out on it; `→` and clicking it still show it.

The same goes for Show Diff in the Push dialog.

### Added — the Commit window's changes walk the same way

Show Diff, double-clicking a row and Open Changes in its menu now open a diff you can walk with ↑ ↓,
`Alt+F5` and the `←` `→` buttons, across every changelist and repository, with Unversioned Files
last. With several rows selected it walks those, and a selected folder stands for its files.

This list changes as you work, so the walk follows it: a file that starts changing joins, and one
that is reverted or committed leaves. The file on screen stays up either way. The right side is the
real file, so you can edit as you go, and a tab you have edited stays open when you move on.

An untracked file now opens as a diff too, and so does one deleted from disk, instead of as a plain
document with no way on.

### Added — a branch's graph in a Log tab of its own, from the Branches panel

Right-click a branch in the Branches panel, local or remote, or a tag: **Show in New Log Tab** opens
its graph in a new tab of the Git panel's Log (`Log: release/2.0`) and leaves the tabs already open
as they were. Asked again, that tab comes forward instead of a second one. The item sits with the
other ways of looking at a branch, right after the checkout group, beside **Compare with 'main'**
and **Show Diff with Working Tree**. It used to be the menu's last item, as **Show in Git Log**, and
a branch several repositories have offered it only inside each repository's own submenu.

The log draws one repository at a time, so a branch several repositories have offers **Show in New
Log Tab ›** naming each of them. Two tabs showing one branch in two repositories say which is which,
in IntelliJ's words for a repository: `Log: on main in api` beside `Log: on main in web`. Any tab's
hover names its repository.

### Fixed — a click in a submenu did nothing

A click on an item in a submenu closed the menu and did nothing. This hit every repository's own
menu and **Tracked Branch** in the Branches panel, **Columns** in the log's Presentation Settings
and **Delete preset** in its saved filters. The keyboard worked.

### Added — one branch in every repository: Checkout across them, and New Branch from a common one

**Checkout Branch in All Repositories…** in the Branches panel's `⋯` and the Command Palette lists
every branch any repository has, local or remote, with where it is, and checks the one you pick
out in every repository that has it. A branch's own menu does the same: `release/2.0`, a local
branch in one repository and only on `origin` in three more, offers **Checkout in 4 of 5
repositories**. Where no local branch has the name, a new one is made tracking the remote branch.

The New Branch form has a **From** field: start the branch from `main`, `origin/main`, a tag or
any revision in every chosen repository, or leave it empty for each one's own current branch.
Repositories without that start point cannot be ticked.

Both go on past a repository that fails, and ask once about uncommitted changes in the way —
Smart Checkout, Force Checkout, or leave those repositories where they are — then say in one
notification what happened in each.

### Fixed — an operation across repositories could wait for good on one with conflicts

A repository with conflicts to resolve and no merge behind them, as a stash or Smart Checkout
that did not go back cleanly leaves it, holds its git operations until they are resolved. Update
Project, a checkout across repositories and New Branch queued one there anyway and waited, and
every repository after it waited too. They now skip it and say why: *it has conflicts to
resolve*.

### Changed — Update Project fetches first, and one repository's trouble no longer stops the rest

`Ctrl+T` across several repositories now fetches them all first, then asks Merge or Rebase with
what each one will really pull: `main ← origin/main · 3 to pull · 1 to push`, `up to date`, or
why it could not be fetched. It used to show the counts from the last fetch, `0 behind`, and
then pull commits anyway. With nothing to pull anywhere it asks nothing and says so. One
repository on its own is fetched first the same way.

A repository whose merge stops on conflicts, or whose fetch fails, no longer stops the others.
Every repository with something to pull is updated, and one notification says what became of
each, problems first, with **Show Conflicts** and **Show Details**.

### Fixed — Update Project said `git exited with code 1`

A merge that stopped on conflicts, and other failures git explains on its standard output, were
reported as `git exited with code 1`. The result now says what happened: *The merge stopped on
conflicts in src/app.ts*, *Couldn't fetch from origin: Could not resolve host: github.com*,
*Your local changes to the following files would be overwritten by merge: notes.txt*. The
conflict's own notification no longer appears alongside it, and with several repositories open
it names the repository.

### Added — comparing branches walks the same way

`Compare with 'X'` now opens a Log tab of its own over both branches, as the log has long been able
to do, instead of a list of commits in the sidebar. Each commit has its Changed Files and its menu,
and a line above the commits says how many each branch has alone.

**Show Files Diff** on that line, and **Show Diff with Working Tree** in a branch's menu, list every
file that differs in a Compare pane in the sidebar. A click opens the diff, and ↑ ↓, `Alt+F5` and the
`←` `→` buttons walk the whole list, or the rows selected when there are several. They used to open
VS Code's multi-diff page, which **Show All Files in Multi-Diff** on the pane still does.

Against the working tree the right side is the real file, so you can edit as you go.

### Fixed — clicking a commit in Compare left an unsaved document behind

Each click opened the commit as raw `git show` text in a new unsaved `Untitled` tab, which then asked
to be saved when closed. A commit now shows in the log like any other.

### Fixed — Compare with and Show Diff with Working Tree in the Command Palette

Run from the palette, with no branch to go on, they failed on a branch called `undefined`. They are
now only offered on a branch.

### Fixed — Show Diff in the Commit window compared against the wrong side

With changelists, Show Diff compared with the index, while the preview pane and the commit itself
use `HEAD`. A file you had staged by hand showed no changes at all. It now compares with `HEAD`.
With staging it opens on what is not staged yet, and on what is staged for a file with nothing else.

### Fixed — GitTree's next and previous change arrows never appeared

They were contributed to a menu VS Code does not have, which it drops without a word, so without
the IntelliJ keymap the cross-file navigation could not be reached at all. VS Code's own
arrows do it now, so there are no second arrows to find.

### Fixed — a binary file from the log opened an error page

An image opened as *The editor could not be opened due to an unexpected error*, and any other
binary file as unreadable text. They now read as `Binary file, 79 bytes (7d1ad7a)` on each side, or
`(working tree)` for one not in git yet.
Seeing images side by side, as IntelliJ does, is not there yet.

### Fixed — a new branch no longer pushes onto the branch it started from

A branch created from a remote branch under a new name, such as `mine` from `origin/develop`,
was left tracking that remote branch. Its first push created nothing on the remote and put its
commits on `develop`.

A new branch now tracks nothing, so its first push creates a branch of its own. The exception is
a branch that takes the remote branch's own name, such as `develop` from `origin/develop`. It
tracks that branch, as Checkout on a remote branch always has. This applies wherever a branch is
created (the panel's form, the input box and New Worktree), whatever `branch.autoSetupMerge`
says, and the panel's form tells you which of the two it will do.

A branch created before this fix keeps tracking until you stop it. In the panel, one that tracks a
remote branch of another name now shows `→ origin/develop` on its row.

### Added — Stop Tracking

You can now remove the link between a local branch and the remote branch it tracks. The branch
and the remote branch both stay, and the next push offers a branch of the branch's own name. It
works on a branch whose remote branch was deleted, too. The notification has **Undo** while the
remote branch still exists.

* In the Branches panel: **Stop tracking** on a branch's card, and in its right-click and `⋯`
  menus.
* In the branches popup, the branch trees and the log's Branches pane: a row in the branch's menu.
* Across several repositories: *Stop tracking in all 3 repositories*.
* After a rename: a button on the notification.

### Fixed — renaming a branch can no longer delete another branch on the remote

After renaming a tracked branch, GitTree offered to push the new name and delete the old one on
the remote. The button named the old local branch, but what it deleted was the remote branch being
tracked. For `mine` tracking `origin/develop`, that meant deleting `develop`. The offer now
appears only when the remote branch has the old name.

The offer is now a button on the *renamed* notification, instead of a second message that held
the operation open until it was answered.

### Fixed — a failed action in the Branches panel says so

An action run on a single repository from the panel, such as Checkout or Delete, failed in
silence: the row simply stayed as it was. It now shows git's reason.

### Fixed — a branch tells you when it is not published or just not tracked

A branch with no upstream was always called *Not published*, even with a remote branch of its own
name. The panel now says *Not tracking origin/x* for that case. A card's buttons also update when
a branch stops or starts tracking, so **Update** no longer lingers on one with nothing to update
from.

### Fixed — the opt-in Branches tree's right-click menu works

In the Branches tree behind `gittree.sidebar.extraViews`, every entry in a branch's right-click
menu did nothing. They all act on the branch now.

### Fixed — Clean Up's Restore brings back tracking

**Restore** on the Clean Up Branches notification put each branch back without its upstream. It
now tracks what it tracked, if the remote branch still exists.

### Changed — the Branches panel, redesigned

The sidebar's Branches panel was IntelliJ's branches popup left standing open:
* action rows above the list;
* a branch row that did nothing when clicked;
* a flat menu as the only way to act;
* with several repositories, a tree that listed every shared branch once per repository.

It has been rebuilt around three questions.

**Where am I?** With several repositories, the panel starts with one row for each. Each row
shows:
* what the repository has checked out;
* how many commits there are to pull (↓) and to push (↑);
* how many files have changed.

Hovering a repository row shows Update, Push, Fetch and its menu. With a single repository, the
first row is the current branch. A repository in the middle of a merge, rebase, cherry-pick or
revert shows a banner with **Resolve…**, **Continue** and **Abort**.

**Where can I go?** The branches come next, in this order:
* the starred branches and the ones used lately;
* every local branch, in folders;
* the remote branches and the tags, which start closed.

Each row shows its ↓ ↑ counts and how long ago its last commit was. A chip marks a branch that
is already **merged** into the main branch, or whose remote branch is **gone**.

With several repositories, each branch name is one row however many of them have it. Coloured
dots on the row show which repositories have the branch: filled where it is checked out. Its
actions say how many repositories they will touch, for example *Checkout in 2 repositories*.
Clicking a repository shows only its branches; Ctrl+click adds another.

**What can I do with it?** Clicking a branch never changes anything. It opens the branch's card,
which shows:
* its last commit and author;
* where it stands against the remote branch it tracks;
* how far it is ahead of, or behind, what is checked out;
* the two or three actions that fit. Usually that is **Checkout** and **Merge into main**,
  **Delete** once it is merged, or **Update** and **Push…** for the current branch.

Hovering a row shows Checkout, a star and `⋯`. Right-click shows every action, with real
submenus: one for the tracked branch and, with several repositories, one per repository. You can
also drag a branch onto another to merge or rebase it.

Also new:
* **One filter for everything.** Typing anywhere in the panel starts it, matching letters are
  highlighted, and when nothing matches it offers to create the branch.
* **New Branch is a form in the panel.** It has a name field, a Check it out box and, with
  several repositories, a choice of which ones. It says what would make Create fail before you
  press it.
* **Clean Up Branches…** lists the branches that look finished — merged, or their remote branch
  deleted — and deletes the ones you tick. The notification afterwards offers **Restore**.
* **Show in Git Log** opens a branch's history in a Log tab of its own.
* A repository has the same colour here as in the log's *Roots*.

The separate Repositories section is now hidden by default, since the panel lists the
repositories itself. Turn on `gittree.sidebar.extraViews` to bring it back.

### Fixed — the first load of the day no longer waits on maintenance

Once a day per repository, opening the Log started a `commit-graph` write, the
file that speeds up history walks. GitTree treated that write like a commit or a
checkout, and nothing else in that repository could read until it finished: not
the log's first page, the changed files, the branches or the commit details. A
large history took seconds, a very large one about a minute, and a
*commit-graph maintenance* notification appeared on top.

The write changes nothing you can see, so it now runs in the background. It
starts a minute after the log opens, waits while any git operation runs, and
never holds up a read.

### Fixed — the graph no longer flashes when history moves

After a cherry-pick, a push, a commit or a fetch, the log emptied itself and
then painted the graph again, and the selected commit's details went with it.
Now the graph, its scroll position and the selection stay on screen until the
new rows replace them. An operation that moves history several times, such as a
cherry-pick of several commits, causes one re-read when it is done instead of
one flash per step. The **Refresh** button re-reads in place the same way, as
IntelliJ's does.

### Fixed — typing in the log's search box no longer lags

Every keystroke started a new history search, so typing a word ran one search
per letter, each slower than the last. The search now runs once typing pauses,
or at once when you press Enter.

### Fixed — the log shows the branch the repository is on

The log could show *HEAD → master* on a repository that was on another branch,
typically one added to the workspace while the log showed a different one. Its
page cache only noticed when HEAD moved to a different commit. A new or renamed
branch at the same commit went unnoticed. The cache now notices any change of
branch or ref.

### Fixed — Refresh updates the pending-changes count

Pressing **Refresh** in the commit window while a refresh was already under way
was answered by that refresh, which had started before your change and so could
not see it. The badge kept its old number. Refresh now waits for a read that
starts after you press it.

### Fixed — Update shows one progress, and counts what it brings in

- **One progress.** The progress notification for **Update** closed after the
  fetch and opened again for the merge. It now stays up for the whole update
  and says which step it is on.
- **The right count.** **Update** could say *Already up to date* and then merge
  new commits. It counted only what its own fetch downloaded, so commits that
  an earlier fetch had brought down were not counted. It now counts everything
  the upstream has that your branch does not.

### Fixed — buttons show that they were clicked

- **Toolbar buttons** now darken and their icon shrinks slightly while you hold
  the mouse button, as VS Code's own toolbars do.
- **Refresh and Fetch buttons** spin until their work is done. This covers
  Refresh in the commit window, the log, the Worktrees pane and the Shelve
  dialog, and Fetch in the Branches view's header. They spin for at least a
  moment even when the work is instant, and a second click while they spin is
  ignored.

### Added — a notification when an operation finishes

Many operations used to finish in silence: the status bar spinner stopped, and nothing said
whether anything had happened. Clicking **Fetch** in the Branches view was the clearest case.

Now an operation you start ends with a notification in IntelliJ's words. For example:

- *Fetch successful*, naming the remote branches it pruned;
- *Pulled 3 commits from origin/main: 7 files changed*, or *Already up to date*;
- *2 files committed: Fix the parser*;
- *Checked out main*, *Merged feature to main*, *Rebased main on develop*;
- *Branch x was created*, *Branch x was renamed to y*;
- *Created tag v1*, *Reset successful*;
- *Files stashed successfully*, *Stash successfully applied*, *Changes shelved successfully*;
- *Rebase successful*, and *Abort rebase succeeded*.

Some notifications carry IntelliJ's follow-up buttons:

- **Deleted branch x** has **Restore**, which brings the branch back where it was, and
  **Delete Tracked Branch** while it tracked one. These replace the question GitTree used
  to ask after a delete.
- **Commit message changed** has **Undo**.

A branch action run in all repositories at once says so once, not once per repository.

Background work, such as automatic fetch, stays silent, as it does in IntelliJ.

### Changed — Push works the way IntelliJ's does

Every Push now opens the Push dialog first, as IntelliJ's does:

- `Push…` (Ctrl+Shift+K)
- a branch's `Push…`, which used to push at once
- the log's `Push All up to Here…`, which used to push at once
- `Commit and Push…`

The dialog is rebuilt on IntelliJ's layout.

- **The left side** lists each repository as `feature → origin : feature`, with a green
  **New** when the remote does not have that branch yet. The commits to push sit under it.
- **The right side** shows the changes of the commits you select, with the details of one
  selected commit below.
- **To push somewhere else**, click the target branch and type another name. The field
  suggests branches you pushed to before and the remote's branches. **Set upstream** makes
  the new target the branch's upstream.
- **To pick another remote**, click the remote name. A repository without a remote offers
  **Define remote**.
- **With several repositories**, each has a checkbox, and **Edit all targets** changes every
  target at once.
- **Force Push** asks first, with **Don't warn about this target**. It is not offered for
  protected branches: `master` and `main` by default, set with the new
  `gittree.protectedBranches` setting.
- **Run Git hooks** appears only when a repository has a pre-push hook, and starts ticked
  every time. The `gittree.push.runHooks` setting is gone.

The direct **Push** and **Push (Force With Lease)…** commands no longer appear in the
Command Palette; **Push…** is the one Push there, as in IntelliJ.

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
