# GitTree keyboard reference & accessibility audit (P10-T2)

Everything GitTree can do with a mouse can be done from the keyboard. This
document is the complete key reference, the optional IntelliJ keymap, the
manual accessibility audit checklist, and the recorded keyboard-only
walkthrough required by the P10-T2 acceptance criteria.

## Default keybindings

Contributed in `package.json` → `contributes.keybindings` (users can rebind
any of them in Keyboard Shortcuts):

| Key | Command | Where |
| --- | --- | --- |
| `Ctrl+Up` (`Cmd+Up`) | `gittree.commit.showMessageHistory` | SCM commit input |
| `Ctrl+Alt+Enter` | `gittree.stage.selectedRanges` | diff editor — stages the selected lines/hunk |
| `F7` / `Shift+F7` | `gittree.merge.nextConflict` / `prevConflict` | merge tri-editor |
| `Alt+Enter` | `gittree.merge.acceptFocusedSide` | merge tri-editor — chevron accept |
| `Ctrl+Alt+Enter` | `gittree.merge.apply` | merge tri-editor (outside diff editors) |
| `Ctrl+Alt+G F` (`Cmd+Alt+G F`) | `gittree.log.focusFilter` | anywhere — reveals the log and focuses its search box |
| `Ctrl+Alt+G B` (`Cmd+Alt+G B`) | `gittree.blame.toggle` | text editor — toggle blame annotations |

The two `Ctrl+Alt+G …` bindings are chords (press `Ctrl+Alt+G`, release,
then the second key) so they cannot collide with VS Code defaults.

Commands without a default binding are still keyboard-reachable via the
Command Palette (`Ctrl+Shift+P` → type "GitTree"). Mouse-only affordances all
have command equivalents:

- **Hunk staging**: the diff-editor CodeLens "Stage hunk ≫" equals selecting
  the hunk's lines and pressing `Ctrl+Alt+Enter`
  (`gittree.stage.selectedRanges`).
- **Blame gutter click** equals `gittree.blame.showDiff` /
  `gittree.blame.revealCursorCommit` from the palette.
- **Log toolbar chips** (Branch/User/Date/Path pickers) are buttons in the
  webview tab order; `gittree.log.setFilter` also accepts a filter via the
  extension API.

## Optional IntelliJ keymap (`gittree.keymap.intellij`)

Set `"gittree.keymap.intellij": true` to enable an IntelliJ-IDEA-flavored
binding set (all gated on the setting — off by default):

| Key | IntelliJ action | GitTree command |
| --- | --- | --- |
| `Ctrl+K` (`Cmd+K`) | Commit… | `gittree.commit` |
| `Ctrl+Shift+K` (`Cmd+Shift+K`) | Push… | `gittree.push.dialog` |
| `Ctrl+T` (`Cmd+T`) | Update Project | `gittree.update.dialog` |
| `Alt+9` (`Cmd+9`) | Git tool window | `gittree.log.focus` |
| `Ctrl+Alt+Z` (`Cmd+Alt+Z`) | Rollback | `gittree.rollbackFile` (active file) |

**Known conflicts when enabled** (deliberate — this is what "IntelliJ
flavor" means; disable the setting to restore the defaults):

- `Ctrl+K` shadows VS Code's chord prefix (e.g. `Ctrl+K Ctrl+S`). The
  binding is suppressed while the terminal has focus.
- `Ctrl+Shift+K` shadows *Delete Line*; `Ctrl+T` shadows *Go to Symbol in
  Workspace* (IntelliJ users expect these keys for VCS, and both remain
  reachable via the palette).

Both open the P13 dialogs rather than acting silently, matching IntelliJ. The
no-questions commands are still there — `gittree.push` and `gittree.pull` — and
`Ctrl+T` becomes a direct action once you tick *Do not show again* in the Update
Project dialog (restore it with **GitTree: Update Project Strategy…**).

## Webview-internal keys

The log and rebase webviews implement roving-tabindex lists (one `Tab` stop;
arrows move within):

**Git log (`gittree.log` view)**

| Key | Action |
| --- | --- |
| `↑` / `↓` / `PageUp` / `PageDown` / `Home` / `End` | move through commits (virtualized, 100k-safe) |
| `Enter` / `Space` | open commit details |
| `Ctrl+C` (`Cmd+C`) | copy selected revision number(s) |
| `Ctrl+Click` / `Shift+Click` | multi-select (keyboard: arrows + details panel actions) |
| `Tab` | filter chips → search box → regex/case toggles → sort → list |

**Interactive rebase editor**

| Key | Action |
| --- | --- |
| `↑` / `↓` | move focus through plan rows |
| `Alt+↑` / `Alt+↓` | reorder the focused row |
| `p` / `r` / `s` / `f` / `d` | set action: pick / reword / squash / fixup / drop |
| `Enter` / `F2` | edit message (reword/squash rows) |
| `Ctrl+Enter` / `Escape` | commit / cancel the message edit |

**Merge tri-editor** — see the default bindings above (`F7`, `Alt+Enter`,
`Ctrl+Alt+Enter`); all three panes are ordinary editors, so VS Code's own
editor navigation applies.

## Accessibility provisions

- **Roving tabindex** in all virtualized lists (`VirtualList`, rebase plan):
  `role="listbox"`/`option`, `aria-posinset`/`aria-setsize` so screen readers
  report "n of 100000" without the DOM holding 100k rows.
- **Screen-reader labels on graph rows**: each log row carries
  `aria-label="commit <subject> by <author>, <relative date>, branch <refs>"`
  (the canvas graph itself is `aria-hidden` — it is a visual duplicate of
  the row/ref data).
- **`aria-live` regions** for async loads: the log announces
  "Loading commits…" → "N commits loaded(, end of history)"; the rebase
  editor's execution log is `aria-live="polite"` and its pause/error banners
  are `role="alert"`.
- **Focus visibility**: global `:focus-visible` outline using
  `--vscode-focusBorder` in every webview.
- **High contrast / forced colors**: webviews use `--vscode-*` variables
  exclusively (no hardcoded chrome colors); a `forced-colors: active` block
  maps selected/toggled states to `SelectedItem`/`SelectedItemText` system
  colors so Windows High Contrast themes stay legible.
- **Reduced motion**: `prefers-reduced-motion: reduce` disables all webview
  transitions/animations and forces instant scrolling.
- **Color-blind-safe graph**: `"gittree.log.graphPalette": "colorBlind"`
  switches the commit graph and ref chips to the Okabe–Ito palette
  (distinguishable under deutan/protan/tritan vision), with separate
  light/dark ramps for contrast. Applies live on settings change.

## Manual audit checklist (2026-07-16)

- [x] Log webview: complete tab order (chips → search → toggles → sort → list → details panel)
- [x] Log list: roving tabindex, `aria-posinset/setsize`, per-row `aria-label` (IntelliJ wording)
- [x] Log async loads announced via `aria-live=polite` (Playwright-asserted)
- [x] Rebase webview: roving tabindex, reorder/action/edit fully keyboard-driven, `aria-live` log, `role=alert` banners
- [x] Merge tri-editor: `F7`/`Shift+F7`/`Alt+Enter`/`Ctrl+Alt+Enter` cover next/prev/accept/apply
- [x] Diff editors: stage/unstage/revert selected ranges have keybindings or palette commands
- [x] Focus-visible outlines in all webviews (`--vscode-focusBorder`)
- [x] `forced-colors` (Windows High Contrast) block added; webviews use theme variables only
- [x] `prefers-reduced-motion` respected (no webview animations remain)
- [x] Color-blind-safe palette setting end-to-end (setting → host → canvas + chips, live update)
- [x] Every mouse affordance has a command-palette route; no mouse-only feature found in the audit
- [x] IntelliJ keymap set shipped behind `gittree.keymap.intellij`

## Keyboard-only walkthrough (test notes, 2026-07-16)

Recorded against a local fixture repo (no mouse, Windows 11, NVDA
sanity-spot-checks on the log list). "Clone" is exercised as `git init` +
fixture commits since this project performs no remote operations
(see PHASE-10 Deviations).

1. **Open repo** — `Ctrl+K Ctrl+O` → type path → `Enter`. GitTree activates;
   SCM view reachable via `Ctrl+Shift+G`.
2. **Branch** — `Ctrl+Shift+P` → "GitTree: New Branch" → name → `Enter`.
   Status bar updates announced.
3. **Edit** — open file (`Ctrl+P`), edit, save. Dirty badge appears in SCM.
4. **Resolve conflict** — merge a conflicting fixture branch (palette →
   "GitTree: Checkout", then merge); conflict editor opens via the SCM item
   (`Ctrl+Shift+G`, arrows, `Enter`); `F7` to first conflict, `Alt+Enter`
   accepts the focused side, `Shift+F7` back to verify, `Ctrl+Alt+Enter`
   applies the result.
5. **Commit** — `Ctrl+Shift+G`, `Tab` to the message box (or `Ctrl+K` with
   the IntelliJ keymap enabled), type message, `Ctrl+Enter` commits.
   `Ctrl+Up` recalls message history.
6. **Log** — `Ctrl+Alt+G F` reveals the log with the search box focused;
   type to filter; `Tab` to the list; arrows/`PageDown` navigate (screen
   reader reads "commit <subject> by <author>…"); `Enter` opens details;
   `Ctrl+C` copies the revision.
7. **Rebase** — palette → "GitTree: Interactive Rebase…" → pick base via
   quick-pick; in the editor: arrows to a row, `r` + `Enter` to reword,
   `Alt+↓` to reorder, `Tab` to Start, `Enter`. Progress announced via the
   live-region log.

Result: every step completed without a pointing device.

**HC screenshots**: the acceptance criterion says "HC screenshots attached
to PR" — this project has no remote and no PRs (project-owner decision, see
`docs/plan/PHASE-10-hardening-release.md` → Deviations). Verified locally
instead by switching to the "High Contrast" and "High Contrast Light" themes
plus Windows Contrast Themes (forced-colors) and walking the log/rebase/merge
surfaces; no illegible or invisible states found.
