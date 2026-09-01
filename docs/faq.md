# GitTree FAQ

### Does GitTree replace the built-in Git extension?

No, and it no longer asks you to choose. GitTree has its own activity-bar
container, its own commit window, its own change bars and its own diff
controls, so it does not compete with the built-in Git extension for anything.
Leave that extension on or turn it off — GitTree behaves the same either way.

Specifically, GitTree registers no Source Control provider, contributes nothing
to VS Code's Source Control menus, and reads no `git.*` setting.

Earlier versions asked once per workspace and, if you chose "takeover", wrote
`git.enabled: false` into that workspace. That is gone. If your workspace still
carries that setting, GitTree removes it on first launch and tells you it did.
See [migration-from-builtin.md](migration-from-builtin.md).

The one place both extensions can still draw on the same thing is Explorer file
badges. If you run both and would rather see only one set, turn off
`gittree.decorations.fileExplorer` (or disable the other extension).

### GPG signing on Windows doesn't prompt / hangs — what now?

GitTree runs git non-interactively, so gpg must be able to prompt on its own:

1. Install Gpg4win and tell git about it:
   `git config --global gpg.program "C:\Program Files (x86)\GnuPG\bin\gpg.exe"`.
2. Make sure the pinentry dialog is graphical (`gpg-agent` uses
   pinentry-qt/pinentry-w32 by default — a console pinentry cannot appear from
   a GUI process).
3. Test outside VS Code first: `echo test | gpg --clearsign`. If that prompts
   and succeeds, the GitTree sign toggle (the seal icon in the commit UI)
   will too.
4. Long-running agents time out; `gpgconf --kill gpg-agent` resets a stuck one.

### Can I use GitHub Enterprise / self-hosted GitLab?

Pull-request review inside the editor (FEATURES.md §7) is **not shipped** —
the provider-integration phase was skipped by project decision (rationale and
an implementation guide for future contributors live in
`docs/plan/PHASE-08-provider-integrations.md`). Everything git-protocol-level
(clone/fetch/push over HTTPS/SSH, including self-hosted remotes) works
normally — GitTree talks to git, not to provider APIs. Credential prompts are
answered through VS Code via GitTree's askpass bridge, which also covers
integrated terminals when `gittree.terminalAuth` is on.

### The sidebar used to show Branches, Worktrees, Local History and Stashes. Where did they go?

They moved to where IntelliJ keeps them, so the sidebar shows the commit window on its own:

* **Branches** — the branches popup (the status-bar branch widget), and the **Branches** pane
  in the Git tool window's Log tab.
* **Worktrees** — the **Worktrees** tab of the Git tool window, beside `Log` and `Console`.
* **Stashes** — the **Stash** tab of the commit window, beside `Commit` and `Shelf`. Setting
  `gittree.stash.combineWithShelf` folds it into the Shelf tab, which is IntelliJ's
  *Combine stashes and shelves in one tab*.
* **Local History** — `GitTree: Show Local History`, which opens the view on demand. This is
  what IntelliJ's `Show History` does.

The old panes still exist and are simply hidden. To bring any of them back, right-click the
GitTree title bar (or use the ⋯ menu at the top of the sidebar) and tick it under **Views**.

### Where does Local History store its data? Does it leave my machine?

Snapshots are content-addressed, gzip-compressed blobs under VS Code's
extension global storage
(`…/User/globalStorage/gittree.gittree/localHistory/<repo-key>/`), one store
per repository identity. Nothing ever leaves your machine. Retention is
controlled by `gittree.localHistory.{maxSizeMb,retentionDays,maxFileSizeKb}`
(see [settings.md](settings.md)); GC enforces the size budget oldest-first,
and `GitTree: Clear All Local History` wipes a repo's store.

### Where does the shelf store patches?

Outside `.git` on purpose (that is the point of shelving): under extension
global storage, or a folder you pick via `gittree.shelf.path`. Deleting or
re-initializing the repository leaves shelved patches intact.

### The log is slow on a gigantic repository. What helps?

On repos above ~50k tracked files GitTree offers (once) to enable git's
built-in FSMonitor and untracked cache — the two biggest `git status`
accelerators (needs git ≥ 2.37). Commit-graph maintenance runs automatically.
Benchmarks and the tuning playbook are in [perf.md](perf.md).

### Why does the extension ask for nothing at install time?

GitTree needs no account, no token and no telemetry backend. Anonymous usage
telemetry has an off-by-default local wrapper honoring both
`telemetry.telemetryLevel` and `gittree.telemetry.enabled`, and there is no
server configured to receive it.
