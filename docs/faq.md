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

### How do I fetch — all repositories, or just one?

**All of them, which is the default.** Fetch is a *project* operation in
IntelliJ and in GitTree: the `$(sync)` button in the branches popup's header
(click the branch in the status bar to open it), `GitTree: Fetch` from the
command palette, `GitTree: Fetch All Repositories`, and `Fetch` in the VCS
Operations Popup (`Alt+\``) all fetch **every** root in the workspace that has
a remote. Roots without one are skipped rather than failed, one slow or
unreachable remote never stops the others, and the whole fan-out reports once.

**One of them** is for callers that know which they mean: `gittree.fetch` takes
a repository root as its argument. Bind it if you want a per-repository fetch:

```json
{ "key": "ctrl+alt+g 1", "command": "gittree.fetch", "args": "D:\\code\\sample-app-client" }
```

Fetch runs `git fetch --prune` against the branch's default remote, not
`--all`; a second remote (an `upstream` fork remote, say) is not refreshed.
Background fetching is off by default — turn on `gittree.autofetch.enabled` to
keep the incoming/outgoing counts fresh without asking.

### I have several repositories open. Which one does the branches popup act on?

Whichever one you pick — it is no longer inferred. With more than one repository
the popup opens at the **project level**: the actions, then a row per
repository showing its current branch, then `Common Local Branches`,
`Common Remote Branches` and `Common Tags` — the refs every repository carries.
Picking a repository row drills into that repository's own popup, titled with
its name, and `‹ Back` returns to the project. The status-bar branch widget
opens the project level with its own repository's row already selected.

Picking a **common** branch checks it out in every repository. Its `›` submenu
offers the other all-roots operations — Update, Merge into the current branch,
Rebase the current branch onto it, Pull into the current branch, Push — each
labelled with how many repositories it will actually touch, and each stopping
at the first repository that refuses rather than half-applying.

Operations that need an answer from you — New Branch, Rename, Delete, New
Worktree — are offered inside a repository rather than across all of them,
because GitTree asks for that answer per repository and you would be asked
once for each. See D27 in [deviations.md](deviations.md).

A single-repository workspace sees none of this: the popup opens exactly as
before.

### The sidebar used to show Branches, Worktrees, Local History and Stashes. Where did they go?

They moved to where IntelliJ keeps them, so the sidebar shows the commit window on its own:

* **Branches** — came back, in a different shape. The sidebar's **Branches** section is the
  branches popup standing open, scoped to one repository; **Repositories** above it chooses
  which (it appears only when the workspace has more than one). See the next entry.
* **Worktrees** — the **Worktrees** tab of the Git tool window, beside `Log` and `Console`.
* **Stashes** — the **Stash** tab of the commit window, beside `Commit` and `Shelf`. Setting
  `gittree.stash.combineWithShelf` folds it into the Shelf tab, which is IntelliJ's
  *Combine stashes and shelves in one tab*.
* **Local History** — `GitTree: Show Local History`, which opens the view on demand. This is
  what IntelliJ's `Show History` does.

The old panes still exist. To bring all four back, turn on **`gittree.sidebar.extraViews`**
(Settings → Extensions → GitTree). They reappear as collapsed sections, and turning it off
removes them again — no reload either way.

(Ticking them under the sidebar's ⋯ → **Views** menu does *not* work, and neither did the
first attempt at this, which set them to `"visibility": "hidden"`: that is only a default for
a profile that has never rendered the container, so an existing install kept showing them.)

### What are the Repositories and Branches sections in the sidebar?

**Branches** is the branches popup, standing open: the same `Actions` verbs, the same
Current / Favorites / Recent / Local / Remote / Tags sections, the same right-click menu.
Two differences, both in its favour — `feature/` is a real expandable folder rather than a
drill-in (a popup cannot nest; see D5), and it does not close when you look away.

**Repositories** lists every repository with its current branch and how far that branch is
from its upstream. Click one to show it in Branches. It appears only when the workspace has
more than one repository, and starts collapsed, so a single-repository workspace never sees
it and a multi-repository one pays one row for it.

Why it exists, when IntelliJ puts branches in the branch widget and the Git tool window:
the status bar cannot be the way in. **Cursor has no status bar at all**, so the GitTree
button does not exist there — and a VS Code user who has just installed the extension looks
in the sidebar, not at a widget two entries from the one the built-in Git extension draws.
Both surfaces still work exactly as before; this is a third way in, not a replacement.

**What focusing a repository does *not* do:** it does not change what `Ctrl+K`, `Ctrl+T` or
Push act on. Those still resolve their repository from the active editor, as they always
have. Focus scopes the two sections that draw it and nothing else — the same split VS Code
has (its Source Control selection filters that view; the status-bar branch follows the
editor) and IntelliJ has (the log has a root filter; the branch widget follows the editor).
The Branches section names its repository in the header so there is never a question which
one it means.

The all-repositories branch tree that used to be here is still available as
**Branches (All Repositories)** under `gittree.sidebar.extraViews`.

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
accelerators (needs git ≥ 2.37). Commit-graph maintenance runs automatically,
once a day per repository, in the background: it starts a minute after the
log opens, waits while a git operation runs, and never holds up a read.
Benchmarks and the tuning playbook are in [perf.md](perf.md).

### Why does the extension ask for nothing at install time?

GitTree needs no account, no token and no telemetry backend. Anonymous usage
telemetry has an off-by-default local wrapper honoring both
`telemetry.telemetryLevel` and `gittree.telemetry.enabled`, and there is no
server configured to receive it.
