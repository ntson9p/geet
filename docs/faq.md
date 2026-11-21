# Geet FAQ

### Does Geet replace the built-in Git extension?

No, and it no longer asks you to choose. Geet has its own activity-bar
container, its own commit window, its own change bars and its own diff
controls, so it does not compete with the built-in Git extension for anything.
Leave that extension on or turn it off — Geet behaves the same either way.

Specifically, Geet registers no Source Control provider, contributes nothing
to VS Code's Source Control menus, and reads no `git.*` setting.

Earlier versions asked once per workspace and, if you chose "takeover", wrote
`git.enabled: false` into that workspace. That is gone. If your workspace still
carries that setting, Geet removes it on first launch and tells you it did.
See [migration-from-builtin.md](migration-from-builtin.md).

Geet's own file badges (`geet.decorations.fileExplorer`) are off by default.
VS Code shows an extension's file badges in all of its views, its own Source
Control view included, so with both extensions running they showed every badge
twice (`U, U`). Turn the setting on if you disable the built-in Git extension.

So are Geet's change bars (`geet.changeBars.enabled`): the built-in
extension draws its own beside the same lines, and with both every changed line
had two. Geet's change actions work without them (`Ctrl+Alt+G H` at the
cursor). Turn them on if you disable the built-in extension.

### GPG signing on Windows doesn't prompt / hangs — what now?

Geet runs git non-interactively, so gpg must be able to prompt on its own:

1. Install Gpg4win and tell git about it:
   `git config --global gpg.program "C:\Program Files (x86)\GnuPG\bin\gpg.exe"`.
2. Make sure the pinentry dialog is graphical (`gpg-agent` uses
   pinentry-qt/pinentry-w32 by default — a console pinentry cannot appear from
   a GUI process).
3. Test outside VS Code first: `echo test | gpg --clearsign`. If that prompts
   and succeeds, the Geet sign toggle (the seal icon in the commit UI)
   will too.
4. Long-running agents time out; `gpgconf --kill gpg-agent` resets a stuck one.

### Can I use GitHub Enterprise / self-hosted GitLab?

Pull-request review inside the editor (FEATURES.md §7) is **not shipped** —
the provider-integration phase was skipped by project decision (rationale and
an implementation guide for future contributors live in
`docs/plan/PHASE-08-provider-integrations.md`). Everything git-protocol-level
(clone/fetch/push over HTTPS/SSH, including self-hosted remotes) works
normally — Geet talks to git, not to provider APIs. Credential prompts are
answered through VS Code via Geet's askpass bridge, which also covers
integrated terminals when `geet.terminalAuth` is on.

### How do I fetch — all repositories, or just one?

**All of them, which is the default.** Fetch is a *project* operation in
IntelliJ and in Geet: the `$(sync)` button in the branches popup's header
(click the branch in the status bar to open it), the one beside the sidebar
Repositories panel's filter (in the Branches panel's toolbar, with one
repository), `Geet: Fetch` from the command palette, `Geet: Fetch All
Repositories`, and `Fetch` in the VCS Operations Popup (`Alt+\``) all fetch
**every** root in the workspace that has a remote. Roots without one are skipped rather than failed, one slow or
unreachable remote never stops the others, and the whole fan-out reports once.

**One of them** is for callers that know which they mean: `geet.fetch` takes
a repository root as its argument. Bind it if you want a per-repository fetch:

```json
{ "key": "ctrl+alt+g 1", "command": "geet.fetch", "args": "D:\\code\\sample-app-client" }
```

Fetch runs `git fetch --prune` against the branch's default remote, not
`--all`; a second remote (an `upstream` fork remote, say) is not refreshed.
Background fetching is off by default — turn on `geet.autofetch.enabled` to
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
because Geet asks for that answer per repository and you would be asked
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
  `geet.stash.combineWithShelf` folds it into the Shelf tab, which is IntelliJ's
  *Combine stashes and shelves in one tab*.
* **Local History** — `Geet: Show Local History`, which opens the view on demand. This is
  what IntelliJ's `Show History` does.

The old panes still exist. To bring all four back, turn on **`geet.sidebar.extraViews`**
(Settings → Extensions → Geet). They reappear as collapsed sections, and turning it off
removes them again — no reload either way.

(Ticking them under the sidebar's ⋯ → **Views** menu does *not* work, and neither did the
first attempt at this, which set them to `"visibility": "hidden"`: that is only a default for
a profile that has never rendered the container, so an existing install kept showing them.)

### What are the Repositories and Branches panels in the sidebar?

**Repositories** and **Branches**, under the Commit window, answer three questions. *Where am
I:* the Repositories panel lists every repository with what it has checked out, how far that is
from its upstream and how many files are changed. With one repository there is no Repositories
panel: the Branches panel starts with its current branch. *Where can I go:* the Branches panel
lists the branches under **Recent**, **Local**, **Remote** and **Tags** tabs, one list at a time.
*What can I do:* a click opens a branch's card, with the actions its state calls for; right-click
has the rest. See FEATURES and D34.

They were one panel, *Repositories*, with a REPOSITORIES and a BRANCHES pane, until POST-P14co
(and before that it was titled *Branches*). As two of VS Code's views, each folds, resizes and
scrolls on its own.

**Picking repositories:** click one in the Repositories panel (`Ctrl+click` for several), or
type `@` in the Branches panel's filter: a list of the repositories opens, a checkbox each, and
what you type after the `@` narrows it. Both make the same pick. The filter's pill names it
(`web ×`) and widens it again. With many repositories, the filter at the top of the
Repositories panel finds one by name, and `Enter` there shows only its branches (POST-P14cp);
the filter alone picks nothing.

Why it exists, when IntelliJ puts branches in the branch widget and the Git tool window:
the status bar cannot be the way in. **Cursor has no status bar at all**, so the Geet
button does not exist there — and a VS Code user who has just installed the extension looks
in the sidebar, not at a widget two entries from the one the built-in Git extension draws.
Both surfaces still work exactly as before; this is a third way in, not a replacement.

**What the pick changes:** the Branches panel lists the branches of the repositories picked, and
its rows act on those; the Commit window lists and commits only them, and says so in a bar over
its list (POST-P14ce). `Ctrl+T` (Update Project) and `Ctrl+Shift+K` (Push…) find their
repositories as they always have: the project, and the active editor's repository.

The trees the panels replaced are still available under `geet.sidebar.extraViews`:
**Repositories (Tree)**, **Branches (Tree)** and **Branches (All Repositories)**.

### A Geet message went away before I read it. Where is it?

In the **Geet** output (View › Output, then *Geet*), as `[notice] 13:27:54 Checked out
develop`. A message with nothing to click, such as *Fetch successful* or *Nothing to stash.*,
stays 5 seconds while VS Code is in front, and VS Code cannot keep a notification it hides on a
timer in its Notifications list. Set `geet.notifications.durationSeconds` to keep them up
longer, or to `0` for ordinary notifications, which VS Code keeps in that list. Messages with
buttons, warnings and errors are always ordinary notifications.

### Where does Local History store its data? Does it leave my machine?

Snapshots are content-addressed, gzip-compressed blobs under VS Code's
extension global storage
(`…/User/globalStorage/ntson9p.geet/history/<repo-key>/`), one store
per repository identity. Nothing ever leaves your machine. Retention is
controlled by `geet.localHistory.{maxSizeMb,retentionDays,maxFileSizeKb}`
(see [settings.md](settings.md)); GC enforces the size budget oldest-first,
and `Geet: Clear All Local History` wipes a repo's store.

### Where does the shelf store patches?

Outside `.git` on purpose (that is the point of shelving): under extension
global storage (`…/User/globalStorage/ntson9p.geet/shelf/`), or a folder you
pick via `geet.shelf.path`. Deleting or re-initializing the repository
leaves shelved patches intact.

### My settings from GitTree, Geet's name before 0.1.0, do nothing. Why?

Before 0.1.0 Geet was called GitTree, and its settings, command IDs, views and context keys
started with `gittree.` (`gittree.localHistory.maxSizeMb`). Since 0.1.0 they start with
`geet.` (`geet.localHistory.maxSizeMb`), and VS Code ignores the old keys. Rename `gittree.` to
`geet.` in your `settings.json` (also a `"[gittree-commit-message]"` block and any `gittree.…`
colour under `workbench.colorCustomizations`) and in `keybindings.json`, commands and `when`
clauses alike. VS Code marks a setting key it no longer knows, so the old ones are easy to find.

### I used GitTree, Geet's name before the Marketplace. Where did my shelf go?

Builds before 0.1.0 were `gittree.gittree`; the Marketplace's is `ntson9p.geet`, and VS
Code keeps each extension's data under its ID. The old build's shelf and Local History are
still in `…/User/globalStorage/gittree.gittree/`: with VS Code closed, copy its `shelf` and
`history` folders into `…/User/globalStorage/ntson9p.geet/`. Changelists, commit message
history and drafts are kept by VS Code itself and do not carry over.

### The log is slow on a gigantic repository. What helps?

On repos above ~50k tracked files Geet offers (once) to enable git's
built-in FSMonitor and untracked cache — the two biggest `git status`
accelerators (needs git ≥ 2.37). Commit-graph maintenance runs automatically,
once a day per repository, in the background: it starts a minute after the
log opens, waits while a git operation runs, and never holds up a read.
Benchmarks and the tuning playbook are in [perf.md](perf.md).

### Why does the extension ask for nothing at install time?

Geet needs no account, no token and no telemetry backend. Anonymous usage
telemetry has an off-by-default local wrapper honoring both
`telemetry.telemetryLevel` and `geet.telemetry.enabled`, and there is no
server configured to receive it.
