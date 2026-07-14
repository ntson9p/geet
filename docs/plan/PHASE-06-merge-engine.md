# Phase 6 — 3-Way Merge Conflict Resolution Engine

**Goal:** FEATURES.md §5 — the Conflicts dialog, a Left(Yours)/Center(Result)/Right(Theirs) 3-pane merge experience with chevrons, Accept Left/Right, manual editing **with full IDE autocompletion in the center pane**, and the Magic Wand auto-resolver.

**Architecture decision (binding):** the 3-pane UI is a **Tri-Editor composition of three real VS Code editors** — left/right are read-only virtual stage documents, center is a writable virtual result document — because only real editors give the center pane genuine LSP autocomplete/syntax features (spec hard requirement). Monaco-in-webview is rejected. The native merge editor remains an optional bridge.

**Depends on:** P1 (SCM conflicts group, `gittree-rev:`). Consumed by: P2-T4 (smart checkout), P5 (rebase/cherry-pick/revert pauses), P7-T5 (unshelve), P1-T5 (pull).
**Exit criteria:** any operation that produces conflicts leads the user through list → tri-editor → resolve (wand/chevrons/manual) → Apply → operation continues; abort available at every step.

---

## Tasks

### P6-T1 · Conflict session model & Conflicts view
**Depends:** P0-T4 (op detection), P1-T1 · **Complexity:** M
**Output files:** `src/merge/{conflictSession.ts,conflictsView.ts}`, view `gittree.conflicts` (SCM container, `when: gittree.hasConflicts`).
**Steps:**
1. `ConflictSession` per repo: source op (`merge|rebase|cherry-pick|revert|stash-pop|unshelve|checkout-merge`), unmerged paths from porcelain-v2 stage masks (classify: both-modified, added-by-both, deleted-by-us/them, mode conflicts), resolved-set tracking (path leaves unmerged state), completion hook = offer `git <op> --continue` (or plain "done" for stash/unshelve).
2. Conflicts TreeView (auto-revealed + toast when a session starts — IntelliJ "Conflicts" dialog parity): file rows with classification badge; **inline actions per row:** `Accept Yours` (`git checkout --ours -- <p> && git add`), `Accept Theirs` (`--theirs`), `Merge…` (→ T3); title actions: Accept All Yours / All Theirs (confirm modal), Abort <op>, Continue <op> (enabled when zero unmerged).
3. Delete/mode conflicts get tailored QuickPick resolutions (keep deleted / keep modified) instead of the tri-editor.
**Accept:** integration: merge-conflict fixture populates view with correct classifications; accept-side rows resolve and disappear; continue enabled only at zero remaining; abort restores pre-merge state.

### P6-T2 · Merge computation layer (stages → ConflictBlocks)
**Depends:** P0-T2 · **Complexity:** M
**Output files:** `src/merge/mergeCompute.ts` + heavy unit tests.
**Steps:**
1. Read stages `git show :1:<p> :2:<p> :3:<p>` (size cap 10 MB, binary detection → binary resolution QuickPick instead of editor).
2. Canonical re-merge independent of user's `merge.conflictStyle`: `git merge-file -p --diff3 <ours> <base> <theirs>` on temp files → parse `<<<<<<<`/`|||||||`/`=======`/`>>>>>>>` into the master-§8 segment model: ordered `Segment[] = Common(text) | Conflict{base, ours, theirs}`.
3. Initial result assembly: common segments verbatim; conflict segments initially rendered as **base text** with a red "unresolved" decoration (documented deviation: IntelliJ shows base in unresolved regions too — matches).
4. Serializer: segments+resolutions → final text; invariant tests: resolve-all-ours == `git checkout --ours` content modulo EOL (property-based on fixture triples).
**Accept:** unit: marker parser vs `merge.conflictStyle` variants, CRLF triples, conflict at BOF/EOF, adjacent conflicts, empty-side conflicts; binary path routes to QuickPick.

### P6-T3 · Tri-Editor composition
**Depends:** T2, P0-T9 (not webview — but vdocs) · **Complexity:** L
**Output files:** `src/merge/triEditor.ts`, `src/core/vdocs/mergeFs.ts` (`gittree-merge:` writable FileSystemProvider).
**Steps:**
1. Open sequence: save layout → `vscode.setEditorLayout({orientation: 0, groups: [{size:.29},{size:.42},{size:.29}]})` → open `gittree-rev:…:2` ("Yours — <branch>", ViewColumn.One, readonly), `gittree-merge:/<repo>/<path>` (result, Two), `gittree-rev:…:3` ("Theirs — <ref>", Three). Result doc's language mode = from filename → **full IntelliSense**. Setting `gittree.merge.resultMode`: `virtual` (default) | `markers` (edit the real conflicted file in place — fallback for language servers requiring on-disk files).
2. Decorations: conflict blocks tinted per state (unresolved red / resolved-ours blue / theirs green / both purple / manual grey outline) in all three panes; side panes highlight their contribution ranges. Block result-ranges tracked as decoration ranges (VS Code shifts them on manual edits — they are the anchor source of truth).
3. Synchronized scrolling: leader = focused editor; `onDidChangeTextEditorVisibleRanges` → map via block anchor table → `revealRange(AtTop)` in followers; feedback-loop guard (leader token + 50 ms suppression). Toggle command.
4. Session UX: closing any pane prompts Resolve-later/Abort; "Resolve later" restores layout and keeps the file unmerged; center pane dirty-state guards; status-bar segment `Conflicts: 2/5 resolved · file 1/3` with next/prev-conflict commands (`F7`/`shift+F7` keybindings, IntelliJ muscle memory).
**Accept:** integration: open→resolve→Apply writes exact serialized content to worktree + `git add`s it; layout restored after close; manual center edits inside a common segment survive a subsequent chevron apply on a neighboring block (anchor test); completions provider fires in center pane (TS fixture: `vscode.executeCompletionItemProvider` returns items).

### P6-T4 · Chevrons, Accept-side, Apply lifecycle
**Depends:** T3 · **Complexity:** M
**Output files:** `src/merge/resolutionActions.ts` (CodeLens providers + commands).
**Steps:**
1. CodeLens per block: left pane `Accept Yours ≫` · right pane `≪ Accept Theirs` · center `Accept Both (Yours first) | Ignore (keep base) | Revert Block`. Apply = replace block's tracked range in result doc via `WorkspaceEdit` (undoable; undo restores prior resolution state via onDidChange reconciliation).
2. Global: editor-title commands on result doc — `Accept All Yours`, `Accept All Theirs` (confirm), `Magic Wand` (T5), `Apply` (`$(check)`: serialize → write worktree → `git add` → close tri-editor → session completion hook), `Abort file` (revert to unmerged).
3. Keybindings: `alt+enter` accept-focused-side, `ctrl+alt+enter` apply-file.
**Accept:** e2e per action; undo after chevron restores base+unresolved; Apply on partially-unresolved file blocked with jump-to-first-conflict.

### P6-T5 · Magic Wand auto-resolver
**Depends:** T2 · **Complexity:** L
**Output files:** `src/merge/resolver/{autoResolver.ts,lineDiff3.ts}` + fixture suite `test/fixtures/merge/*/{base,ours,theirs,expected,meta.json}`.
**Steps (rule cascade per unresolved block — pure, deterministic, order-fixed):**
1. `ours == theirs` → take ours (`auto`).
2. `ours == base` → take theirs; `theirs == base` → take ours (arises from git's conservative adjacency grouping).
3. **Disjoint interleave:** base-anchored line diff (LCS) of ours-vs-base and theirs-vs-base inside the block; if changed base-line sets are disjoint → weave both edit sets onto base in base order (`auto`).
4. Whitespace-only divergence on one side (`gittree.merge.autoResolveWhitespace`, default on) → take the substantive side.
5. Else leave `manual`.
Command applies cascade to all unresolved blocks in current file (toolbar `$(wand)`) or across session (Conflicts-view title); toast `Resolved 6 of 8 conflicts automatically`; every auto-resolution individually undoable and visually tagged `auto` until Apply.
**Accept:** golden fixture suite ≥ 25 triples incl. adversarial near-misses that must stay `manual` (overlapping edits, same-line different content, reorder-vs-edit); idempotence (2nd run resolves 0); CRLF preserved byte-exact.

### P6-T6 · Native merge editor bridge (optional path)
**Depends:** T1 · **Complexity:** S
**Output files:** `src/merge/nativeBridge.ts`.
**Steps:** setting `gittree.merge.ui: 'triEditor' (default) | 'native'`; native path probes internal `_open.mergeEditor` (`try/catch` + command-existence check via `vscode.commands.getCommands`) with `{base, input1: ours, input2: theirs, output}` payload shape; on any failure silently falls back to tri-editor and flips a session flag (surfaced in trace log only). Document in code why: internal command, may vanish (master risk register).
**Accept:** with setting=native on current VS Code the native editor opens and its save marks the file resolved (session watcher observes `git add`-ability); simulated command-removal falls back cleanly.

### P6-T7 · Operation lifecycle integration
**Depends:** T1..T4; coordinates with P2-T4, P5-T1, P7-T5 · **Complexity:** M
**Output files:** `src/merge/lifecycle.ts`.
**Steps:**
1. Subscribe to queue GitError `merge-conflict` + model `inProgressOp` transitions → create/refresh sessions automatically for: pull/merge, rebase pause (P5 `RebasePausedEvent`), cherry-pick/revert sequencer stops, stash-pop, unshelve, checkout-merge.
2. Completion routing: all-resolved → contextual CTA ("Continue Rebase (3/7)…", "Commit Merge…" [opens commit UI with merge message prefilled], "Done" for stash/unshelve); Abort routing per op (`merge --abort`, `rebase --abort`, `cherry-pick --abort`, stash: re-apply guidance).
3. Mutation lane stays **held** by the paused op token so unrelated mutations queue behind resolution (reads still allowed) — prevents index corruption mid-resolution.
**Accept:** e2e for each producer op: conflict → resolve via wand+chevrons → continue completes op; abort mid-tri-editor restores clean pre-op state (snapshot assert); queued commit during pause executes only after continue.

---

## Contributions added this phase
View `gittree.conflicts`; commands `gittree.merge.{open,acceptYours,acceptTheirs,acceptBoth,ignoreBlock,revertBlock,acceptAllYours,acceptAllTheirs,magicWand,apply,abortFile,nextConflict,prevConflict,toggleSyncScroll}` + per-op `continue/abort` surface reuse; CodeLens providers on `gittree-rev:`/`gittree-merge:` docs; keybindings (`F7`, `shift+F7`, `alt+enter`, `ctrl+alt+enter`); settings `gittree.merge.{ui,resultMode,autoResolveWhitespace}`.

## Deviations

- **T1 (file-level command names):** the per-row accept commands are `gittree.merge.acceptYoursFile`/`acceptTheirsFile` — the contributions list's `acceptYours`/`acceptTheirs` ids are reserved for T4's block-level chevron commands (the plan names both surfaces; identical ids would collide).
- **T1 (Merge… placeholder):** `gittree.merge.open` routes delete/mode conflicts to their tailored QuickPick (step 3) today; text conflicts show an informational message until T3 lands the tri-editor, per the plan's own "`Merge…` (→ T3)" pointer. The parity-checklist line stays unticked until then.
- **T1 (op-less sources):** sessions born without an `inProgressOp` marker (stash-pop, `checkout -m`, unshelve) classify as `checkout-merge` for now — T7's lifecycle routing refines producer detection; their continue hook is the plan's "plain done" no-op.
- **T1 (AU/UA classification):** porcelain XY `AU` maps to *deleted-by-them* and `UA` to *deleted-by-us* — in both states one side has no stage-2/3 entry to merge against, so they behave exactly like their D counterparts in the resolution QuickPick.
- **T1 (headless seam):** the special-conflict QuickPick resolves through `GITTREE_TEST_SPECIAL_CHOICE` (index into the offered choices) — headless hosts cannot click QuickPicks.
- **T1 (P5-T4 fix surfaced by this suite):** running the new conflict fixtures alongside P5's exposed the unstable timestamp tie-break in `orderOldestFirst` (see PHASE-05 Deviations) — fixed with ancestry-based ordering.
- **T2 (marker size):** the canonical re-merge runs with `--marker-size=32` and fixed `-L ours/base/theirs` labels — content containing ordinary 7-char marker lines can never confuse the parser (asserted).
- **T2 (conflictStyle independence):** `--diff3` outranks any *parseable* `merge.conflictstyle`; an unparseable value (e.g. `zdiff3` on git < 2.35) dies inside git's config validation itself — shadowing via `-c` does not skip per-entry validation — but such a setup breaks the user's own merges first. The unit test probes which styles the local git supports and asserts identical segments across all of them.
- **T2 (line model):** lines carry their terminators end-to-end, so CRLF content and missing final newlines survive byte-exact and serialization is plain concatenation; reconstruction of a side that lacks a trailing newline is *modulo the final EOL* (the plan's stated invariant). §8's `ConflictBlock` gains `resolvedLines?` to carry auto/manual content; `resultRange` attaches in T3 (the compute module stays vscode-free so the heavy suite runs under vitest against real git).
- **T2 (size guard):** the 10 MB cap is checked with `cat-file -s` per stage *before* any blob is pulled into memory; the cap is injectable for tests.
- **T2 (binary QuickPick placement):** `gittree.merge.open` computes first and routes `binary`/`too-large` inputs to a whole-file side QuickPick (same `GITTREE_TEST_SPECIAL_CHOICE` seam); only text inputs still hit the T3 placeholder.

## Parity checklist (FEATURES.md §5)
- [ ] Conflicts dialog: file list + Accept Yours / Accept Theirs / Merge per file
- [ ] 3-pane window: Left = yours, Right = theirs, Center = result being built
- [ ] Magic Wand resolves all simple (non-overlapping) conflicts in one click
- [ ] Chevron `≫`/`≪` per-conflict pulls from either side into the center
- [ ] Center pane is a full editor: syntax highlighting **and working autocompletion**, free manual rewriting
- [ ] Accept Left / Accept Right global overwrite buttons
- [ ] Resolution feeds back into the originating operation (merge/rebase/cherry-pick/… continues)
