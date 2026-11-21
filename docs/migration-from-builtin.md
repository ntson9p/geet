# Migrating from the built-in Git extension

Geet is designed to be adopted incrementally — nothing about your
repository changes, and every step below is reversible.

## 1. There is nothing to choose

Geet installs alongside the built-in Git extension and does not compete with
it. It has its own container in the activity bar, its own commit window, its own
change bars in the gutter and its own controls on the diffs it opens. It
registers no Source Control provider, contributes nothing to VS Code's Source
Control menus, and reads no `git.*` setting.

So: leave the built-in extension enabled, or disable it because you no longer
need it. Geet behaves identically either way, and it will not make that
decision for you.

**If you used an earlier version and chose "takeover"**, that version wrote
`git.enabled: false` into the workspace. Geet no longer needs it, so on first
launch it removes that override and shows a notification saying so. It only ever
*removes* what it wrote — a `git.enabled` you set yourself, at any other scope,
is left alone.

Geet's own file badges in the Explorer (`geet.decorations.fileExplorer`)
and its change bars (`geet.changeBars.enabled`) are off by default, so they
never double up with the built-in extension's. If you disable the built-in
extension, turn them on.

## 2. Feature equivalents

| You used (built-in) | You get (Geet) |
| --- | --- |
| Source Control view | Commit tool window in the **Geet** container — by default a list like the Source Control view's, each file with its status letter; changelist rows a click away, or Staged/Unstaged with hunk & line staging |
| `Git: Commit` | `Geet: Commit` (pre-commit checks, amend, sign, message history — `Ctrl+Up`) |
| Branch status-bar item | Repositories view: each repository's current branch, then its branches under Recent / Local / Remote / Tags tabs, favorites, smart checkout |
| `Git: Stash` commands | Stash view with diffs, plus the Shelf (patches stored outside `.git`) |
| Timeline / `Git: View History` | Log tool window: graph, filters, IntelliSort, revision actions, file history |
| Merge editor | 3-pane merge editor with a real editor result pane, `F7`, chevrons, magic wand |
| GitLens blame (if you used it) | `Geet: Annotate with Git Blame` (`Ctrl+Alt+G B`), age heat-map, click-through to log |
| — (no equivalent) | Local History failsafe: automatic snapshots around every destructive operation |

Keyboard reference: [keyboard.md](keyboard.md). Every setting: [settings.md](settings.md).

## 3. Things that intentionally stay the same

- **Your git config, hooks and aliases** — Geet runs real git (argument
  arrays, no shell), so hooks, signing, LFS filters and credential helpers
  behave exactly as on your command line.
- **Authentication** — VS Code's credential UI answers git's prompts via
  Geet's askpass bridge; set `geet.terminalAuth` to extend that to
  integrated terminals.
- **The index** — even the changelists paradigm leaves your staging area
  untouched unless you stage something yourself.

## 4. Coexistence notes

- Other Git UIs (GitLens, Git Graph) keep working — they read the same
  repository state. Disable their duplicate blame/graph surfaces to taste.
- Geet changes no VS Code or extension setting on your behalf. The one
  exception is the one-shot cleanup described above, which *removes* an override
  an earlier Geet wrote and is itself removed a release later.
- An option you change from Geet's menus and dialogs (a Show item, the commit
  paradigm, the Push dialog's tag mode, the diff editor's whitespace toggle, Don't
  Ask Again) is saved where you keep that setting already, and otherwise in your
  user settings. Geet never adds a value to a repository's `.vscode/settings.json`,
  and writes nothing when the value does not change.
- VS Code's own previous/next-change arrows stay in the diff toolbar next to
  Geet's. An extension cannot remove a built-in toolbar button; you can hide
  them yourself by right-clicking the toolbar. Geet's arrows are the ones
  that walk into the next file instead of wrapping, and `F7`/`Shift+F7` are
  Geet's on Geet's diffs.
- To leave Geet entirely: disable or uninstall the extension. Nothing needs
  restoring first. Shelved patches and Local History snapshots remain on disk
  until you delete them (see [faq.md](faq.md) for locations).
