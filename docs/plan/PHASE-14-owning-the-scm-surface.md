# Phase 14 — Owning the SCM Surface (Tier 1)

**Goal:** remove GitTree's remaining dependence on VS Code's SCM framework and on the built-in
Git extension's UI surfaces. GitTree stops registering a `vscode.scm` SourceControl, stops
contributing to `scm/*` menus, stops hosting its views inside VS Code's Source Control
container, stops reading or writing another extension's configuration, and paints its own
change bars and change popup. Route A of `docs/deviations.md` D1 lands with it: GitTree-owned
controls on its own diffs, including IntelliJ's cross-file change navigation.

**Depends on:** P11 (commit tool window — the replacement for the native commit surface),
P12-T3 (Changed Files pane — supplies the file ordering for cross-file navigation),
P1-T3 (`core/patch` — `lineDiff` / `patchBuilder` supply the hunk math for own change bars).
**Exit criteria:** `vscode.scm` appears nowhere in `src/`; `package.json` contributes zero
`scm/*` menu entries and hosts zero views in the `scm` container; no code path reads or writes
`git.*` configuration — with one deliberate, temporary exception, the T6.1 migration that
*removes* GitTree's own earlier `git.enabled` override and is itself deleted a release later;
change bars, the change popup and diff navigation are GitTree's own; enabling or disabling the
built-in Git extension changes nothing about how GitTree behaves.

> **Supersedes master §3 in full.** `IMPLEMENTATION_PLAN.md` §3 ("Coexistence with the built-in
> Git extension") defines Takeover/Companion and makes writing `git.enabled: false` into the
> user's workspace the price of a native-looking install. That decision assumed GitTree needed
> VS Code's SCM chrome to look native. P11–P13 removed the need: the commit surface, the log,
> the dialogs and the popups are all GitTree-owned already. What survives of §3 is a consent
> modal that mutates a third party's settings to win a UI slot GitTree no longer wants. This
> phase deletes both the mechanism and the reason for it.
>
> **Master §6's "reuse the native diff editor" decision is kept.** T7 dresses it (Route A);
> it does not replace it. Route B stays gated behind the spike D1 already prescribes.

---

## Measured constraints (spike, 2026-08-23)

These were measured on VS Code 1.134 rather than assumed; T3 and T7 are specified around them.
Anything here that turns out false invalidates a task, not a detail.

| Measurement | Result |
|---|---|
| VS Code's native change bar column | x **431–434** (4px), between line numbers and text |
| `gutterIconPath` SVG decoration | x **377–378** (2px) — glyph margin, **left** of line numbers, shares the lane with breakpoints |
| `isWholeLine` + left border decoration | x **462–465** (4px) — content edge, **31px right** of native, exact width match |
| `activeTextEditor` inside a `vscode.diff` editor | resolves, and is the **modified** side; `.selection` and `revealRange` both drive it |
| Tab identity for a diff | `TabInputTextDiff` exposes `.original` and `.modified` URIs |
| Opening the next file's diff and landing on its first hunk | works end to end |
| VS Code's built-in next/prev-change toolbar arrows | **cannot** be unregistered by an extension; ours sort ahead of them |

Coordinates are at `window.zoomLevel: 2` (≈1.44×). The border technique is chosen for T3 on
width fidelity and because the glyph margin is the breakpoint lane.

Recorded in passing, not a Phase 14 task: **VS Code's built-in git extension serves no quick
diff and no file decorations for repositories under a Windows 8.3 short path** (it still shows
the branch in the status bar, so the failure is silent). GitTree is already immune —
`src/core/util/paths.ts` canonicalizes both sides. Worth a line in the parity audit as an area
where owning the implementation is strictly better.

---

## Tasks

### P14-T1 · GitTree activity-bar container
**Depends:** — · **Complexity:** S
**Output files:** `package.json`, `package.nls.json`, `media/gittree-activitybar.svg`.
**Steps:**
1. Add `contributes.viewsContainers.activitybar` entry `gittree` titled `%gittree.container.title%`
   with a monochrome 24×24 `currentColor` SVG. VS Code themes activity-bar icons by fill, so a
   flat single-path mark is required — no embedded colors, no strokes that vanish in HC.
2. Repoint all ten `contributes.views.scm` entries to `contributes.views.gittree`, order
   unchanged (`gittree.commit` stays first); T2 then deletes two of the ten as superseded.
   **View IDs do not change**, so every
   `when` clause, `view/title` and `view/item/context` contribution, `TreeView` registration and
   test lookup keeps working untouched.
3. `gittree.log` stays in the `gittree-panel` panel container — Git tool window at the bottom is
   the §2A shape and is already correct.
4. Walkthrough steps, `docs/keyboard.md` and the readme that say "Source Control sidebar" are
   re-pointed at the GitTree container.
**Accept:** integration — all ten views resolve and render from the new container (extend the
existing view-registration assertions); no view resolves in the `scm` container; the badge and
`view/title` toolbars of `gittree.branches` and `gittree.stashes` are unchanged from P12/P13
baselines. Manual: icon legible in light, dark and high-contrast themes.

### P14-T2 · Retire the native commit surface
**Depends:** P14-T1, P11 · **Complexity:** M
**Output files:** `package.json`, `src/scm/sourceControl.ts`, `src/scm/fileOps.ts`,
`src/commit/register.ts`, `test/integration/setup.ts`,
`test/integration/suite/{phase01,phase03,phase05,phase11}.test.ts`.
**Steps:**
1. Delete the setting `gittree.commit.window`, the command `gittree.commit.window.toggle`, the
   context key `gittree.commitWindow` and `commitWindowMode()`. The webview window has been the
   default for a full phase with 29 dedicated tests; maintaining a second commit surface taxes
   every future commit-window feature.
2. Delete the four `SourceControlResourceGroup`s and all **34** `scm/*` menu entries
   (`scm/title` 17, `scm/resourceState/context` 9, `scm/resourceGroup/context` 5,
   `scm/change/title` 3). The `scm/change/title` three move to the T3 change popup; the rest are
   already duplicated by the commit window's own toolbar and context menus.
3. Delete the views `gittree.changelists` and `gittree.shelf` — both were gated
   `commitWindow == native` and are superseded by the commit window's change tree and Shelf tab.
   `gittree.commit.paradigm` (`changelists|staging`) is **unaffected**: it selects the model, and
   the commit window renders both.
4. `messageBoxFor(repo)` becomes the only commit-message path; drop the
   `vscode.SourceControlInputBox` branch from `CommitFlowDeps.inputBoxFor`. The structural
   `CommitMessageBox {value: string}` type introduced in P11-T2 already makes this a deletion,
   not a rewrite.
5. Tests: `useCommitWindow()` is deleted from `test/integration/setup.ts` and the **8**
   `inputBox` references across phase01 (3), phase03 (2), phase05 (3) are repointed at the
   commit window's message box. This is a net gain in coverage — those 35 tests currently
   exercise a fallback almost nobody runs; afterwards they exercise the shipping surface.
   phase11's two native-mode tests are deleted with the mode.
**Accept:** `grep -r "createResourceGroup\|scm/resourceState\|commitWindow" src/ package.json`
returns nothing; integration — phase01/03/05 pass driving the webview message box, and a commit
made through it lands with the expected message; the commit window remains the only place a
message can be typed.

### P14-T3 · Own change bars and the change popup
**Depends:** P1-T3 · **Complexity:** L
**Output files:** `src/scm/gutter/{changeBars.ts,changeModel.ts,changePopup.ts}`,
`src/scm/hunkActions.ts` (simplified), `package.json` (colors, commands, keybindings).
**Steps:**
1. `changeModel.ts` — **pure, vscode-free, unit-tested**: given base text and modified text,
   returns `Change[] {kind: 'added'|'modified'|'deleted', startLine, endLine}` over
   `lineDiff.lcsBlocks`, plus `changeAt(line)`, `nextChange(line)`, `prevChange(line)`. The
   deleted marker anchors to the line *after* the removal, matching IntelliJ.
2. `changeBars.ts` — three `TextEditorDecorationType`s using `isWholeLine: true` +
   `borderWidth: '0 0 0 3px'` + `borderColor` (see the measured constraints table), each with
   `overviewRulerColor` + `overviewRulerLane.Left` so the scrollbar marks come along. Base text
   is `:0` or `HEAD` per the base setting (T5.4), cached per `(repo, path, baseRev)` and
   invalidated on `RepositoryModel` refresh. Recompute is debounced 150 ms on document change
   and skipped entirely above `gittree.changeBars.maxFileLines` (default 20 000), with the
   overview ruler still populated from the last good result.
   Precedent for the pattern: `src/merge/triEditor.ts:631` already runs five decoration types
   with overview-ruler lanes.
3. `changePopup.ts` — replaces the native dirty-diff peek widget, which has no API. Two
   invocations, because **VS Code exposes no click handler for a decoration**:
   - a `HoverProvider` scoped to changed line ranges only (never the whole file), rendering a
     trusted `MarkdownString`: the previous text in a fenced block plus command links
     `Rollback · Stage · Show Diff · ↑ ↓`;
   - `gittree.change.showActions`, keybound, acting on the change at the cursor.
   A `CodeLens` variant is rejected: it consumes a text line per change, which IntelliJ's
   marker does not.
4. `hunkActions.ts` keeps its three handlers unchanged but loses `parseArgs` — arguments now come
   from our own model instead of untrusted peek-widget payloads, so the defensive `isLineChange`
   validation goes with it.
5. Bars render regardless of whether the built-in git extension is enabled (T6 owns the one
   remaining reason to suppress them).
**Accept:** unit — `changeModel` against fixtures covering added / modified / deleted /
adjacent / whole-file-replaced / empty-file / no-trailing-newline, and `nextChange` wrapping
behaviour at both ends; integration — editing a tracked file paints bars on exactly the changed
lines and clears them on revert; `Rollback` from the popup restores the original bytes (CRLF
intact); the hover fires on a changed line and **not** on an unchanged one; a file above the
cutoff paints no bars and logs the reason. Perf: a new `test:perf` budget — change-bar recompute
p95 < 50 ms on a 5 000-line file.

### P14-T4 · Delete the SourceControl
**Depends:** P14-T2, P14-T3 · **Complexity:** M
**Output files:** deleted `src/scm/sourceControl.ts`, `src/scm/quickDiff.ts`; rewritten
`src/ui/statusBar.ts`, `src/scm/register.ts`; `package.json`.
**Steps:**
1. Delete `GitTreeSourceControl` and `GitTreeQuickDiffProvider`/`wireQuickDiff`. This is the last
   `vscode.scm` reference; after it GitTree no longer appears in VS Code's Source Control view at
   all — today, even a stripped SourceControl would leave a "GitTree" provider header row, since
   the 1.96 API has no `visible`/`hidden` on `SourceControl`.
2. Status bar: `renderStatusBar()` is already pure and unit-tested — keep it, and swap the sink
   from `SourceControl.statusBarCommands` to `window.createStatusBarItem`
   (`StatusBarAlignment.Left`, priority just above the built-in git item's so ordering is stable
   when both are installed). One item per repo, same text and commands as today.
3. Count badge: `SourceControl.count` → `WebviewView.badge` on `gittree.commit`. That view is a
   *webview* view, not a tree view; `badge` exists on both interfaces in 1.96.
4. `acceptInputCommand` → a `contributes.keybindings` entry binding `ctrl+enter` /`cmd+enter` to
   `gittree.commit` with `when: focusedView == gittree.commit`.
5. `gittree.quickDiff.base` is renamed `gittree.changeBars.base` with a one-release read-through
   shim: if the old key is set and the new one is not, adopt it and write the new key.
**Accept:** `grep -r "vscode\.scm\|SourceControl" src/` returns nothing; integration — the status
bar shows branch and ahead/behind and its commands still dispatch; the commit view carries the
change count as a badge; `Ctrl+Enter` in the commit window commits; VS Code's Source Control view
contains no GitTree entry with the built-in git extension enabled.

### P14-T5 · Own theme colors; drop the last built-in-git couplings
**Depends:** P14-T3 · **Complexity:** S
**Output files:** `package.json` (`contributes.colors`), `src/scm/resourceDecorations.ts`,
`src/scm/fileDecorations.ts`, `src/merge/conflictsView.ts`,
`src/commit/changelists/changelistsView.ts`, `webview-ui/src/lib/status.ts`; deleted
`src/merge/nativeBridge.ts`.
**Steps:**
1. Contribute `gittree.color.{added,modified,deleted,untracked,ignored,conflicted}` with defaults
   taken from the current `gitDecoration.*` values, and repoint all ~18 `ThemeColor` call sites.
   Today those IDs are contributed by the built-in git extension: disable it and GitTree's tree
   rows fall back to plain foreground. This also makes the P11-T8 `gittree.colors.*` webview
   overrides and the native tree views read from one source.
2. Delete `src/merge/nativeBridge.ts`, the `gittree.merge.ui` setting's `native` value and the
   phase06 test that pins it. `_open.mergeEditor` is an internal underscore-prefixed command and
   the only genuinely unstable API GitTree touches; `triEditor` has been the default throughout
   and the bridge already falls back to it silently.
3. Remove the `git.path` read at `src/core/core.ts:260` **and** the `builtinGitPath` option it
   feeds — `GitExecutorSettings.builtinGitPath` (`src/core/git/executor.ts:344`) and its
   candidate-list entry at `:355`. It reads a *setting* rather than calling the extension, so it
   is harmless — but "we never read `git.*`" is a cleaner and more auditable rule than "we read
   one key". `gittree.gitPath`, `PATH` and the well-known install paths remain as candidates;
   the migration note in T8 tells affected users to set `gittree.gitPath`.
4. `gittree.changeBars.base` (from T4.5) is documented as GitTree's own concept rather than a
   mirror of VS Code's quick-diff base.
**Accept:** unit — every status kind maps to a `gittree.color.*` ID and none to `gitDecoration.*`;
integration — with the built-in git extension disabled, tree rows still render status colors (the
regression this task exists to prevent); `gittree.merge.ui` no longer accepts `native`; a repo
resolves its git binary with no `git.path` set.

### P14-T6 · Retire ModeManager; migrate takeover workspaces
**Depends:** P14-T3, P14-T4 · **Complexity:** M
**Output files:** deleted `src/core/modeManager.ts`; `src/core/core.ts`,
`src/scm/fileDecorations.ts`, `package.json`, new `src/core/migrations/unsetGitEnabled.ts`.
**Steps:**
1. **Migration first, and it is the important half.** Any workspace that consented to takeover
   has `git.enabled: false` written into its workspace settings by `setBuiltinGitEnabled(false)`.
   Deleting the manager without undoing that would strand users with the built-in extension
   permanently off and nothing left that knows why. On first activation after upgrade: if
   `workspaceState[MODE_STATE_KEY] === 'takeover'`, run the `git.enabled` update from
   `core.ts:302-306` **once** with `undefined` to remove the workspace override, clear
   `MODE_STATE_KEY`, and show a **non-modal** notification explaining that GitTree no longer
   needs the built-in extension disabled. This is the one and only surviving `git.*` write, it
   exists solely to undo a previous one, and it is deleted with the migration a release later.
   Idempotent; records completion under its own workspaceState key.
2. Delete `ModeManager`, `GitTreeMode`, `ConsentChoice`, the consent modal, the `gittree.mode`
   setting and every `effectiveMode` branch. GitTree stops writing to another extension's
   configuration entirely.
3. One reason to suppress a surface survives: with the built-in git extension enabled, **explorer
   file decorations** would double. Replace the mode machinery with a single boolean
   `gittree.decorations.fileExplorer` (default `true`) and, when the built-in extension is
   present *and* enabled, default the effective value to `false` once via the same migration —
   detected by reading `extensions.getExtension('vscode.git')?.isActive`, which is an
   observation, not a dependency. Change bars do **not** need this: ours sit at the content edge
   and VS Code's in its own lane, so the two are distinguishable rather than overlapping — but
   the setting also covers them for users who want exactly one.
4. `gittree.commit.paradigm`, `gittree.changeBars.*` and every other GitTree setting are
   untouched.
**Accept:** unit — the migration is idempotent, no-ops when the mode was never `takeover`, and
never writes `git.enabled` to any value other than "removed"; integration — a workspace seeded
with `git.enabled: false` plus persisted takeover comes up with the override gone and the
notification shown once; `grep -r "git\.enabled\|gittree\.mode" src/` returns only the migration.

### P14-T7 · Diff editor: own controls and cross-file change navigation
**Depends:** P12-T3 · **Complexity:** M
**Output files:** `src/diff/{diffSession.ts,diffNavigation.ts,diffControls.ts}`,
`src/scm/fileOps.ts` and the other 16 `vscode.diff` call sites (registration only),
`package.json`.
**Steps:**
1. `diffSession.ts` — a registry of the diffs GitTree opens. Every existing `vscode.diff` /
   `vscode.changes` call site registers `{files: [...], index, base, title, origin}` at open
   time. **This is the whole feature**: VS Code wraps to the top of the same file because a diff
   editor knows only two documents and has no concept of a file sequence. GitTree already holds
   the sequence — the commit's changed-file list, the compare result, the stash contents.
   Identity comes from `TabInputTextDiff.original`/`.modified` off the active tab, so the
   session is recovered from the editor rather than tracked by hand.
2. `diffNavigation.ts` — `gittree.diff.nextChange` / `prevChange`:
   ```
   next = first change starting after the cursor          (changeModel, T3)
   if next        -> reveal + select
   else if armed  -> open the next file's diff at its first change; disarm
   else           -> arm (3 s), show "Press again to go to the next file"
   ```
   That is IntelliJ's two-stage gesture, including the hint, and it is the behaviour this phase
   was asked for by name. The hint is a transient decoration at the cursor line (the T3 popup
   mechanism), not a notification. At the last change of the last file the hint says so and the
   second press is a no-op rather than a wrap.
3. `diffControls.ts` + `editor/title/navigation` contributions scoped
   `when: isInDiffEditor && gittree.diff.active`, contributing GitTree's own `↑`/`↓` plus the
   Route A controls D1 enumerates as reachable: side-by-side/inline toggle
   (`diffEditor.renderSideBySide`), ignore-whitespace (`diffEditor.ignoreTrimWhitespace`), and
   collapse-unchanged (`diffEditor.hideUnchangedRegions.enabled`) — written at workspace scope so
   they behave as view options rather than hidden preferences.
4. Keybindings `F7` / `Shift+F7` (IntelliJ's), gated on `config.gittree.keymap.intellij` and
   `when`-scoped to a GitTree diff so the core `F7` word-highlight binding is untouched
   elsewhere; `Alt+F5`-style users keep VS Code's own arrows, which remain (D20).
**Accept:** unit — the navigation state machine (next-within-file, arm, cross-file, last-change
terminal, disarm on timeout, disarm on cursor move) as a pure table-driven test; integration —
opening a 3-file commit diff and pressing next repeatedly walks every change of every file in
order and stops at the end; the arm state expires; the controls appear only on GitTree diffs and
not on an unrelated `vscode.diff`; toggling ignore-whitespace re-renders without losing the
cursor.

### P14-T8 · Parity re-audit, deviations, migration docs
**Depends:** T1–T7 · **Complexity:** M
**Output files:** `IMPLEMENTATION_PLAN.md` (§3 superseded), `FEATURES.md`,
`docs/parity-audit.md`, `docs/deviations.md`, `docs/migration-from-builtin.md`, `docs/faq.md`,
`docs/keyboard.md`, `docs/perf.md`, `readme.md`, `CHANGELOG.md`, `docs/plan/PROGRESS.md`.
**Steps:**
1. `IMPLEMENTATION_PLAN.md` §3 is replaced by a short statement that GitTree no longer coexists
   *by negotiation* — it simply does not compete for the built-in extension's surfaces. The old
   Takeover/Companion table is kept in place as struck-through history, because PROGRESS.md and
   six phase docs reference it and silently deleting it would orphan them.
2. `docs/migration-from-builtin.md` and `docs/faq.md` are rewritten around the new answer: you no
   longer have to choose, nothing is disabled on your behalf, and here is what changed if you had
   takeover on. Document the `git.path` removal (T5.3) and the `gittree.quickDiff.base` rename.
3. `FEATURES.md` shape criteria updated for the surfaces that moved: the container is GitTree's
   own, change bars and the change popup are GitTree's, diff navigation is GitTree's.
4. `docs/deviations.md`: **D1 is downgraded, not closed** — Route A shipped, Route B still gated;
   restate what remains. Add **D18–D21** (below). D4 is unaffected. Remove nothing.
5. `docs/parity-audit.md` re-scored; record the 8.3-short-path finding as an area where GitTree's
   implementation is strictly more correct than the built-in extension's.
6. `docs/perf.md` gains the T3 change-bar budget and its measured run.
**Accept:** no document still describes Takeover/Companion as current behaviour; `docs:settings`
regenerated; `npm run check` + `test:integration` + `test:webview` + `test:perf` green; the
`FEATURES.md` shape criteria match what the build actually renders.

---

## Contributions added this phase
Container `gittree` (activitybar). Commands `gittree.change.showActions`,
`gittree.diff.nextChange`, `gittree.diff.prevChange`, `gittree.diff.toggleSideBySide`,
`gittree.diff.toggleIgnoreWhitespace`, `gittree.diff.toggleCollapseUnchanged`.
Colors `gittree.color.{added,modified,deleted,untracked,ignored,conflicted}`.
Settings `gittree.changeBars.base` (renamed from `gittree.quickDiff.base`),
`gittree.changeBars.maxFileLines`, `gittree.decorations.fileExplorer`.
Keybindings `ctrl+enter` (commit, `focusedView == gittree.commit`), `F7`/`Shift+F7`
(diff navigation, IntelliJ keymap only).

**Removed:** views `gittree.changelists`, `gittree.shelf`; settings `gittree.commit.window`,
`gittree.mode`, `gittree.merge.ui: native`; command `gittree.commit.window.toggle`;
all 34 `scm/*` menu entries; the mode consent modal.

## Parity checklist
- [ ] No `vscode.scm` SourceControl is registered; GitTree does not appear in VS Code's Source Control view *(P14-T4)*
- [ ] All views live in GitTree's own activity-bar container, not VS Code's `scm` container *(P14-T1)*
- [ ] Zero `scm/*` menu contributions *(P14-T2)*
- [ ] GitTree reads no `git.*` configuration and writes none, except the one-shot migration that removes its own earlier override; no consent modal *(P14-T5, P14-T6)*
- [ ] Existing takeover workspaces are migrated back and told why *(P14-T6.1)*
- [ ] Change bars are GitTree-painted and work with the built-in extension enabled or disabled *(P14-T3)*
- [ ] The change popup replaces the native peek with Rollback / Stage / Show Diff / navigate *(P14-T3.3)*
- [ ] Status colors come from `gittree.color.*` and survive the built-in extension being disabled *(P14-T5.1)*
- [ ] No internal (underscore-prefixed) VS Code command is called anywhere *(P14-T5.2)*
- [ ] D1 Route A: GitTree's own controls on GitTree's diffs *(P14-T7.3)*
- [ ] Cross-file change navigation with IntelliJ's two-stage "press again for the next file" hint *(P14-T7.2)*

## Planned deviations
- **D18 · Change bars sit at the content edge, not VS Code's quick-diff lane.** VS Code paints
  quick diff in an internal "line decorations" lane between the line numbers and the text; no
  public decoration API targets it. Measured: native x=431, ours x=462 at `zoomLevel: 2` (≈21px
  at 100%). The glyph-margin alternative is 37px the other way and shares the lane with
  breakpoints. *Revisitable: only if VS Code exposes the lane.*
- **D19 · The change popup is hover- and keyboard-invoked, not click-on-the-bar.** VS Code
  exposes no click handler for a `TextEditorDecorationType`, and no API opens a diff peek widget
  at a location. IntelliJ's popup is reproduced in content (previous text + actions), not in
  trigger. *Revisitable: no.*
- **D20 · VS Code's built-in next/prev-change arrows remain in the diff toolbar beside
  GitTree's.** Extensions cannot unregister core menu items; ours sort ahead of them, and users
  can hide the built-ins from the toolbar context menu. *Revisitable: only via Route B, which
  would replace the editor entirely.*
- **D21 · Change-bar anchoring may differ from VS Code's by one line on ambiguous boundaries.**
  GitTree computes its own hunks; where an insertion sits between two blank lines the anchor is
  genuinely ambiguous and the two algorithms may choose differently. Both are correct diffs.
  *Revisitable: no (inherent to owning the diff).*
- **D1 is downgraded, not closed.** Route A ships here; the Differences Viewer's own renderer
  (side-by-side/unified/line-by-line, highlight granularity, per-change apply arrows, align
  changes) stays deviated behind the spike gate D1 already prescribes.
