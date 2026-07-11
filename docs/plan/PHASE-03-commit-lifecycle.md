# Phase 3 — Commit Lifecycle (Changelists, Staging, Pre-Commit Checks)

**Goal:** FEATURES.md §3 — both commit paradigms (Changelists default, Git Staging), hunk/line staging, the five pre-commit checks, message history, amend, and GPG signing.

**Depends on:** P1. P9-T1/T2 recommended merged (rollback/partial-commit safety snapshots).
**Exit criteria:** a user can switch paradigms, group work into changelists, commit checked files bypassing the index, or stage hunks natively; commits run the configured check pipeline with Review/Commit-Anyway gating.

---

## Tasks

### P3-T1 · ParadigmManager
**Depends:** P1-T1 · **Complexity:** S
**Output files:** `src/commit/paradigmManager.ts`.
**Steps:**
1. Setting `gittree.commit.paradigm: 'changelists' | 'staging'` (default `changelists`); `setContext('gittree.paradigm', …)` drives all `when` clauses.
2. Switch behavior: changelists→staging keeps index as-is; staging→changelists runs `git reset` (unstage all, confirm modal) since changelists ignore the index. Command `gittree.commit.switchParadigm` + gear entry in the SCM title menu.
3. In changelists mode the SCM view shows **only** input box + action button (groups hidden except `merge` conflicts); staging mode shows native groups (T4).
**Accept:** toggling flips UI without reload; unstage-on-switch confirmed by integration test.

### P3-T2 · ChangelistService (model & persistence)
**Depends:** T1 · **Complexity:** M
**Output files:** `src/commit/changelists/changelistService.ts` + unit tests.
**Steps:**
1. Model per master §8 `Changelist`; invariants: exactly one default, exactly one active, file belongs to exactly one list; unknown new files land in the **active** list (IntelliJ behavior); "Unversioned Files" is a virtual list fed by untracked status entries.
2. Persist name/comment/membership + checkbox state in `workspaceState` (key by relpath); reconcile on every status refresh (drop vanished files, adopt new ones).
3. API: `create(name, comment?)`, `rename`, `remove(moveFilesTo)`, `setActive`, `moveFiles(uris, listId)`, `setChecked(uris, bool)`, `onDidChange`.
4. Move-hunks-between-lists is **out of scope v1** (file granularity only) — documented deviation.
**Accept:** unit tests for invariants + reconciliation (file modified→reverted disappears from list; untracked→added migrates out of Unversioned).

### P3-T3 · Changelists TreeView (checkboxes + DnD)
**Depends:** T2 · **Complexity:** M
**Output files:** `src/commit/changelists/changelistsView.ts`, view `gittree.changelists` (SCM container, `when: gittree.paradigm == changelists`).
**Steps:**
1. Nodes: changelist (label + dim comment + `N files`; active list bolded via `TreeItemLabel.highlights`) → file rows (status icon/color, path description, click = open diff). Checkboxes on both levels (`TreeItemCheckboxState`), tri-state rollup on the list node; `onDidChangeCheckboxState` → service.
2. `TreeDragAndDropController`: drag files between lists (multi-select) → `moveFiles`; drop onto view background offers "New Changelist…".
3. Context menus: list nodes (set active, rename incl. comment [two-step InputBox], delete → move-files picker, commit this list); file nodes (move to list ▸ submenu via dynamic QuickPick, rollback, open diff, shelve [P7 hook]).
4. View title: `+` new list, commit-checked `$(check)`, refresh, gear (checks config, paradigm switch).
**Accept:** Playwright-free (native view) integration: checkbox state survives reload; DnD moves membership; active-list new-file adoption visible.

### P3-T4 · Staging mode UI & hunk/line staging
**Depends:** T1, P1-T3 (PatchBuilder) · **Complexity:** M
**Output files:** `src/commit/staging/stagingOps.ts`.
**Steps:**
1. Staging mode groups: **Staged** / **Changes** / **Untracked** (+ conflicts). Group/resource commands already exist from P1-T4 (`add`/`unstage`); add group-level "Stage All"/"Unstage All".
2. Clicking an unstaged file opens `gittree-rev:(:0)` ↔ worktree diff — the spec's "diff viewer directly below" maps to VS Code's diff-editor-on-click idiom.
3. Editor commands (context menu + keybindings, enabled in our diff editors via `resource`+`when`): `gittree.stage.selectedRanges`, `gittree.unstage.selectedRanges`, `gittree.revert.selectedRanges` — selection→`PatchBuilder`→`git apply --cached [--reverse] --unidiff-zero -`. The `>>` affordance: glyph-margin decoration on changed hunks in the diff editor; clicking is approximated by CodeLens "Stage hunk ≫ / Unstage / Revert" above each hunk (decorations aren't clickable).
4. Interop guard: staging ops refresh index state first (external `git add` tolerated).
**Accept:** integration: stage exactly 2 of 3 hunks → `git diff --cached` contains exactly those; unstage round-trip; CRLF file hunk staging (no EOL corruption — assert byte-identical worktree).

### P3-T5 · Commit executors (changelist `--only`, staged, amend, sign)
**Depends:** T2 · **Complexity:** M
**Output files:** `src/commit/commitService.ts` (replaces P1-T7 internals; command id `gittree.commit` unchanged).
**Steps:**
1. **Changelist commit:** collect checked files of target list(s); untracked among them → `git add -N` first; run `git commit --only -- <paths>` with message; verify intent-to-add files commit correctly (integration test — if a git version refuses, fall back to temporary `git add` + `--only`).
2. **Staged commit:** plain `git commit` (staging paradigm).
3. **Amend:** toggle (SCM title + view title, `$(edit)`): on enable, stash current input, load `git log -1 --format=%B`; commit runs `--amend`; guard when HEAD is pushed (warn modal, reuse P5-T3 ancestor check helper).
4. **Sign:** toggle icon (`$(verified)`), tristate default from `commit.gpgsign` config; commit adds `-S`; classify gpg failures (no key, pinentry timeout) with help link; Windows pinentry note in docs.
5. Emit `onDidCommit` (message history T6, post-commit push offer per setting).
**Accept:** integration matrix: changelist commit leaves other lists' work untouched (index and worktree), amend rewrites message+content, `-S` path exercised with a throwaway GPG key on CI linux.

### P3-T6 · Commit message history & input UX
**Depends:** T5 · **Complexity:** S
**Output files:** `src/commit/messageHistory.ts`.
**Steps:**
1. Ring buffer (50) in `globalState` keyed by repo remote hash; dedupe consecutive; store on successful commit.
2. `gittree.commit.showMessageHistory` (SCM input title button `$(history)` + `ctrl+up` keybinding when input focused): QuickPick with first-line label + relative time detail; pick fills `inputBox.value`.
3. `commit.template` file support: prefill when input empty; subject-length soft hint (>72 chars) appended to placeholder (input validation API is proposed — do not use).
**Accept:** history persists across reloads; template prefills; picker inserts full multi-line message.

### P3-T7 · Pre-commit CheckPipeline + the five checks
**Depends:** T5 · **Complexity:** L
**Output files:** `src/commit/checks/{pipeline.ts,reformat.ts,optimizeImports.ts,analyze.ts,todo.ts,cleanup.ts}` + unit tests for diff-range math and TODO scanner.
**Steps:**
1. `CheckPipeline.run(files, token)`: sequential, each check behind its `gittree.commit.checks.*` setting, progress line per check, cancellable; results aggregated → single modal when any `ok:false`: blocking → "Review… / Cancel"; non-blocking → "Review… / Commit Anyway / Cancel".
2. **Reformat (modified ranges only):** compute changed ranges per file (diff worktree vs quick-diff base via PatchBuilder's differ), `executeFormatRangeProvider` per range (merge adjacent), apply `WorkspaceEdit`, save. Skip files with no formatter silently.
3. **Optimize imports:** `executeCodeActionProvider` with `CodeActionKind.SourceOrganizeImports`, apply per file, save.
4. **Analyze:** save all target docs; await diagnostics quiesce (no `onDidChangeDiagnostics` for target uris for 1 200 ms, timeout 10 s); collect `getDiagnostics` filtered to target files ≥ `analyzeSeverity` (default `error`; `warning` opt-in). `reveal()` opens Problems view + first offending file. Blocking=false (IntelliJ lets you commit anyway).
5. **TODO check:** scan **added** lines only (from computed diff) with `gittree.commit.checks.todoPattern` (default `\b(TODO|FIXME)\b`); result lists file:line hits; non-blocking.
6. **Cleanup:** `CodeActionKind.SourceFixAll` per file, save. Runs before Analyze in pipeline order: reformat → imports → cleanup → analyze → todo.
7. Gear UI: multi-select QuickPick mirroring IntelliJ's checkbox column, persisted to settings.
**Accept:** integration on a TS fixture workspace: seeded lint error blocks with modal; "Commit Anyway" proceeds; reformat touches only modified ranges (assert untouched lines byte-identical); TODO added-line detection ignores pre-existing TODOs.

### P3-T8 · Commit flow orchestration
**Depends:** T5, T6, T7 · **Complexity:** S
**Output files:** `src/commit/commitFlow.ts`.
**Steps:** `gittree.commit` = resolve target files (paradigm-aware) → empty-selection/message guards → CheckPipeline → executor → post-actions (clear input, history store, optional push offer, refresh). "Commit and Push…" variant command. All under one progress notification with step names; failure surfaces via ErrorHandler with "Show Log".
**Accept:** e2e: changelists mode commit of checked subset with all checks on completes; cancel mid-pipeline leaves worktree/index untouched.

---

## Contributions added this phase
View `gittree.changelists`; commands `gittree.commit`, `gittree.commitAndPush`, `gittree.commit.{switchParadigm,toggleAmend,toggleSign,showMessageHistory,configureChecks}`, `gittree.changelist.{new,rename,delete,setActive,moveTo,commitList}`, `gittree.stage/unstage/revert.selectedRanges`; SCM title/gear menu entries; keybindings (`ctrl+up` history, `ctrl+alt+enter` stage-selected in diff).

## Parity checklist (FEATURES.md §3)
- [ ] Changelists: multiple lists, default list, check/uncheck files, commit bypasses index
- [ ] Staging: Staged/Unstaged split with stage-all/unstage-all
- [ ] Hunk & line staging from the diff view (`>>` equivalents)
- [ ] Pre-commit: Reformat (modified lines only) · Optimize Imports · Analyze with halt-and-review · TODO/FIXME warning on new comments · Cleanup
- [ ] Commit message history dropdown
- [ ] Amend checkbox loads previous message and folds changes in
- [ ] GPG sign toggle
