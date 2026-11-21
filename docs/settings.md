# Geet settings

<!-- GENERATED FILE — do not edit by hand. Derived from package.json
     `contributes.configuration`; regenerate with `npm run docs:settings`.
     test/unit/docs/settingsDoc.test.ts fails when this file is stale. -->

All settings live under the `geet.` namespace: Geet was called GitTree
before 0.1.0, and its settings kept the name. Geet owns its own views,
change bars and commit window, so nothing here depends on — or changes —
the built-in Git extension.

## Geet

### `geet.gitPath`

Path to the git executable. Falls back to the built-in `git.path` setting, then PATH, then well-known install locations.

- Type: `string \| null` · Default: `null`
- Scope: `machine-overridable`

### `geet.trace`

Log every git invocation (argv, duration, exit code — never file contents) to the "Geet" output channel, and reveal debug commands.

- Type: `boolean` · Default: `false`

### `geet.repositoryScan.maxDepth`

How many directory levels below each open folder to search for repositories, so that opening one folder full of checkouts finds them all. 1 searches the folder's immediate children, 0 searches nothing below the folder itself, and -1 searches without limit.

- Type: `number` · Default: `1`
- Minimum: `-1`

### `geet.repositoryScan.ignoredFolders`

Folder names the repository search never descends into. Matched against the folder name alone, where * and ? are wildcards.

- Type: `array` · Default: `["node_modules"]`

### `geet.decorations.fileExplorer`

Show Geet's status colours and letter badges on files wherever VS Code shows a file's decorations: the Explorer, editor tabs, breadcrumbs and VS Code's own Source Control view. Off by default: VS Code's built-in Git extension draws the same, and with both, every badge shows twice (U, U). Turn it on if you disable the built-in Git extension.

- Type: `boolean` · Default: `false`

### `geet.terminalAuth`

Export Geet's git credential helper (GIT_ASKPASS) into integrated terminals so command-line git prompts are answered by VS Code.

- Type: `boolean` · Default: `false`
- Scope: `window`

### `geet.keymap.intellij`

Enable the optional IntelliJ-flavored keybinding set (Ctrl+K commit, Ctrl+Shift+K push, Ctrl+T update, Alt+9 log, Ctrl+Alt+Z rollback). See docs/keyboard.md for conflicts with VS Code defaults.

- Type: `boolean` · Default: `false`

### `geet.whatsNew.enabled`

Show a one-time notification with the changelog when Geet updates to a new minor version.

- Type: `boolean` · Default: `true`

### `geet.telemetry.enabled`

Allow Geet usage telemetry (activation timing, operation duration buckets, error kinds — never repository names, paths, shas or content). Both this AND VS Code's telemetry.telemetryLevel must allow. No telemetry backend is currently configured, so nothing is transmitted either way.

- Type: `boolean` · Default: `false`

### `geet.sidebar.extraViews`

Show the Repositories (Tree), Branches (Tree), Worktrees, Local History and Stashes tree views in the Geet sidebar. Off by default: the Repositories panel lists the repositories itself, and IntelliJ keeps the other surfaces in the Git tool window, the branches popup and the Stash tab.

- Type: `boolean` · Default: `false`

### `geet.statusBar`

Shape of the Geet status-bar widget. VS Code’s built-in Git extension already shows a branch name and ahead/behind counts, so by default Geet contributes a compact button that opens the branches popup rather than a second readout beside it.

- Type: `string` · Default: `"auto"`
- Values:
  - `auto` — A compact button while the built-in Git extension is drawing its own branch readout; the full widget when it is absent or disabled.
  - `button` — Always the compact button: a constant-width Geet button that opens the branches popup. Branch, upstream and exact counts are in its tooltip.
  - `full` — Always the full widget: branch name plus ahead/behind counts, capped at 99+ the way IntelliJ caps its own. Duplicates the built-in Git widget if that one is also shown.
  - `off` — No Geet status-bar widget at all.

### `geet.notifications.durationSeconds`

How many seconds Geet's messages with nothing to click ("Fetch successful", "Checked out main") stay on screen, counted while VS Code is in front; a long one gets a little longer, up to twice this. VS Code cannot hide a notification on a timer and still keep it in the Notifications list (the bell in the status bar), so these leave no entry there: the "Geet" output keeps a copy. 0 shows them as ordinary notifications instead, which VS Code hides after about 10 seconds and keeps in that list. Messages with buttons, warnings and errors are always ordinary notifications.

- Type: `number` · Default: `5`
- Minimum: `0`

## Geet Source Control

### `geet.quickDiff.base`

What the editor gutter bars compare against: the index (IntelliJ behavior — bars show unstaged edits) or HEAD (bars show all uncommitted edits).

**Deprecated:** Renamed to `#geet.changeBars.base#`. The old key is still honoured.

- Type: `string` · Default: `"index"`
- Values:
  - `index`
  - `head`

### `geet.diff.goToNextFileAfterLastChange`

In a diff opened from a list of files, such as a commit's Changed Files, Next Change at the last change of a file says that pressing it again goes to the next file, and Previous Change does the same at the first change. Off: VS Code's own behaviour, wrapping to the other end of the same file.

- Type: `boolean` · Default: `true`

### `geet.changeBars.enabled`

Draw Geet's change bars beside changed lines, at the text's edge. Off by default: VS Code's built-in Git draws its own in the gutter, and with both every changed line has two. Geet's change actions work either way, at the cursor: `Geet: Show Change Actions` (`Ctrl+Alt+G H`). Turn it on if you disable the built-in Git extension, or VS Code's own bars (`scm.diffDecorations`).

- Type: `boolean` · Default: `false`

### `geet.changeBars.base`

What Geet measures its change bars against: the index (bars show unstaged edits, as in IntelliJ) or HEAD (bars show every uncommitted edit).

- Type: `string` · Default: `"index"`
- Values:
  - `index`
  - `head`

### `geet.changeBars.maxFileLines`

Files longer than this get no change bars. The line diff is quadratic in the worst case, and a stalled editor is worse than a missing bar.

- Type: `number` · Default: `20000`
- Minimum: `100`

### `geet.changeBars.hoverActions`

Hovering a changed line shows its previous text with Rollback, Stage and Commit View links. Off by default: IntelliJ shows nothing on hover, and the popup sits on top of the language server's own hover on exactly the lines you are editing. The same actions are always one key away at the cursor with `Geet: Show Change Actions` (`Ctrl+Alt+G H`).

- Type: `boolean` · Default: `false`

### `geet.autofetch.enabled`

Periodically run `git fetch` in the background so incoming/outgoing counts stay fresh.

- Type: `boolean` · Default: `false`

### `geet.autofetch.intervalSeconds`

Auto-fetch interval in seconds.

- Type: `number` · Default: `180`
- Minimum: `30`

### `geet.branches.recentCount`

How many recent branches (by checkout frequency and recency) the Branches popup shows.

- Type: `number` · Default: `5`
- Minimum: `0`

### `geet.branches.showIncomingOutgoing`

Show incoming (↓) and outgoing (↑) commit counts beside branches in the branches popup and the Branches panel, and beside repositories in the Repositories panel. Toggled from the popup's header and the More Actions menu (the `⋯` button) of the Branches panel or the Repositories panel.

- Type: `boolean` · Default: `true`

### `geet.branches.showTags`

List tags in the branches popup, as the Branches panel's Tags tab, and as a Tags node in the Branches (Tree) view and the log's Branches pane. Toggled from the log's Branches Pane Settings menu (the gear button) and the Branches panel's More Actions menu (the `⋯` button).

- Type: `boolean` · Default: `true`

### `geet.branches.groupByFolder`

Group branches into folders on `/` in the Branches panel (`feature/login` under `feature`). Toggled from the panel's More Actions menu (the `⋯` button).

- Type: `boolean` · Default: `true`

### `geet.branches.showRepositoryDots`

With several repositories in view, show a dot per repository on each branch row of the Branches panel: filled where the branch is checked out, ringed where it exists, small where it does not. The dots take the place of the row's words for the same (in api, web; in all 20). A branch's card lists the same per repository either way. Toggled from the panel's toolbar (the dots button), its More Actions menu (the `⋯` button), and the command Geet: Toggle Repository Dots.

- Type: `boolean` · Default: `false`

### `geet.smartCheckout.behavior`

When a checkout is blocked by local changes: ask (IntelliJ-style dialog), auto (always smart-checkout via stash), or never (just report).

- Type: `string` · Default: `"ask"`
- Values:
  - `ask`
  - `auto`
  - `never`

### `geet.cherryPick.recordOrigin`

Append the "(cherry picked from commit …)" trailer (-x) to cherry-picked commit messages.

- Type: `boolean` · Default: `false`

### `geet.pushSafety.afterRewrite`

After a successful history rewrite on a branch with an upstream: offer Push --force-with-lease (ask) or stay quiet (never). Plain --force is never used.

- Type: `string` · Default: `"ask"`
- Values:
  - `ask`
  - `never`

## Geet Merge

### `geet.merge.resultMode`

Where the center Result pane lives during a 3-pane merge.

- Type: `string` · Default: `"virtual"`
- Values:
  - `virtual` — A virtual result document — the conflicted file on disk stays untouched until Apply.
  - `markers` — Edit the real conflicted file in place (fallback for language servers that require on-disk files).

### `geet.merge.conflictsDialog`

Show the "Files Merged with Conflicts" dialog when an operation produces conflicts. The Conflicts view remains available either way.

- Type: `boolean` · Default: `true`

### `geet.merge.autoResolveWhitespace`

Magic Wand: when one side changed only whitespace, take the substantive side automatically.

- Type: `boolean` · Default: `true`

## Geet: Stash

### `geet.stash.includeUntrackedDefault`

Pre-select "Include untracked files" in the Stash Changes flow.

- Type: `boolean` · Default: `true`

### `geet.stash.combineWithShelf`

Show stashes inside the Shelf tab instead of their own Stash tab (IntelliJ: "Combine stashes and shelves in one tab").

- Type: `boolean` · Default: `false`

## Geet: Shelf

### `geet.shelf.path`

Custom directory for shelved patches (must be writable). Empty = the extension's global storage. Shelves always live outside the repository, so they survive deleting or re-initializing it.

- Type: `string` · Default: `""`

### `geet.shelf.showUnshelved`

List shelved changes that were already unshelved but kept (IntelliJ's greyed entries).

- Type: `boolean` · Default: `false`

## Geet: File Status Colors

### `geet.colors.added`

Override for added files in Geet's own views (hex like #81b88b or a CSS color name). Empty follows the theme's gitDecoration colors.

- Type: `string` · Default: `""`

### `geet.colors.modified`

Override for modified files in Geet's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `geet.colors.deleted`

Override for deleted files in Geet's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `geet.colors.renamed`

Override for renamed files in Geet's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `geet.colors.untracked`

Override for untracked files in Geet's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `geet.colors.conflicted`

Override for conflicted files in Geet's own views. Empty follows the theme.

- Type: `string` · Default: `""`

## Geet Commit

### `geet.commit.paradigm`

How commits are assembled: IntelliJ-style changelists (index-bypassing checked-file commits) or native git staging.

- Type: `string` · Default: `"changelists"`
- Scope: `window`
- Values:
  - `changelists`
  - `staging`

### `geet.commit.groupBy`

How the Commit window arranges its changes. The window's View Options › Group By saves it for the workspace. With one repository there are no repository rows, so `changelist` and `repository` look the same.

- Type: `string` · Default: `"none"`
- Scope: `window`
- Values:
  - `none` — No changelist rows: every changed file under its repository, as VS Code's Source Control view lists them. Each file shows its status letter; a file Git does not track yet is in italics. Changelists still exist; the window just does not show them.
  - `changelist` — Changelists at the top, each repository's share of a list beneath it, as IntelliJ shows them.
  - `repository` — Repositories at the top, each with its own changelists beneath it.

### `geet.commit.groupByDirectory`

Show folder rows over the Commit window's files, as IntelliJ's Group By › Directory does. Off: one list of files, each with its folder after its name.

- Type: `boolean` · Default: `false`
- Scope: `window`

### `geet.commit.signoff`

Append a Signed-off-by trailer (git commit -s) to every commit.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.reformat`

Pre-commit: reformat only the modified line ranges of committed files.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.optimizeImports`

Pre-commit: organize imports in committed files.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.cleanup`

Pre-commit: run source.fixAll code actions on committed files.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.analyze`

Pre-commit: wait for diagnostics and warn when committed files have problems.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.analyzeSeverity`

Diagnostic severity that triggers the analyze warning.

- Type: `string` · Default: `"error"`
- Values:
  - `error`
  - `warning`

### `geet.commit.checks.todo`

Pre-commit: warn about TODO-like markers on newly added lines.

- Type: `boolean` · Default: `false`

### `geet.commit.checks.todoPattern`

Regular expression for the TODO check (applied per added line).

- Type: `string` · Default: `"\\b(TODO|FIXME)\\b"`

### `geet.commit.checks.cleanupKind`

Code-action kind the Cleanup check applies — the "profile": source.fixAll runs every provider, source.fixAll.eslint only ESLint.

- Type: `string` · Default: `"source.fixAll"`

### `geet.commit.checks.deferAdvanced`

Run the advanced checks (Analyze code, Check TODO) after the commit and report what they find in a notification: failed checks will not prevent a commit. Off by default, so a ticked advanced check runs before the commit, and a finding asks whether to commit anyway. IntelliJ has it on.

- Type: `boolean` · Default: `false`

### `geet.commit.messageGeneration.enabled`

Show Generate Commit Message in the Commit window. A language model that VS Code has (GitHub Copilot's, or one you added under Chat: Manage Language Models) writes the message for the changes you are about to commit; those changes are sent to it. Also hidden while VS Code's own AI features are off (chat.disableAIFeatures).

- Type: `boolean` · Default: `true`

### `geet.commit.messageGeneration.model`

The language model that writes commit messages, as vendor/id (for example copilot/gpt-4.1). Empty: the only model there is, or, with several, the one you choose the first time. The command Choose the Model for Commit Messages… lists them.

- Type: `string` · Default: `""`

### `geet.commit.messageGeneration.instructions`

Your own instructions for generated commit messages, which come before Geet's where they differ: a format, a language, a length. $GIT_BRANCH_NAME stands for the current branch, as in IntelliJ.

- Type: `string` · Default: `""`

## Geet Log & Blame

### `geet.log.sort`

Default sort for the Git log tool window.

**Deprecated:** Has no effect: each Log tab keeps its own sort, chosen under the tab's Graph Options (**By Commit Date** or **Topologically**), and a new tab starts by commit date.

- Type: `string` · Default: `"date"`
- Values:
  - `date`
  - `topo`
  - `intelli`

### `geet.log.graphPalette`

Color palette for the commit graph lanes.

- Type: `string` · Default: `"default"`
- Values:
  - `default` — Hue-cycled palette matching the editor theme.
  - `colorBlind` — Okabe–Ito color-blind-safe palette (distinct under deutan, protan and tritan vision).

### `geet.log.showTagNames`

Show tag names in the commit list. When off, a commit's tags are drawn as a tag icon without a name, and hovering over it shows their names. Toggled from the log's Presentation Settings menu (the eye button).

- Type: `boolean` · Default: `false`

### `geet.log.compactReferences`

Compact References View: draw a commit's branches and tags as one label, named after the first, with one colour per kind in its icon. When off, each branch gets its own label. Toggled from the log's Presentation Settings menu (the eye button).

- Type: `boolean` · Default: `true`

### `geet.log.referencesOnLeft`

References on the Left: draw a commit's branch and tag labels before its message instead of at the end of the message column. Toggled from the log's Presentation Settings menu (the eye button).

- Type: `boolean` · Default: `false`

### `geet.log.columns.author`

Show the Author column in the commit list. Toggled from the log's Presentation Settings menu, under Columns.

- Type: `boolean` · Default: `true`

### `geet.log.columns.date`

Show the Date column in the commit list. Toggled from the log's Presentation Settings menu, under Columns.

- Type: `boolean` · Default: `true`

### `geet.log.columns.hash`

Show the Hash column (the first eight characters of each commit's hash) in the commit list. Toggled from the log's Presentation Settings menu, under Columns.

- Type: `boolean` · Default: `false`

### `geet.log.showGraph`

Draw the commit graph, its coloured lanes and commit dots, beside each commit's message. When off, the commit list shows the message, the branch and tag labels and the columns only. Toggled from the log's Presentation Settings menu (the eye button).

- Type: `boolean` · Default: `true`

### `geet.log.dateFormat`

How the log's Date column writes each commit's date and time. Also under Presentation Settings ▸ Date Format.

- Type: `string` · Default: `"YYYY/MM/DD HH:mm"`
- Values:
  - `YYYY/MM/DD HH:mm` — Year first, two digits for everything else, 24-hour clock: 2026/10/29 14:19. The same in every language.
  - `pretty` — As IntelliJ's log writes dates: Moments ago, 5 minutes ago and 1 hour ago within the hour, then Today 2:19 PM and Yesterday 2:19 PM, and older dates in the system's short date and time.
  - `locale` — The system's short date and time for every date, as IntelliJ writes them with its pretty formatting off: 10/29/2026 2:19 PM in English (US). On Windows the Region settings' formats; elsewhere VS Code's display language's.

### `geet.log.filterChips`

How the log's Branch, User, Date and Paths filters show what they filter.

- Type: `string` · Default: `"compact"`
- Values:
  - `compact` — Small, with each value cut short: a user without their e-mail, a date as Since 2026/10/31, and anything over 20 characters ending in …. Hover over a filter to read its whole value.
  - `full` — Larger, with every value written out in full.

### `geet.log.issuePattern`

Regular expression for issue keys in commit messages (e.g. [A-Z]+-\d+). Empty disables issue linkification.

- Type: `string` · Default: `""`

### `geet.log.issueUrl`

URL template for matched issue keys; $0 is replaced with the match (e.g. https://tracker.example.com/browse/$0).

- Type: `string` · Default: `""`

### `geet.log.filterPresets`

Saved log filter presets (managed by the Saved filters toolbar menu).

- Type: `array` · Default: `[]`

### `geet.log.console.limit`

Maximum number of git commands kept in the Console tab's history (read at startup).

- Type: `number` · Default: `2000`
- Minimum: `100`

### `geet.blame.heatmap`

Shade blame annotations by commit age, newest strongest. Commits are ranked within the file, matching IntelliJ's annotation colouring.

- Type: `boolean` · Default: `true`

### `geet.blame.format`

Blame column format. Placeholders: ${author|N}, ${date|relative}, ${sha|N}.

- Type: `string` · Default: `"${author|12} ${date|relative} ${sha|7}"`

## Geet Local History

### `geet.localHistory.enabled`

Record Local History snapshots around destructive git operations (the failsafe for reset --hard, rebase, checkout over dirty files, …).

- Type: `boolean` · Default: `true`

### `geet.localHistory.maxSizeMb`

Storage budget for Local History blobs. Oldest snapshots are garbage-collected first when over budget.

- Type: `number` · Default: `500`
- Minimum: `10`

### `geet.localHistory.retentionDays`

Snapshots older than this are garbage-collected (the most recent snapshot is always kept).

- Type: `number` · Default: `30`
- Minimum: `1`

### `geet.localHistory.maxFileSizeKb`

Files larger than this are recorded as metadata-only stubs instead of full content.

- Type: `number` · Default: `1024`
- Minimum: `1`

### `geet.localHistory.snapshotOnSave`

Also record a snapshot on file save (debounced 30s per file). Off by default — VS Code's native Local History already covers saves.

- Type: `boolean` · Default: `false`

### `geet.localHistory.taskLabels`

Record a labeled snapshot when a build/test task finishes, so states like "after the last green test run" are easy to find.

- Type: `boolean` · Default: `true`

## Geet: Dialogs

### `geet.update.strategy`

What Ctrl+T (Update Project) does. "Ask every time" asks Merge or Rebase and offers the last answer first; choosing "Don't Ask Again" on the update's result writes that strategy here. A branch's Update never asks: it uses this strategy, or your last answer while this is "Ask every time".

- Type: `string` · Default: `"ask"`
- Values:
  - `ask` — Ask Merge or Rebase on every update.
  - `merge` — Merge incoming changes into the current branch.
  - `rebase` — Rebase the current branch on top of incoming changes.

### `geet.dialogs.showCommandLine`

Show the dim "will run: git …" line in Geet's dialogs, so the flags behind each option stay legible.

- Type: `boolean` · Default: `true`

### `geet.push.autoUpdateIfRejected`

Auto-update if push of the current branch was rejected: when the remote has commits the branch does not, update it with your last Merge/Rebase answer and push again, without asking. Off asks Merge or Rebase first, as IntelliJ's Push Rejected dialog does; choosing "Don't Ask Again" on the result turns this on. It still asks when rebasing would flatten merge commits you have not pushed.

- Type: `boolean` · Default: `false`

### `geet.push.updateAllRepositoriesIfRejected`

Update all repositories: when a push is rejected and you choose Merge or Rebase, also update every other repository of the workspace that tracks a remote branch, as the Update all repositories checkbox of IntelliJ's Push Rejected dialog does. Every update runs before anything is pushed again, and nothing is pushed again unless all of them went through. Off updates only the repositories whose push was rejected.

- Type: `boolean` · Default: `true`

### `geet.push.showDialog`

Show the Push dialog: every Push (Push…, a branch's Push…, Push All up to Here… and Commit and Push) opens the Push dialog, so you can review the commits and where they go before anything leaves your machine — as IntelliJ's Push does. Off pushes straight away what the dialog would have pushed: each branch to the branch it tracks, and a branch that tracks nothing to a new branch of its name, which it then tracks (Publish). The dialog still opens when a push cannot go ahead without it: a repository with no remote or no commits, a commit on no branch, or no repository chosen. The dialog's "Don't show this dialog again" turns this off.

- Type: `boolean` · Default: `true`

### `geet.push.showDialogForCommitAndPush`

Show Push dialog for Commit and Push: once Commit and Push has committed, open the Push dialog for the repositories it committed, so you can review the commits and their target before anything leaves your machine — as IntelliJ does by default. Off pushes them straight away. It counts only while geet.push.showDialog is on: off, Commit and Push pushes straight away too.

- Type: `boolean` · Default: `true`

### `geet.push.tags`

Which tags the Push dialog pushes alongside the branch — and a push without the dialog, with geet.push.showDialog off. The dialog keeps its last choice here.

- Type: `string` · Default: `"none"`
- Values:
  - `none` — No tags.
  - `all` — All tags (--tags).
  - `follow` — Tags reachable from the pushed commits (--follow-tags).

### `geet.protectedBranches`

Protected branches, as in IntelliJ's Settings | Version Control | Git: the Push dialog does not offer Force Push to a branch whose name matches one of these. Each entry is a regular expression matched against the whole branch name, so main protects main and not main-copy.

- Type: `array` · Default: `["master","main"]`
