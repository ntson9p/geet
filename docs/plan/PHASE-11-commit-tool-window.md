# Phase 11 — The Commit Tool Window (Tier 1)

**Goal:** close gap-analysis **S1, S11, S12, S13, S14** — replace the VS Code SCM-sidebar
commit surface with an IntelliJ-shaped Commit tool window: `Commit | Shelf` tabs, an
8-icon toolbar, a folder-structured change tree with tri-state inclusion checkboxes and
per-node file counts, a real multi-line message editor, and the commit-options gear popup.
Target shape is `docs/intellij-gap-analysis.md` §2A ("Commit tool window", "Diff opened
*from* the commit window", "Commit options gear popup", "Shelve Changes dialog").

**Depends on:** P0-T9 (webview platform), P3 (ParadigmManager, ChangelistService, commit
executors, CheckPipeline), P7 (shelf store), P1-T3 (`core/patch`).
**Exit criteria:** a user commits by *ticking what they want* — group, folder, file, or an
individual change inside a file — from one panel that also holds the message editor,
amend toggle, options gear and the shelf; the pre-P11 native surface remains reachable via
`gittree.commit.window: 'native'`.

> **Reverses two master §6 decisions.** §6 rejected a "webview commit dialog" (*"loses
> native SCM input, IME/undo quirks"*) and chose `TreeItemCheckboxState` for changelists.
> Both are now known-insufficient: `TreeItemCheckboxState` has no partial state and the
> SCM sidebar cannot render folder nodes, per-change checkboxes, or a tool-window toolbar.
> The two stated objections are not dismissed — they become acceptance criteria in **T4**
> (IME + undo) and a supported fallback mode in **T2**.

---

## Tasks

### P11-T1 · Webview UI kit + dialog host
**Depends:** P0-T9 · **Complexity:** L
**Output files:** `webview-ui/src/lib/{treeModel.ts,FileTree.tsx,TriCheckbox.tsx,Tabs.tsx,SplitPane.tsx,Menu.tsx,ToolbarStrip.tsx,Dialog.tsx,InlineDiff.tsx}` + unit tests; `src/ui/dialogHost.ts`.
**Steps:**
1. `treeModel.ts` — **pure, vscode-free, unit-tested**: `buildTree(paths: string[])` collapses
   single-child directory chains the way IntelliJ does (`src/main/java` renders as one row),
   `countFiles(node)`, `rollup(node, checked)` → `'checked' | 'unchecked' | 'partial'`,
   `toggle(node, next)` returning the full leaf-set delta. All tree UI in P11–P13 consumes this.
2. `TriCheckbox.tsx` — three visual states, `aria-checked="true|false|mixed"`, 16px hit target,
   HC-theme border fallback (no reliance on background fill alone).
3. `FileTree.tsx` — virtualized (reuse `VirtualList`), folder + file rows, per-node
   `N files` description, status icon + color, **full-width selection bar** (not text-width),
   keyboard model `↑ ↓ ← → Home End Space Enter`, `Shift`/`Ctrl` multi-select, `role="tree"`.
4. `Tabs.tsx` (`role="tablist"`), `SplitPane.tsx` (draggable, min sizes, ratio persisted through
   `setState`), `Menu.tsx` (context menu + `›` submenus, Esc/arrow navigation, focus return),
   `ToolbarStrip.tsx` (icon buttons with `aria-label` + tooltip, overflow `…`).
5. `InlineDiff.tsx` — read-only side-by-side renderer over `LineChange[]` with **one include
   checkbox per change** and an `N differences, M included` header. Scoped to dialogs and the
   commit window; it is **not** a replacement for the general diff viewer (S5 stays deviated —
   see `docs/deviations.md`).
6. `src/ui/dialogHost.ts` — `openDialog<TParams, TResult>(app, params): Promise<TResult | undefined>`:
   creates a `WebviewPanel` (`retainContextWhenHidden`, `viewColumn: Active`), wires
   `WebviewRpcHost`, resolves on `dialog/accept`, resolves `undefined` on `dialog/cancel` or
   dispose. `Dialog.tsx` supplies the frame: title row, scrollable body, footer with `?` on the
   left and right-aligned default/cancel buttons, `Esc` = cancel, `Enter` = default action,
   `aria-modal="true"` + focus trap.
7. New vite entries are added per-phase in `webview-ui/vite.config.ts`; keep `apps` alphabetical.
**Accept:** `test:webview` unit tests cover single-child collapsing, file counts, and
partial→`mixed` rollup on every ancestor; keyboard-only walkthrough of `FileTree` reaches and
toggles every node; `Dialog` traps focus and returns a typed result; HC and
`prefers-reduced-motion` verified against the P10-T2 CSS.

### P11-T2 · Commit tool window shell
**Depends:** T1 · **Complexity:** M
**Output files:** `src/commit/window/commitWindowView.ts`, `webview-ui/src/commit/{main.tsx,App.tsx,commit.css}`, vite entry `commit`.
**Steps:**
1. View `gittree.commit` (`type: webview`, container `scm`, placed **first**) via
   `WebviewViewProvider`. Setting `gittree.commit.window: 'webview' | 'native'` (default
   `webview`) drives context key `gittree.commitWindow`.
2. In `webview` mode: `sourceControl.inputBox.visible = false`, and `gittree.changelists`
   gains `&& gittree.commitWindow == native` on its `when`. In `native` mode everything
   reverts to the P3 surface — this is the documented rollback path for the master §6 objection.
3. Layout per §2A: `Commit | Shelf` tabs → toolbar strip → tree region (flex) → bottom block.
   Toolbar: refresh, rollback, show diff, shelve, preview-diff toggle, group-by ▾,
   expand all, collapse all.
4. Bottom block: `[ ] Amend  last commit ▾  🕘` row with a right-aligned `N modified` counter;
   message editor (T4); `[Commit] [Commit and Push…]` + `⚙` gear (T5).
5. RPC surface on `WebviewRpcHost`: `commit/state` (full snapshot), `commit/setChecked`,
   `commit/setGroupBy`, `commit/move`, `commit/openDiff`, `commit/rollback`, `commit/run`,
   `commit/shelve`; host pushes `commit/changed` on every `ChangelistService.onDidChange` and
   `StatusRefresher` tick. Handlers must be idempotent (rehydrate re-sends).
6. Empty state, error state (reuse `ErrorHandler` + "Show Log"), and a busy overlay bound to
   the `OperationQueue` mutation lane.
**Accept:** integration — the view renders in the SCM container with the native input box
gone; flipping to `native` restores the tree + input box without reload; reload/rehydrate
preserves scroll, expansion, checkbox and message state; a mutation in progress disables
`Commit` rather than queueing a second one.

### P11-T3 · Inclusion model: folders, unversioned files, per-change
**Depends:** T1, T2 · **Complexity:** L
**Output files:** `src/commit/changelists/changelistService.ts` (extended), `src/commit/window/inclusion.ts` + unit tests.
**Steps:**
1. Extend `ChangelistService` with folder-granularity `setChecked(prefix, bool)` and
   `onDidChangeChecked`. Persisted shape stays keyed by relpath; folder state is *derived*
   (`rollup`), never stored — no drift.
2. **Unversioned files become checkable.** `changelistsView.ts:159` currently omits the
   checkbox for `UNVERSIONED_ID`, so an untracked file cannot be included by ticking it —
   fix in the new window and in the legacy tree. Commit path: `git add -N <paths>` →
   `git commit --only -- <paths>` (the P3-T5 executor already does this dance).
3. **Per-change inclusion.** `inclusion.ts` stores `Map<relPath, Set<changeIndex>>` (absent =
   all included). Commit of a partially-included file: `buildPatch({relPath, originalText,
   modifiedText, changes: included})` → `git apply --cached --unidiff-zero -` → the file joins
   the `--only` path list. `complementChanges` yields the residue that must stay in the worktree.
   Both primitives already exist in `src/core/patch/patchBuilder.ts` — this task is the model
   and the wiring, not new diff math.
4. Invalidate per-change selections on `workdirGeneration` change (the file moved under us) and
   fall back to whole-file inclusion rather than applying a stale index set.
5. Counter `N differences, M included` is computed host-side and shipped with `commit/state`.
**Accept:** unit — rollup returns `partial` for a folder with one of three files ticked;
integration — (a) ticking an untracked file commits it and leaves the rest of Unversioned
untouched; (b) a file with 3 changes, only the middle one ticked, commits exactly that change
and leaves the worktree **byte-identical** for the other two (CRLF fixture included);
(c) selections reset to whole-file after an external edit rather than committing stale hunks.

### P11-T4 · Message editor — IME, undo, history, amend dropdown
**Depends:** T2 · **Complexity:** M
**Output files:** `webview-ui/src/commit/MessageEditor.tsx`, `src/commit/messageHistory.ts` (extended).
**Steps:**
1. **Uncontrolled** `<textarea>` (autogrow from 6 rows), debounced 250 ms persist to
   `workspaceState`. The host never writes `value` back while the element has focus — a
   controlled component would destroy the native undo stack, which is master §6's "undo quirks"
   objection. Programmatic sets (history pick, amend load, template prefill) go through
   `setRangeText` + `input` event so they land *on* the undo stack instead of clearing it.
2. **IME:** guard the debounce with `compositionstart`/`compositionend` so no state round-trip
   fires mid-composition; never re-render the textarea subtree while `isComposing`.
3. Message-history clock button → in-webview dropdown over the existing 50-entry ring
   (first line + relative time); pick inserts the full multi-line message.
4. `Amend  last commit ▾` — the `▾` lists recent commits (`hash · subject`) so their message can
   be reused; the checkbox itself keeps the P3-T5 semantics (load `git log -1 --format=%B`,
   pushed-HEAD guard).
5. Soft subject-length hint (>72 chars) as a right-aligned character counter, not a blocker.
   `commit.template` prefill preserved.
**Accept:** integration — `ctrl+z` in the editor restores the pre-history-pick text;
manual-checklist item (recorded in the phase log) for **Japanese and Vietnamese IME**
composition producing correct text with no dropped or duplicated characters;
history pick and amend load both undoable; message survives view reload.

### P11-T5 · Commit options gear popup
**Depends:** T2, P3-T7 · **Complexity:** M
**Output files:** `webview-ui/src/commit/OptionsPopup.tsx`, `src/commit/window/options.ts`.
**Steps:**
1. Sections and rows per the `commit-option-gear-popup.png` layout in §2A:
   **Git** — `Author:` text field, `[ ] Sign-off commit`.
   **Commit Checks** — `Reformat code`, `Rearrange code`*, `Optimize imports`,
   `Cleanup` + `Choose profile`.
   **Advanced Commit Checks** — `Analyze code` + severity picker, `Check TODO` + `Configure`
   (pattern), `[x] Run advanced checks after a commit is done` with the dim caption
   *"Failed checks will not prevent a commit"*.
2. **New git capability — author override:** `Author:` accepts `Name <email>`, completes from
   `git log -200 --format=%an <%ae>` (deduped), validates the `Name <email>` shape, and passes
   `--author=` to `git commit`. Persisted per repo in `workspaceState`, cleared by a `×`.
3. **New git capability — sign-off:** `-s` on commit; setting `gittree.commit.signoff`.
4. Deferred-check mode: when *"Run advanced checks after a commit is done"* is on, Analyze and
   TODO run **after** the commit and report via notification instead of gating the modal —
   this is a real behaviour switch in `CheckPipeline`, not a cosmetic checkbox.
5. Rows deliberately **not** implemented, because they are IntelliJ-platform features with no
   VS Code analogue: `Update copyright`, `Check malicious dependencies`, `Run Configuration`,
   and the whole `After Commit` / `Upload files to` section. `Rearrange code`* ships only if a
   `SourceOrganizeImports`-style code-action kind exists for the language; otherwise it is
   hidden rather than shown-inert. Every omission is registered in `docs/deviations.md`.
**Accept:** unit — argv assembly for `--author=` and `-s` (including a name containing a
comma and a non-ASCII name); integration — gear state round-trips to settings and back;
deferred mode commits first and reports findings after; hidden rows never render as
non-functional controls.

### P11-T6 · Shelf tab
**Depends:** T2, P7-T3 · **Complexity:** M
**Output files:** `webview-ui/src/commit/ShelfTab.tsx`, `src/commit/window/shelfBridge.ts`.
**Steps:**
1. The `Shelf` tab hosts what `gittree.shelf` renders today: entries (name, date, `N files`),
   expandable to a `FileTree` of the patch's files.
2. Per-entry actions (context menu + toolbar): `Unshelve…`, `Unshelve silently`,
   `Compare with Local`, `Rename`, `Delete`, plus the `Show already unshelved` toggle.
   Integrity failures (`patchSha256` mismatch) surface inline on the row, not as a modal.
3. `gittree.shelf` tree view remains, gated `when: gittree.commitWindow == native`.
**Accept:** integration — every action available on the tree view is available in the tab and
produces the same `shelfStore` state; a tampered `changes.patch` shows the row as damaged and
refuses unshelve.

### P11-T7 · Shelve Changes dialog (embedded diff)
**Depends:** T1 (dialog host, `InlineDiff`), T3, T6 · **Complexity:** L
**Output files:** `webview-ui/src/dialogs/ShelveChanges.tsx`, `src/shelf/shelveDialog.ts`, vite entry `dialogs`.
**Steps:**
1. Layout per §2A: toolbar (expand/collapse, refresh, preview) → `Changelist: [ ▾]` selector →
   checkbox `FileTree` → `N modified` → `Commit Message` + history clock → collapsible
   **`∨ Diff`** section (`InlineDiff`, `N differences`) → `[Shelve Changes] [Cancel]`.
2. **Partial shelve** is a new capability: `shelfStore` today writes a whole-file
   `git diff --output` patch. Extend it to accept a caller-supplied patch body built from the
   ticked changes (`buildPatch`), keeping the `patchSha256` verify-then-remove invariant.
3. Shelving removes only the shelved changes from the worktree: apply
   `complementChanges` in reverse (`git apply --reverse`) rather than checking the file out.
4. Selecting a row updates the `Diff` section; the section's collapsed state persists.
**Accept:** integration — with 3 changes in a file and 1 ticked, the stored patch contains
exactly that change, the worktree retains the other two byte-identically, and unshelving
restores the third cleanly; round-trip on a CRLF file leaves no EOL damage; cancel leaves
worktree and shelf untouched.

### P11-T8 · Density: counts, status colors, directory highlighting
**Depends:** T1 · **Complexity:** S
**Output files:** `webview-ui/src/lib/status.ts`, `src/ui/statusColors.ts`, `docs/settings.md` (regenerated).
**Steps:**
1. `N files` badge on **every** group and folder node (S12). GitTree already shows counts on
   changelist nodes (`changelistsView.ts:107`) — the gap is folder nodes, which did not exist.
2. Map IntelliJ's file-status palette onto theme colors with a `gittree.colors.<status>`
   override block; keep the P10-T2 color-blind-safe variant wired.
3. A directory whose descendants are modified takes the modified color (IntelliJ behaviour),
   derived from `rollup`.
**Accept:** counts correct after add/delete/rename; `docs:settings` regenerated; HC theme
legible; color-blind palette honored.

### P11-T9 · Docs, budgets, migration
**Depends:** T2–T8 · **Complexity:** S
**Output files:** `FEATURES.md` §3 (rewritten), `docs/deviations.md`, `docs/keyboard.md`, `docs/plan/PROGRESS.md`, `src/onboarding/*`.
**Steps:**
1. Rewrite `FEATURES.md` §3 from the §2A shapes, each item carrying a **shape** criterion
   (which container, which toolbar, which menu) alongside the behaviour — the missing
   ingredient identified in the gap analysis §1.
2. Register every P11 deviation in `docs/deviations.md`.
3. Walkthrough step + what's-new entry for the new window, including how to get the old one back.
4. Re-check the P10-T5 bundle budget with the `commit` + `dialogs` vite entries and the
   §13 perf budgets for a 5 000-file `git status`.
**Accept:** `npm run check`, `test:integration`, `test:perf` green; bundle budget met;
`docs:settings` diff committed.

---

## Contributions added this phase
View `gittree.commit` (webview, `scm` container). Commands
`gittree.commit.window.toggle`, `gittree.commit.setAuthor`, `gittree.commit.toggleSignoff`,
`gittree.commit.groupBy`, `gittree.commit.includeAll`, `gittree.commit.excludeAll`,
`gittree.shelve.dialog`, `gittree.shelf.showUnshelved`. Settings
`gittree.commit.window`, `gittree.commit.author`, `gittree.commit.signoff`,
`gittree.commit.checks.deferAdvanced`, `gittree.colors.*`. `when` clause
`gittree.commitWindow == native` added to `gittree.changelists` and `gittree.shelf`.

## Parity checklist (gap-analysis S1, S11, S12, S13, S14 · FEATURES.md §3)
- [x] S1 — one panel holding tree + toolbar + message editor + amend + gear + action buttons (P11-T2; the gear still opens the P3 QuickPick until T5)
- [x] S11 — tri-state checkboxes on group, folder **and** file rows; per-change checkboxes with `N differences, M included` (P11-T3)
- [x] S11b — unversioned files are checkable and commit correctly (P11-T3)
- [x] S12 — `N files` badge on every group and folder node (P11-T2)
- [ ] S13 — `Commit | Shelf` tabs in one tool window instead of two stacked sidebar trees
- [ ] S14 — Shelve Changes dialog with an embedded diff and per-change inclusion
- [x] Commit options gear popup with `Author:` and `Sign-off commit` (both new capabilities) (P11-T5)
- [x] Multi-line message editor with working IME, undo, history clock and amend dropdown (P11-T4)

## Deviations (recorded as tasks land)
- **P11-T3 — step 3's commit mechanism does not work as written.** The step says to
  `git apply --cached` the selected changes and let the file "join the `--only` path list".
  It cannot: `git commit --only <paths>` takes the **working tree** contents of those paths and
  disregards the index entirely (verified against real git, not assumed — staging a partial
  patch and committing `--only` produced the whole file). Partial commits instead build the
  target tree in a scratch index (`GIT_INDEX_FILE` in the git dir): `read-tree HEAD` → `git add`
  the whole files → `git apply --cached` each partial patch → `git commit`, then
  `git reset -- <committed paths>` to put the real index back on the new HEAD, which is the
  state `--only` would have left. The working tree is never written, so an interrupted commit
  cannot truncate a file to its ticked hunks. `commitChangelist` is untouched and still runs
  whenever no file is partially included.
- **P11-T3 — staleness is keyed on a per-file change signature, not `workdirGeneration`.**
  Step 4 names `workdirGeneration`, which bumps on *any* workspace file change; editing an
  unrelated file would discard every selection. Each selection instead stores a signature of the
  change list it was made against (every change's four coordinates), and `resolve` answers
  "whole file" the moment it stops matching. Same guarantee, and it only fires for the file that
  actually moved.
- **P11-T3 — `setChecked(prefix, bool)` and `onDidChangeChecked` were not added.** Step 1 wanted
  folder-granularity ticking with derived, never-stored folder state. P11-T2 already delivers
  exactly that: `treeModel.toggle` resolves a folder click to its leaf set and `splitDelta` maps
  it to repo-relative paths. A second, parallel prefix path would be a way for the two to
  disagree, and `onDidChangeChecked` would have no consumer — `onDidChange` already fires on
  every check change and both surfaces rebuild a full snapshot.
- **P11-T3 — per-change selections are session-scoped and in-memory.** Persisting them across an
  extension-host restart would mostly persist selections the signature check then discards.
- **P11-T3 — per-change inclusion is offered only where it has meaning:** a text file with both
  a HEAD side and a worktree side. Untracked, deleted and binary files commit whole and the
  preview says so, rather than rendering checkboxes the commit cannot honour.
- **P11-T3 — `N differences, M included` ships per file only where a selection exists.** The
  counter needs a diff, and diffing every row on every status push would cost a `git show` per
  file; rows with no selection are whole-file by definition and need no badge.
- **P11-T4 — `setRangeText` does not land on Chromium's undo stack.** Step 1 prescribes
  `setRangeText` + `input` event "so they land on the undo stack"; Chromium records no undo
  entry for it (verified: Ctrl+Z after such an insert restored nothing). Programmatic writes
  use `document.execCommand('insertText')` — deprecated, but load-bearing in Chromium/Electron,
  which is the only runtime webviews have — with `setRangeText` retained as the functional
  fallback if `execCommand` ever reports failure.
- **P11-T4 — programmatic message writes travel on a dedicated `commit/message` event, and the
  editor ignores `CommitStateDto.message` after init.** A generic state push can be built from
  a snapshot older than the 250 ms-debounced persist; adopting it would eat the user's newest
  keystrokes. Splitting the channel is what makes "the host never writes `value` back while the
  element has focus" actually true rather than merely intended.
- **P11-T4 — `commit/showHistory` removed** in favour of `commit/messageHistory` +
  `commit/recentCommits` data requests rendered as in-webview kit `Menu` dropdowns (the P11-T1
  menu deviation applies). The native `gittree.commit.showMessageHistory` QuickPick command
  keeps working in both surface modes.
- **P11-T4 — the editor autogrows (6 rows → 320px) and the manual resize handle is removed.**
  Autogrow and a drag handle fight each other; IntelliJ's editor has no handle either.
- **P11-T4 — real-IME verification is a recorded manual checklist item** (Japanese and
  Vietnamese, in `PROGRESS.md`). Playwright drives `CompositionEvent`s and proves the
  event-order contract — including Chromium's final-`input`-before-`compositionend` order —
  but cannot exercise the OS IME itself.
- **P11-T5 — `Rearrange code` is omitted entirely, not language-conditional.** The step allows
  hiding it where no suitable code-action kind exists; no *cross-language* rearrange kind
  exists at all, and probing `source.sortMembers` per language means executing every provider.
  Hidden everywhere, per the hidden-not-inert rule. `Choose profile` maps to the code-action
  kind Cleanup applies (`gittree.commit.checks.cleanupKind`) — see docs/deviations.md D7.
- **P11-T5 — the author override is per-repo `workspaceState`, not a `gittree.commit.author`
  setting.** The contributions list names a setting; step 2 says workspaceState. The step wins:
  a workspace-level setting cannot be per-repository in a multi-root workspace.
- **P11-T5 — deferred advanced checks default ON (`gittree.commit.checks.deferAdvanced: true`).**
  The §2A reference shows the box checked and the caption "Failed checks will not prevent a
  commit" — that is IntelliJ's shipped default, and shipping the popup with the old gating
  default would render a checked box that lies. **This changes existing behaviour:** Analyze
  and TODO now run after the commit and report via notification unless the user unticks it.
  The P3-T7 gating path remains fully supported behind the toggle (phase03's gate test pins it
  off). The deferred pass re-baselines range-scoped checks on the new commit's parent —
  post-commit, worktree↔HEAD is empty and would have made the TODO check silently blind.
- **P11-T2:** the tab strip ships with `Commit` only. The `Shelf` tab arrives with T6 —
  rendering a dead tab that says "coming later" would be a worse affordance than none.
- **P11-T2:** `CommitStateDto.signing` is always `false` for now. `CommitService.isSignEnabled`
  is async and the gear popup that surfaces it is T5, so reporting a guessed value would be
  worse than reporting none.
- **P11-T2:** integration suites phase01/03/05 now call `useCommitWindow('native')` in their
  setup. They assert against the SCM input box, which is the fallback surface; phase11 pins
  `webview`. Both product modes stay covered rather than one silently losing its tests.
- **P11-T1:** menus inside webviews are rendered by the kit's own `Menu`, not by VS Code's
  native context menu. `data-vscode-context` can only raise statically-contributed
  `webview/context` items, which cannot carry per-row interpolated labels such as
  `Merge 'feature/f1-1' into 'master'` — the exact thing gap analysis S3 is about. Native
  menus stay in use for the tree views, which are not webviews.
- **P11-T1:** the kit harness page (`webview-ui/kit.html` + `src/kit/`) is deliberately **not**
  a vite `apps` entry, so it is served in dev and by Playwright but never enters
  `dist/webviews` or the P10-T5 bundle budget.
- **P11-T1:** `VirtualList` gained four optional props (`role`, `rowRole`, `rowAria`,
  `onRowKeyDown`) rather than growing a second windowing implementation for trees. Defaults
  preserve the listbox behaviour the log and demo rely on.

## Planned deviations
- **No OS-modal dialogs.** VS Code cannot host a modal webview; `dialogHost` opens an editor-area
  panel styled and focus-trapped as a dialog. Nothing else is available in the API.
- **No anchored popups.** The gear popup renders inside the commit webview, not as a floating
  window anchored to the gear icon.
- **General diff viewer unchanged (S5).** `InlineDiff` is scoped to the commit window and
  dialogs; every other diff still opens VS Code's diff editor. See `docs/deviations.md`.
- **IntelliJ-platform gear rows omitted:** `Update copyright`, `Check malicious dependencies`,
  `Run Configuration`, `After Commit`/`Upload files to`. `Rearrange code` is language-conditional.
- **Per-change inclusion is line-range granular**, matching `LineChange[]`; IntelliJ's
  word-level inclusion inside a line is out of scope.
- **`native` mode is retained, not deleted** — the P3 surface stays supported for one release
  cycle so the master §6 objection has a real escape hatch.
