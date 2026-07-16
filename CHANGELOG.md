# Changelog

All notable changes to GitTree are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow the VS Code
pre-release convention (odd minor = pre-release).

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
