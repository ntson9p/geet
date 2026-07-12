# Phase 5 — History Rewriting (Interactive Rebase & Commit Surgery)

**Goal:** FEATURES.md §4 "Advanced Context Menu Actions": drag-and-drop interactive rebase, Undo Commit, Revert, Cherry-Pick, Drop Commit — all CLI-free, all conflict-aware, all guarded against rewriting published history.

**Depends on:** P4 (log entry points), P2 (branch ops), **P9-T1/T2 merged** (snapshots before every rewrite — hard gate for this phase), P6 helpful but not required (conflict handoff degrades to guidance toast + conflicts group until P6 ships).
**Exit criteria:** reorder+squash+reword+drop in one rebase session executes correctly; each surgery action is one context-menu click from the log with progress, conflict handling, and undo guidance.

---

## Tasks

### P5-T1 · Rebase engine (sequence-editor shim + state machine)
**Depends:** P0-T2, P9-T2 · **Complexity:** L
**Output files:** `src/rewrite/rebase/{rebaseEngine.ts,planSerializer.ts,stateMonitor.ts}`, `shims/seq-editor.cjs` + integration tests.
**Steps:**
1. **Plan model:** `RebasePlanEntry = {sha, action: 'pick'|'reword'|'squash'|'fixup'|'drop', message?: string}` ordered list + `baseSha`.
2. **Serialization:** entries → todo lines. Rewords/squash-with-custom-message avoid GIT_EDITOR entirely: write each new message to `<tmp>/msg-<n>.txt`; after the affected `pick`/`squash` group emit `exec git commit --amend --no-verify -F "<file>"`. Squash groups: first = `pick`, rest = `fixup` when message discarded, `squash`→converted to `fixup` + trailing exec-amend with the combined message file (deterministic, prompt-free).
3. **Shim:** `GIT_SEQUENCE_EDITOR` is a shell string (git runs it via its bundled sh, Windows included): `"<node>" "<shims/seq-editor.cjs>" "<planfile>"` where `<node>` = `process.execPath`; spawn env carries `ELECTRON_RUN_AS_NODE=1`. Shim copies planfile over the todo file argument git passes. Validate shim errors surface (non-zero → rebase aborts cleanly).
4. Run `git rebase -i --autostash <base>` through the mutation lane with `isDestructive: true, snapshotLabel: 'Before rebase'`; `--rebase-merges` refused in v1 (pre-flight scan for merges in range → explain modal).
5. **StateMonitor:** watch `.git/rebase-merge/{msgnum,end,done,stopped-sha}` → progress (`REBASING k/n` on the status widget via P1-T5 hook) and conflict detection → pause queue, raise `RebasePausedEvent` (P6 consumes; interim toast with "Continue/Skip/Abort" guidance).
6. Commands: `gittree.rebase.{continue,skip,abort}` (continue pre-checks unresolved paths; all three always visible in status segment + conflicts view title while rebasing).
**Accept:** integration matrix on fixture histories: reorder(3), reword(head & mid), squash(2+custom msg), fixup, drop(mid), conflict→abort restores pre-state byte-identical (snapshot + `ORIG_HEAD` assert), conflict→resolve→continue completes; Windows CI proves the shim path quoting.

### P5-T2 · Interactive Rebase webview (drag-and-drop UI)
**Depends:** T1, P0-T9, P4-T3 (multi-select entry) · **Complexity:** L
**Output files:** `src/rewrite/rebase/rebaseView.ts`, `webview-ui/src/rebase/**`.
**Steps:**
1. Entry: log multi-select → "Interactively Rebase from Here…" (anchored at oldest selected parent) or single commit → same action (range = commit..HEAD). Guard: range must be linear, unpushed (T3 helper) or explicit force-acknowledge checkbox.
2. UI (IntelliJ dialog parity): ordered rows `[⋮⋮ drag] [action ▾] [shortsha] [subject] [author, date]`; pointer-event DnD with drop indicator + auto-scroll; action dropdown per row (pick/reword/squash/fixup/drop); reword/squash open an inline multiline message editor (squash pre-fills concatenated messages); squash/fixup rows visually indent under their target; drop rows strike-through.
3. Validation live in-view: first row can't be squash/fixup; dropped-all warning; count summary footer ("3 picks · 1 squash · 1 drop").
4. Buttons: **Start Rebasing** (→ T1 engine with serialized plan, panel switches to progress mode with per-step log + Continue/Skip/Abort when paused), Cancel. Keyboard: alt+↑/↓ reorder, `r/s/f/d/p` action hotkeys (IntelliJ muscle memory).
5. Native context menu on rows via `data-vscode-context` (Reset action, Show commit in Log).
**Accept:** Playwright: DnD reorder emits correct plan order; hotkeys + a11y (rows focusable, aria-grabbed states); e2e: UI-built plan of reorder+squash+reword produces expected `git log` (assert messages & tree ids).

### P5-T3 · Undo Commit & Drop Commit
**Depends:** T1, P9-T2 · **Complexity:** M
**Output files:** `src/rewrite/undoDrop.ts` (+ shared `publishedGuard.ts` helper: `git merge-base --is-ancestor <sha> @{u}` — also used by P3-T5 amend and T2).
**Steps:**
1. **Undo Commit** (HEAD only; menu hidden otherwise): published guard → warn modal. `git reset --soft HEAD^`; changelists paradigm additionally runs `git reset` (unstage) and files the paths into a **new changelist named after the commit subject** (IntelliJ parity); staging paradigm leaves them staged. Message restored into commit input.
2. **Drop Commit** (any linear unpushed commit): pre-flight (merge-in-range / published) → `git rebase --autostash --onto <sha>^ <sha>` via T1 engine (no todo UI); conflicts → standard paused flow; success toast with "Undo" (reset to snapshot/ORIG_HEAD within session).
**Accept:** integration: undo returns files to a fresh changelist with correct name + input prefilled; drop of mid-commit preserves descendants' content (tree-id asserts); both refuse on published commits unless forced.

### P5-T4 · Revert & Cherry-Pick flows
**Depends:** P4-T5 menus · **Complexity:** M
**Output files:** `src/rewrite/revertCherryPick.ts`.
**Steps:**
1. **Revert:** multi-select aware (`git revert <shas…>` oldest-first); merge commits → `-m 1` with explainer modal; conflicts → `REVERT_HEAD` state flow (continue/abort commands, P6 handoff); resulting message template preserved.
2. **Cherry-Pick:** from any log view incl. filtered branches (`git cherry-pick <shas…>`), setting `gittree.cherryPick.recordOrigin` → `-x`; clean picks auto-commit (IntelliJ behavior); conflicts → `CHERRY_PICK_HEAD`/sequencer flow with per-commit progress (`2/5`), continue/skip/abort; done toast lists new shas.
3. Both register in `webview/context` commit menu + Compare view rows (pick from other branch = spec's cross-branch copy).
**Accept:** integration: multi-pick with mid-sequence conflict → skip → completes remaining; revert of merge with `-m 1`; `-x` trailer present when enabled.

### P5-T5 · Reword from log
**Depends:** T1 · **Complexity:** S
**Output files:** `src/rewrite/reword.ts`.
**Steps:** context action "Edit Commit Message…": HEAD → `commit --amend -F` (input via multiline InputBox-in-webview? no — use a temp untitled editor with Accept CodeLens, IntelliJ-style dialog parity); non-HEAD → single-entry T1 plan (`reword` via exec-amend). Published guard applies.
**Accept:** reword mid-history rewrites only messages (tree ids unchanged for all commits in range).

### P5-T6 · Post-rewrite push safety
**Depends:** T1..T5 · **Complexity:** S
**Output files:** `src/rewrite/pushSafety.ts`.
**Steps:** after any successful rewrite on a branch with upstream, status widget shows diverged state; one-time toast explains and offers **Push --force-with-lease** (`gittree.pushForceWithLease` from P1-T5) with an "always after rewrite: ask/never" setting; never plain `--force`.
**Accept:** rewrite → toast → force-with-lease updates fixture bare remote; stale-lease failure surfaces classified error with fetch suggestion.

---

## Contributions added this phase
Webview panel `gittree.rebaseEditor`; commands `gittree.rebase.{interactive,continue,skip,abort}`, `gittree.commit.{undo,drop,revert,cherryPick,reword}`; `webview/context` multi-select menu entries (`gittree:rewriteReady` group from P4-T5); keybindings inside rebase view.

## Deviations

- **T1 (ORIG_HEAD assert):** git's merge backend only writes `ORIG_HEAD` when a rebase *finishes* — while paused it still holds a previous operation's value. The paused-state pre-rebase anchor (and what `--abort` restores from) is `.git/rebase-merge/orig-head`; the abort test asserts that file plus the post-abort `HEAD`, worktree bytes, and autostash round-trip.
- **T1 (stopped-sha):** `.git/rebase-merge/stopped-sha` contains a unique *abbreviation*, not the full oid; `RebasePausedEvent.stoppedSha` documents this and the test prefix-matches.
- **T1 (status segment):** while a rebase is in progress the status widget gains one `$(list-selection) Rebase…` command opening a Continue/Skip/Abort QuickPick (IntelliJ-style chip) instead of three separate status-bar buttons; all three commands stay individually palette-visible via the `gittree.rebase.active` context key.
- **T1 (continue pre-check):** unresolved paths are read straight from `git diff --name-only --diff-filter=U` rather than the model — a just-staged resolution can be a few hundred ms ahead of the debounced refresh pipeline.

## Parity checklist (FEATURES.md §4 context-menu actions)
- [ ] Interactive rebase: drag-and-drop reorder + Pick/Squash/Reword/Fixup/Drop dropdowns
- [ ] Undo Commit → changes back into a (new) changelist, message restored
- [ ] Revert Commit (`git revert`, merge-aware)
- [ ] Cherry-Pick with clean auto-commit and conflict sequencing
- [ ] Drop Commit via background rebase
- [ ] Guard rails: published-history warnings, snapshots before every rewrite, force-with-lease flow
