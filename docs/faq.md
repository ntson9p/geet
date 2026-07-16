# GitTree FAQ

### Does GitTree replace the built-in Git extension?

Only if you ask it to. On first use GitTree asks once per workspace:

- **Takeover** — GitTree provides the SCM view and disables the built-in git
  extension *for that workspace only* (it writes `git.enabled: false` at
  workspace scope, and restores it the moment you leave takeover mode).
- **Companion** — both run side by side; GitTree keeps overlapping gutter and
  explorer decorations off so nothing is drawn twice.

Nothing is changed without that explicit consent, and `gittree.mode` can flip
the decision at any time. See [migration-from-builtin.md](migration-from-builtin.md).

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
