# Migrating from the built-in Git extension

GitTree is designed to be adopted incrementally — nothing about your
repository changes, and every step below is reversible.

## 1. There is nothing to choose

GitTree installs alongside the built-in Git extension and does not compete with
it. It has its own container in the activity bar, its own commit window, its own
change bars in the gutter and its own controls on the diffs it opens. It
registers no Source Control provider, contributes nothing to VS Code's Source
Control menus, and reads no `git.*` setting.

So: leave the built-in extension enabled, or disable it because you no longer
need it. GitTree behaves identically either way, and it will not make that
decision for you.

**If you used an earlier version and chose "takeover"**, that version wrote
`git.enabled: false` into the workspace. GitTree no longer needs it, so on first
launch it removes that override and shows a notification saying so. It only ever
*removes* what it wrote — a `git.enabled` you set yourself, at any other scope,
is left alone.

The one overlap that remains is Explorer file badges, which both extensions can
draw. If you run both and want only one set, turn off
`gittree.decorations.fileExplorer`.

## 2. Feature equivalents

| You used (built-in) | You get (GitTree) |
| --- | --- |
| Source Control view | Commit tool window in the **GitTree** container — changelists or Staged/Unstaged with hunk & line staging |
| `Git: Commit` | `GitTree: Commit` (pre-commit checks, amend, sign, message history — `Ctrl+Up`) |
| Branch status-bar item | Repositories view: each repository's current branch, then its branches under Recent / Local / Remote / Tags tabs, favorites, smart checkout |
| `Git: Stash` commands | Stash view with diffs, plus the Shelf (patches stored outside `.git`) |
| Timeline / `Git: View History` | Log tool window: graph, filters, IntelliSort, revision actions, file history |
| Merge editor | 3-pane merge editor with a real editor result pane, `F7`, chevrons, magic wand |
| GitLens blame (if you used it) | `GitTree: Annotate with Git Blame` (`Ctrl+Alt+G B`), age heat-map, click-through to log |
| — (no equivalent) | Local History failsafe: automatic snapshots around every destructive operation |

Keyboard reference: [keyboard.md](keyboard.md). Every setting: [settings.md](settings.md).

## 3. Things that intentionally stay the same

- **Your git config, hooks and aliases** — GitTree runs real git (argument
  arrays, no shell), so hooks, signing, LFS filters and credential helpers
  behave exactly as on your command line.
- **Authentication** — VS Code's credential UI answers git's prompts via
  GitTree's askpass bridge; set `gittree.terminalAuth` to extend that to
  integrated terminals.
- **The index** — even the changelists paradigm leaves your staging area
  untouched unless you stage something yourself.

## 4. Coexistence notes

- Other Git UIs (GitLens, Git Graph) keep working — they read the same
  repository state. Disable their duplicate blame/graph surfaces to taste.
- GitTree changes no VS Code or extension setting on your behalf. The one
  exception is the one-shot cleanup described above, which *removes* an override
  an earlier GitTree wrote and is itself removed a release later.
- An option you change from GitTree's menus and dialogs (a Show item, the commit
  paradigm, the Push dialog's tag mode, the diff editor's whitespace toggle, Don't
  Ask Again) is saved where you keep that setting already, and otherwise in your
  user settings. GitTree never adds a value to a repository's `.vscode/settings.json`,
  and writes nothing when the value does not change.
- VS Code's own previous/next-change arrows stay in the diff toolbar next to
  GitTree's. An extension cannot remove a built-in toolbar button; you can hide
  them yourself by right-clicking the toolbar. GitTree's arrows are the ones
  that walk into the next file instead of wrapping, and `F7`/`Shift+F7` are
  GitTree's on GitTree's diffs.
- To leave GitTree entirely: disable or uninstall the extension. Nothing needs
  restoring first. Shelved patches and Local History snapshots remain on disk
  until you delete them (see [faq.md](faq.md) for locations).
