# GitTree settings

<!-- GENERATED FILE — do not edit by hand. Derived from package.json
     `contributes.configuration`; regenerate with `npm run docs:settings`.
     test/unit/docs/settingsDoc.test.ts fails when this file is stale. -->

All settings live under the `gittree.` namespace. Defaults are chosen to
coexist with the built-in git extension until you opt into takeover mode.

## GitTree

### `gittree.gitPath`

Path to the git executable. Falls back to the built-in `git.path` setting, then PATH, then well-known install locations.

- Type: `string \| null` · Default: `null`
- Scope: `machine-overridable`

### `gittree.trace`

Log every git invocation (argv, duration, exit code — never file contents) to the "GitTree" output channel, and reveal debug commands.

- Type: `boolean` · Default: `false`

### `gittree.mode`

How GitTree coexists with the built-in Git extension. "auto" asks once per workspace; "takeover" disables the built-in Git here (writes `git.enabled: false`); "companion" runs alongside it without overlapping decorations.

- Type: `string` · Default: `"auto"`
- Scope: `window`
- Values:
  - `auto` — Ask once per workspace.
  - `takeover` — GitTree provides all SCM UI; the built-in Git extension is disabled for this workspace.
  - `companion` — GitTree runs alongside the built-in Git extension; overlapping gutter/explorer decorations stay off.

### `gittree.terminalAuth`

Export GitTree's git credential helper (GIT_ASKPASS) into integrated terminals so command-line git prompts are answered by VS Code.

- Type: `boolean` · Default: `false`
- Scope: `window`

### `gittree.keymap.intellij`

Enable the optional IntelliJ-flavored keybinding set (Ctrl+K commit, Ctrl+Shift+K push, Ctrl+T update, Alt+9 log, Ctrl+Alt+Z rollback). See docs/keyboard.md for conflicts with VS Code defaults.

- Type: `boolean` · Default: `false`

### `gittree.whatsNew.enabled`

Show a one-time notification with the changelog when GitTree updates to a new minor version.

- Type: `boolean` · Default: `true`

### `gittree.telemetry.enabled`

Allow GitTree usage telemetry (activation timing, operation duration buckets, error kinds — never repository names, paths, shas or content). Both this AND VS Code's telemetry.telemetryLevel must allow. No telemetry backend is currently configured, so nothing is transmitted either way.

- Type: `boolean` · Default: `false`

## GitTree Source Control

### `gittree.quickDiff.base`

What the editor gutter bars compare against: the index (IntelliJ behavior — bars show unstaged edits) or HEAD (bars show all uncommitted edits).

- Type: `string` · Default: `"index"`
- Values:
  - `index`
  - `head`

### `gittree.changeBars.base`

What GitTree measures its change bars against: the index (bars show unstaged edits, as in IntelliJ) or HEAD (bars show every uncommitted edit).

- Type: `string` · Default: `"index"`
- Values:
  - `index`
  - `head`

### `gittree.changeBars.maxFileLines`

Files longer than this get no change bars. The line diff is quadratic in the worst case, and a stalled editor is worse than a missing bar.

- Type: `number` · Default: `20000`
- Minimum: `100`

### `gittree.autofetch.enabled`

Periodically run `git fetch` in the background so incoming/outgoing counts stay fresh.

- Type: `boolean` · Default: `false`

### `gittree.autofetch.intervalSeconds`

Auto-fetch interval in seconds.

- Type: `number` · Default: `180`
- Minimum: `30`

### `gittree.branches.recentCount`

How many recent branches (by checkout frequency and recency) the Branches popup shows.

- Type: `number` · Default: `5`
- Minimum: `0`

### `gittree.branches.defaultAction`

What pressing Enter on a branch in the Branches popup does.

- Type: `string` · Default: `"checkout"`
- Values:
  - `checkout`
  - `showActions`

### `gittree.branches.showIncomingOutgoing`

Show incoming (↓) before outgoing (↑) counts in the branches popup. Toggled from the popup's header.

- Type: `boolean` · Default: `true`

### `gittree.smartCheckout.behavior`

When a checkout is blocked by local changes: ask (IntelliJ-style dialog), auto (always smart-checkout via stash), or never (just report).

- Type: `string` · Default: `"ask"`
- Values:
  - `ask`
  - `auto`
  - `never`

### `gittree.cherryPick.recordOrigin`

Append the "(cherry picked from commit …)" trailer (-x) to cherry-picked commit messages.

- Type: `boolean` · Default: `false`

### `gittree.pushSafety.afterRewrite`

After a successful history rewrite on a branch with an upstream: offer Push --force-with-lease (ask) or stay quiet (never). Plain --force is never used.

- Type: `string` · Default: `"ask"`
- Values:
  - `ask`
  - `never`

## GitTree Merge

### `gittree.merge.resultMode`

Where the center Result pane lives during a 3-pane merge.

- Type: `string` · Default: `"virtual"`
- Values:
  - `virtual` — A virtual result document — the conflicted file on disk stays untouched until Apply.
  - `markers` — Edit the real conflicted file in place (fallback for language servers that require on-disk files).

### `gittree.merge.conflictsDialog`

Show the "Files Merged with Conflicts" dialog when an operation produces conflicts. The Conflicts view remains available either way.

- Type: `boolean` · Default: `true`

### `gittree.merge.autoResolveWhitespace`

Magic Wand: when one side changed only whitespace, take the substantive side automatically.

- Type: `boolean` · Default: `true`

## GitTree: Stash

### `gittree.stash.includeUntrackedDefault`

Pre-select "Include untracked files" in the Stash Changes flow.

- Type: `boolean` · Default: `true`

## GitTree: Shelf

### `gittree.shelf.path`

Custom directory for shelved patches (must be writable). Empty = the extension's global storage. Shelves always live outside the repository, so they survive deleting or re-initializing it.

- Type: `string` · Default: `""`

### `gittree.shelf.showUnshelved`

List shelved changes that were already unshelved but kept (IntelliJ's greyed entries).

- Type: `boolean` · Default: `false`

## GitTree: File Status Colors

### `gittree.colors.added`

Override for added files in GitTree's own views (hex like #81b88b or a CSS color name). Empty follows the theme's gitDecoration colors.

- Type: `string` · Default: `""`

### `gittree.colors.modified`

Override for modified files in GitTree's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `gittree.colors.deleted`

Override for deleted files in GitTree's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `gittree.colors.renamed`

Override for renamed files in GitTree's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `gittree.colors.untracked`

Override for untracked files in GitTree's own views. Empty follows the theme.

- Type: `string` · Default: `""`

### `gittree.colors.conflicted`

Override for conflicted files in GitTree's own views. Empty follows the theme.

- Type: `string` · Default: `""`

## GitTree Commit

### `gittree.commit.paradigm`

How commits are assembled: IntelliJ-style changelists (index-bypassing checked-file commits) or native git staging.

- Type: `string` · Default: `"changelists"`
- Scope: `window`
- Values:
  - `changelists`
  - `staging`

### `gittree.commit.signoff`

Append a Signed-off-by trailer (git commit -s) to every commit.

- Type: `boolean` · Default: `false`

### `gittree.commit.checks.reformat`

Pre-commit: reformat only the modified line ranges of committed files.

- Type: `boolean` · Default: `false`

### `gittree.commit.checks.optimizeImports`

Pre-commit: organize imports in committed files.

- Type: `boolean` · Default: `false`

### `gittree.commit.checks.cleanup`

Pre-commit: run source.fixAll code actions on committed files.

- Type: `boolean` · Default: `false`

### `gittree.commit.checks.analyze`

Pre-commit: wait for diagnostics and warn when committed files have problems.

- Type: `boolean` · Default: `true`

### `gittree.commit.checks.analyzeSeverity`

Diagnostic severity that triggers the analyze warning.

- Type: `string` · Default: `"error"`
- Values:
  - `error`
  - `warning`

### `gittree.commit.checks.todo`

Pre-commit: warn about TODO-like markers on newly added lines.

- Type: `boolean` · Default: `true`

### `gittree.commit.checks.todoPattern`

Regular expression for the TODO check (applied per added line).

- Type: `string` · Default: `"\\b(TODO|FIXME)\\b"`

### `gittree.commit.checks.cleanupKind`

Code-action kind the Cleanup check applies — the "profile": source.fixAll runs every provider, source.fixAll.eslint only ESLint.

- Type: `string` · Default: `"source.fixAll"`

### `gittree.commit.checks.deferAdvanced`

Run the advanced checks (Analyze code, TODO) after the commit and report via notification instead of gating the commit — IntelliJ's default. Failed checks will not prevent a commit.

- Type: `boolean` · Default: `true`

## GitTree Log & Blame

### `gittree.log.sort`

Default sort for the Git log tool window.

- Type: `string` · Default: `"topo"`
- Values:
  - `date`
  - `topo`
  - `intelli`

### `gittree.log.graphPalette`

Color palette for the commit graph lanes.

- Type: `string` · Default: `"default"`
- Values:
  - `default` — Hue-cycled palette matching the editor theme.
  - `colorBlind` — Okabe–Ito color-blind-safe palette (distinct under deutan, protan and tritan vision).

### `gittree.log.issuePattern`

Regular expression for issue keys in commit messages (e.g. [A-Z]+-\d+). Empty disables issue linkification.

- Type: `string` · Default: `""`

### `gittree.log.issueUrl`

URL template for matched issue keys; $0 is replaced with the match (e.g. https://tracker.example.com/browse/$0).

- Type: `string` · Default: `""`

### `gittree.log.filterPresets`

Saved log filter presets (managed by the Saved filters toolbar menu).

- Type: `array` · Default: `[]`

### `gittree.log.console.limit`

Maximum number of git commands kept in the Console tab's history (read at startup).

- Type: `number` · Default: `2000`
- Minimum: `100`

### `gittree.blame.heatmap`

Fade blame annotations by commit age (newest brightest).

- Type: `boolean` · Default: `true`

### `gittree.blame.format`

Blame column format. Placeholders: ${author|N}, ${date|relative}, ${sha|N}.

- Type: `string` · Default: `"${author|12} ${date|relative} ${sha|7}"`

## GitTree Local History

### `gittree.localHistory.enabled`

Record Local History snapshots around destructive git operations (the failsafe for reset --hard, rebase, checkout over dirty files, …).

- Type: `boolean` · Default: `true`

### `gittree.localHistory.maxSizeMb`

Storage budget for Local History blobs. Oldest snapshots are garbage-collected first when over budget.

- Type: `number` · Default: `500`
- Minimum: `10`

### `gittree.localHistory.retentionDays`

Snapshots older than this are garbage-collected (the most recent snapshot is always kept).

- Type: `number` · Default: `30`
- Minimum: `1`

### `gittree.localHistory.maxFileSizeKb`

Files larger than this are recorded as metadata-only stubs instead of full content.

- Type: `number` · Default: `1024`
- Minimum: `1`

### `gittree.localHistory.snapshotOnSave`

Also record a snapshot on file save (debounced 30s per file). Off by default — VS Code's native Local History already covers saves.

- Type: `boolean` · Default: `false`

### `gittree.localHistory.taskLabels`

Record a labeled snapshot when a build/test task finishes, so states like "after the last green test run" are easy to find.

- Type: `boolean` · Default: `true`

## GitTree: Dialogs

### `gittree.update.strategy`

What Ctrl+T (Update Project) does. "Ask every time" shows the Update Project dialog; picking a strategy there with "Do not show again" writes it here.

- Type: `string` · Default: `"ask"`
- Values:
  - `ask` — Show the Update Project dialog.
  - `merge` — Merge incoming changes into the current branch.
  - `rebase` — Rebase the current branch on top of incoming changes.

### `gittree.dialogs.showCommandLine`

Show the dim "will run: git …" line in GitTree's dialogs, so the flags behind each option stay legible.

- Type: `boolean` · Default: `true`

### `gittree.push.runHooks`

Run Git hooks (pre-push) when pushing from the Push dialog. Off adds --no-verify.

- Type: `boolean` · Default: `true`

### `gittree.push.tags`

Which tags the Push dialog pushes alongside the branch.

- Type: `string` · Default: `"none"`
- Values:
  - `none` — No tags.
  - `all` — All tags (--tags).
  - `follow` — Tags reachable from the pushed commits (--follow-tags).
