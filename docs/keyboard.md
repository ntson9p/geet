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
| `Ctrl+Up` (`Cmd+Up`) | `gittree.commit.showMessageHistory` | commit tool window message editor |
| `Ctrl+Enter` (`Cmd+Enter`) | `gittree.commit` | commit tool window — replaces the SCM input box's accept action (P14-T4) |
| `Ctrl+Alt+Enter` | `gittree.stage.selectedRanges` | diff editor — stages the selected lines/hunk |
| `F7` / `Shift+F7` | `gittree.merge.nextConflict` / `prevConflict` | merge tri-editor |
| `Alt+Enter` | `gittree.merge.acceptFocusedSide` | merge tri-editor — chevron accept |
| `Ctrl+Alt+Enter` | `gittree.merge.apply` | merge tri-editor (outside diff editors) |
| `Ctrl+Alt+G F` (`Cmd+Alt+G F`) | `gittree.log.focusFilter` | anywhere — reveals the log and focuses its search box |
| `Ctrl+Alt+G B` (`Cmd+Alt+G B`) | `gittree.blame.toggle` | text editor — toggle blame annotations |
| `Ctrl+Alt+G H` (`Cmd+Alt+G H`) | `gittree.change.showActions` | text editor — actions for the change under the cursor (P14-T3) |

The `Ctrl+Alt+G …` bindings are chords (press `Ctrl+Alt+G`, release, then
the second key) so they cannot collide with VS Code defaults.

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
| ``Alt+` `` (`Ctrl+V`) | VCS Operations Popup | `gittree.operationsPopup` |
| `Ctrl+Alt+N` (`Cmd+Alt+N`) | New Branch… | `gittree.branch.new` |
| `F2` | Rename branch (in the Branches view) | `gittree.branches.rename` |
| `Ctrl+Alt+Z` (`Cmd+Alt+Z`) | Rollback | `gittree.rollbackFile` (active file) |
| `F7` / `Shift+F7` | Next / Previous Difference | `gittree.diff.nextChange` / `prevChange` (GitTree diffs only) |

**Known conflicts when enabled** (deliberate — this is what "IntelliJ
flavor" means; disable the setting to restore the defaults):

- `Ctrl+K` shadows VS Code's chord prefix (e.g. `Ctrl+K Ctrl+S`). The
  binding is suppressed while the terminal has focus.
- `Ctrl+Shift+K` shadows *Delete Line*; `Ctrl+T` shadows *Go to Symbol in
  Workspace* (IntelliJ users expect these keys for VCS, and both remain
  reachable via the palette).
- `F7`/`Shift+F7` are shared with the merge tri-editor (same IntelliJ
  meaning: next/previous difference) and with VS Code's *Go to Next Symbol
  Highlight*. Each binding is `when`-scoped — the diff one requires
  `gittree.diff.active`, the merge one `gittree.merge.triEditorActive` — so
  only one is ever live, and neither fires in an ordinary editor.

**Why GitTree's diff arrows and not VS Code's:** VS Code's next-change button
wraps back to the top of the *same* file at the last change. GitTree's walks
into the next file in the changed-files list, IntelliJ-style: the first press
at the boundary announces which file is next, the second press goes there, and
the end of the last file stops rather than wrapping. Both sets of arrows appear
in the diff toolbar — an extension cannot remove a built-in one — and GitTree's
sort first (deviation D20).

Both open the P13 dialogs rather than acting silently, matching IntelliJ. The
no-questions `gittree.pull` is still in the palette; the no-questions push is not
since POST-P14ao — IntelliJ has no Push without its dialog — and
`Ctrl+T` becomes a direct action once you choose *Don't Ask Again* on an update's
result (restore the question with **GitTree: Update Project Strategy…**).

## Webview-internal keys

The log and rebase webviews implement roving-tabindex lists (one `Tab` stop;
arrows move within):

**Git log (`gittree.log` view)**

| Key | Action |
| --- | --- |
| `↑` / `↓` / `PageUp` / `PageDown` / `Home` / `End` | move through commits (virtualized, 100k-safe) |
| `Enter` / `Space` | open commit details |
| `Ctrl+C` (`Cmd+C`) | copy selected revision number(s) |
| `Ctrl+Click` (`Cmd+Click`) | add or remove one commit from the selection |
| `Shift+Click` / `Ctrl+Shift+Click` | select the run from the anchor / add it to the selection |
| `Shift+↑` / `Shift+↓` / `Shift+PageUp` / `Shift+PageDown` / `Shift+Home` / `Shift+End` | grow or shrink the selected run from the anchor |
| `Ctrl+A` (`Cmd+A`) | select every loaded commit |
| `Tab` | filter chips → search box → regex/case toggles → Graph Options → list |
| `Enter` / `Space` (Graph Options) | open its menu; `↑`/`↓` move over the rows (the Sort and Options captions are skipped), `Enter` ticks one |
| `←` / `→` / `Home` / `End` (tab strip) | move between Log, Console, Worktrees and the extra Log tabs |
| `Shift+F10` / context-menu key (tab strip) | the tab menu: Close Tab · Close Other Tabs · Close All Tabs — the keyboard's way to close a tab |
| Middle-click (tab strip) | close an extra Log tab |
| Drag / double-click (a column's left border) | resize a column / fit it to its content again. Pointer-only: a width is cosmetic, and the columns themselves are switched from Presentation Settings ▸ Columns (keyboard-reachable) or the `gittree.log.columns.*` settings |

**Branches panel (`gittree.branches` view)**

| Key | Action |
| --- | --- |
| `↑` / `↓` / `PageUp` / `PageDown` / `Home` / `End` | move through the rows |
| `→` / `←` | open / close a section, remote or folder; on a branch, open / close its card |
| `Enter` / `Space` | the same as a click: open or close a section, folder or a branch's card; on a repository, show only its branches (`Ctrl+Enter`: add it to what is shown) |
| `Tab` (card open) | into the card's buttons |
| `Shift+F10` / context-menu key | the focused row's menu |
| `F2` / `Delete` | rename / delete the focused local branch (one repository) |
| any letter, `Ctrl+F` | start filtering |
| `↓` / `Enter` / `Escape` (filter) | into the list / open the first match / clear the filter |
| `Enter` / `Escape` (New Branch form) | create / cancel |

**Push dialog**

| Key | Action |
| --- | --- |
| `↑` / `↓` / `PageUp` / `PageDown` / `Home` / `End` | move through the repositories and commits; with `Shift`, select the run |
| `Ctrl+Click` / `Shift+Click`, `Ctrl+A` | select several commits — the changes show all of theirs |
| `→` / `←` | open / close a repository (several repositories); on a commit, back to its repository |
| `Space` | tick or untick the selected rows' repositories |
| `F2` | edit the selected repository's target branch |
| `Alt+F2` | `Edit all targets` (several repositories) |
| `Enter` / `Escape` (editing) | apply / cancel the target; with the suggestions open, pick one / close them |
| `↓` / `↑`, `Ctrl+Space` (editing) | open and move through the suggestions |
| `Enter` | Push |
| `Ctrl+D` / `F4` (changes) | Show Diff / Edit Source |
| `Escape` | close the dialog |

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
