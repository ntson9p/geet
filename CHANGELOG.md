# Changelog

All notable changes to GitTree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the VS Code
pre-release convention (odd minor = pre-release).

## [Unreleased]

### Added

- **The Commit tool window (Tier-1 rebuild, Phase 11).** One panel, first in
  the Source Control view, replacing the stacked sidebar trees:
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
  - **Twelve option-bearing dialogs** replace the QuickPick/InputBox chains:
    Push, Update Project, Merge, Rebase, Reset, Rollback, Cherry-Pick, Stash,
    Unstash, Apply Patch, Clone and **Manage Remotes** (which had no command
    at all before). Each follows IntelliJ's *Modify options* pattern — a
    compact form plus a dropdown of the real git flags — rejects contradictory
    combinations **with reasons**, and shows the exact command it will run.
  - **Push dialog**: per-repository sections, an editable
    `branch → remote : branch` target row, the push's full changed-file tree,
    `Push tags` / `Run Git hooks`, and a `[Push ▾]` split button whose Force
    path is always `--force-with-lease`.
  - **Update Project** on `Ctrl+T` with a merge/rebase radio,
    `Do not show again` (which makes `Ctrl+T` act directly), and
    *Reset to the Remote Branch* behind a confirmation and a Local History
    snapshot.
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
- Under the IntelliJ keymap, `Ctrl+T` and `Ctrl+Shift+K` now open the
  **Update Project** and **Push** dialogs rather than acting silently — as
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
