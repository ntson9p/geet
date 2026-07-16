# Migrating from the built-in Git extension

GitTree is designed to be adopted incrementally — nothing about your
repository changes, and every step below is reversible.

## 1. Pick a mode

On first activation in a workspace GitTree asks once:

| | Takeover | Companion |
| --- | --- | --- |
| SCM view | GitTree's (changelists **or** staging) | both extensions' views |
| Gutter/quick-diff | GitTree | built-in keeps them (GitTree's stay off) |
| `git.enabled` | set to `false` for this workspace | untouched |
| Undo | leave takeover → the setting is restored | — |

"Later" defers the decision; until you decide, GitTree behaves as a companion
and touches nothing. The decision is per-workspace and lives in
`gittree.mode` — editing that setting is the same consent, explicitly given.

## 2. Feature equivalents

| You used (built-in) | You get (GitTree) |
| --- | --- |
| Source Control view | Commit tool window — changelists or Staged/Unstaged with hunk & line staging |
| `Git: Commit` | `GitTree: Commit` (pre-commit checks, amend, sign, message history — `Ctrl+Up`) |
| Branch status-bar item | Branches view: current/recent/local/remote, favorites, smart checkout |
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

- Other Git UIs (GitLens, Git Graph) keep working in either mode — they read
  the same repository state. Disable their duplicate blame/graph surfaces to
  taste.
- Workspaces you never opted into are never affected: the consent is stored
  per workspace, not globally.
- To leave GitTree entirely: switch `gittree.mode` to `companion` (restores
  `git.enabled`), then disable/uninstall the extension. Shelved patches and
  Local History snapshots remain on disk until you delete them (see
  [faq.md](faq.md) for locations).
