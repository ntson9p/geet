# Phase 7 — Stash & Shelve

**Goal:** FEATURES.md §6 — a full `git stash` GUI plus IntelliJ's proprietary Shelve: patch-file storage **outside `.git`** that survives repository deletion and destructive git surgery.

**Depends on:** P1; P6 (conflict handoff for pop/unshelve); P9-T1/T2 (snapshot before shelve-with-remove).
**Exit criteria:** stash and shelf round-trips are lossless (including untracked + binary files), diffable before restore, and conflict-safe.

---

## Tasks

### P7-T1 · StashService
**Depends:** P0-T2/T3 · **Complexity:** M
**Output files:** `src/stash/stashService.ts` + integration tests.
**Steps:**
1. Model from `git stash list --format='%gd%x00%H%x00%at%x00%gs'`; parse branch-of-origin from subject; refresh on `.git/refs/stash` + `logs/refs/stash` watcher events.
2. Ops (mutation lane): `push` (`-m <msg>`, flags: `--include-untracked` default-on, `--staged` [capability ≥ 2.35], pathspec subset for "stash selected files"), `apply`/`pop` (`--index` option to restore staged state; conflict → keep entry [pop demotes to apply semantics], open P6 session with source `stash-pop`), `drop` (confirm modal showing message + age; destructive-flagged), `branch <name> stash@{n}`.
3. Per-file access for diffs: tracked = `stash@{n}^..stash@{n}`; untracked live in the **third parent** (`stash@{n}^3`) — hide this detail behind `getStashFiles(n): {path, status, revPair}`.
**Accept:** integration: push/pop with untracked + staged flags round-trips worktree byte-identical; pop-conflict keeps the stash entry and populates conflicts view; third-parent untracked files enumerate correctly.

### P7-T2 · Stash UI
**Depends:** T1 · **Complexity:** S
**Output files:** `src/stash/stashView.ts`, view `gittree.stashes` (SCM container).
**Steps:**
1. TreeView: stash rows (`stash@{0} · message · 2h ago · from main`) → file children (status icon; click → `vscode.diff` of the T1 revPair **against the current working tree file** when it exists — spec's "diff stash against working tree"); "Compare all vs working tree" row action → multi-diff (`vscode.changes`).
2. Row inline/context actions: Apply, Pop, Drop, Branch from…, Copy message. View title: `+` Stash Changes… (flow: message input + option toggles + optional file subset via QuickPick multi), Clear All (typed-confirmation modal, destructive).
3. Palette commands mirror everything (`gittree.stash.*`).
**Accept:** view reflects external `git stash` CLI within 500 ms; every FEATURES §6 stash verb reachable in ≤ 2 clicks; diff opens for tracked + untracked entries.

### P7-T3 · Shelf storage engine
**Depends:** P0-T2, P9-T2 · **Complexity:** L
**Output files:** `src/shelf/shelfStore.ts` + unit/integration tests.
**Steps:**
1. Location: `<globalStorage>/shelf/<repoId>/` (repoId = remote-URL hash, falling back to path hash) — **outside `.git` and outside the workspace** (spec: survives repo deletion); `gittree.shelf.path` overrides (validated writable). Layout: `<id>/changes.patch` + `<id>/meta.json` (`{id, name, comment, createdAt, baseSha, branch, files: [{relPath, status, isBinary}], untrackedSnapshots: 'embedded'}`).
2. Capture: tracked changes = `git diff --binary --full-index HEAD -- <paths>`; untracked = temporary `git add -N <u>` → included in same diff → `git reset -q -- <u>` restores index (assert index mtime-safe under queue lock). `--binary` keeps images/etc. lossless.
3. **Verify-then-remove invariant:** if "remove from worktree" requested (IntelliJ shelve default), first `git apply --check --reverse` the fresh patch against the worktree (proves it re-applies), take a P9 snapshot, then `git restore --source=HEAD --worktree --staged -- <paths>` + delete captured untracked files. Any verify failure → shelve saved but removal skipped + warning.
4. Integrity: sha256 of patch stored in meta; checked before unshelve/edit.
**Accept:** integration: shelve(remove) of {modified, added-untracked, deleted, binary, CRLF} → worktree clean → unshelve restores byte-identical worktree incl. binary; simulated repo deletion (`rm -rf .git` + re-init) still lists and unshelves patches; corrupted patch detected.

### P7-T4 · Shelf UI (view, diff, edit)
**Depends:** T3 · **Complexity:** M
**Output files:** `src/shelf/shelfView.ts`, view `gittree.shelf` (SCM container — the spec's "Shelf tab").
**Steps:**
1. TreeView: shelved-change rows (name · relative time · N files · origin branch) → file children (click → before/after diff reconstructed by applying the file's hunks to `gittree-rev:<baseSha>` content in memory → `gittree-shelf:` right side via content provider).
2. Actions: Unshelve (T5), Unshelve to Active Changelist ▸ picker, Rename/Comment, Delete (confirm), Export `.patch`…, Import Patch… (validates + wraps external patches with meta), Show Patch (opens the raw `.patch` read-write).
3. **Edit patch:** on save of a shelf patch document, revalidate (`git apply --check` against baseSha tree via temp index); invalid → error decoration + revert offer; valid → meta rewrite (file list, hash).
4. Shelve entry points: view title `+`, changelist context menu "Shelve Changes…" (P3-T3 hook), SCM input flow (name defaults to changelist name/commit-message draft — IntelliJ behavior).
**Accept:** per-file diff renders for modified/added/deleted; hand-edited hunk that still applies unshelves with the edit; broken edit blocked with actionable error.

### P7-T5 · Unshelve engine
**Depends:** T3, P6-T7, P1-T3 (PatchBuilder/parser) · **Complexity:** M
**Output files:** `src/shelf/unshelve.ts`.
**Steps:**
1. Full or partial (file-subset picker → patch filtered via `patchParser` file split). Apply order: try `git apply --index` clean; on failure retry `git apply --3way` (uses `--full-index` blobs; produces staged conflicts) → P6 session (source `unshelve`); final fallback (blobs missing) → `.rej`-free error with "Export patch" escape hatch.
2. Post-apply: files land in target changelist (changelists paradigm) or stay staged (staging paradigm); option "Delete shelf entry after successful unshelve" (default on, skipped automatically when conflicts occurred until session completes).
3. Base drift note appended to confirmation when `baseSha` is not an ancestor of HEAD (`merge-base --is-ancestor`).
**Accept:** integration: clean unshelve on same base; conflicting unshelve after divergent commit → 3-way conflicts resolved via P6 → shelf entry auto-deleted post-completion; partial unshelve leaves remaining files shelved.

---

## Contributions added this phase
Views `gittree.stashes`, `gittree.shelf`; commands `gittree.stash.{push,pop,apply,drop,branch,clear,diffAll}`, `gittree.shelf.{shelve,unshelve,unshelvePartial,rename,delete,export,import,showPatch}`; changelist-context "Shelve Changes…"; settings `gittree.shelf.path`, `gittree.stash.includeUntrackedDefault`.

## Deviations

- **T1 (list model):** the service reads `repo.model.snapshot.stashes` and filters the model's `'stashes'` change section — the P0-T3 parser and P0-T6 git-dir watcher already cover `refs/stash` + its reflog, so no additional watcher exists.
- **T1 (conflict handoff):** a failed pop/apply registers P6-T7's `expectConflict(root, 'stash-pop')` producer hint *before* the refresh that creates the session; apply-conflicts classify as `stash-pop` too (the `ConflictSource` union deliberately has no separate apply value — abort guidance is identical).
- **T1 (`--staged` guard):** gated on `caps.stashStaged` (git ≥ 2.35) with a friendly error thrown inside the queued op before any git invocation; the e2e asserts the guard leaves no stash entry on old git and the full round-trip on new git.
- **T1 (push not snapshot-flagged):** `stash push` itself is the safety copy — P9's binding label matrix (pop/apply/drop/clear) is followed as-is; push runs as a plain mutation.
- **T2 (untracked diff right side):** a stashed-away untracked file has no working-tree counterpart, and `vscode.diff` errors on a missing `file:` side — the diff falls back to `gittree-rev:HEAD` for the right side (guaranteed empty for a file that was untracked), titled "… ↔ not in working tree".
- **T2 (palette fallback):** every `gittree.stash.*` command accepts an optional tree node and otherwise QuickPicks across all repos' stashes (`GITTREE_TEST_STASH_PICK`/`_PUSH`/`_BRANCH` seams for headless flows); Clear All uses a typed-confirmation input (`typedConfirm`, added to `ui/confirm.ts`, honoring the existing `GITTREE_TEST_AUTOCONFIRM` seam).
- **T2 (apply/pop restore the index):** the row/palette Apply and Pop pass `--index` — IntelliJ restores staged state on unstash; the service keeps it optional for callers that want git's default.
- **T3 (patch bytes never cross a string decode):** `GitExecutor` stdout is utf8-decoded, which is not byte-safe for arbitrary file content — the patch is written by git itself via `--output=<file>`, and sha256/reads use raw `Buffer`s throughout.
- **T3 (renames disabled):** the capture diff runs `--no-renames`, so every entry is a plain add/delete/modify — the meta schema stays exactly `{relPath, status, isBinary}` and removal stays uniform. A rename shelves as delete+add, byte-faithful either way.
- **T3 (added-file removal):** `git restore --source=HEAD` errors on paths absent from HEAD, so removal splits: modified/deleted → `restore --worktree --staged`; added/untracked → `reset -q` + fs delete.
- **T3 (snapshot placement + new label):** the P9 snapshot rides the binding `onWillRunDestructive` hook, so it fires before the whole capture mutation rather than between verify and restore as step 3 orders it — strictly earlier, superset coverage. `SNAPSHOT_LABELS.shelveWithRemove` ('Before: shelve (remove)') was added; the §10 matrix named only unshelve-with-remove, and the label-matrix unit test iterates the const so the new label is covered automatically.
- **T3 (single-mutation capture):** the whole classify → `add -N` → diff → `reset` → verify → remove pipeline is ONE queued mutation (index safety by construction; the `reset` undo sits in a `finally`); the non-remove e2e asserts `git status --porcelain` is byte-identical before/after, proving the ita dance never leaks.
- **T3 ("unshelve restores" acceptance):** T5 owns the unshelve engine, so the T3 round-trips apply the stored patch via raw `git apply --index` — proving the stored bytes restore the worktree byte-identically (the exact primitive T5 builds on).
- **T3 (repo-deletion e2e isolation):** the `rm -rf .git` + re-init scenario runs on an ephemeral temp repo with a directly-constructed `OperationQueue` over the extension's executor — destroying a shared workspace fixture repo would poison later suites (phase09 also runs on repoB).
- **T3 (store is vscode-free):** mirrors SnapshotStore — the register layer injects the store dir (per-repo `repoStoreKey` under `<globalStorage>/shelf`, `gittree.shelf.path` override validated by an actual write probe), the queue and a localized progress label; T4/T5 localize errors when surfacing them.
- **T4 (patchParser home):** the section splitter + in-memory hunk applier live in `src/core/patch/patchParser.ts` — T5 names that module, T4 merely consumes it first (per-file preview). Property-tested against real git diffs: lossless section concat, CRLF, no-final-newline transitions both ways, editor-stripped blank context lines, quoted import paths.
- **T4 (unshelve actions land with T5):** the phase table itself marks Unshelve as T5's; the tree/context unshelve entries ship with the engine. T4's "hand-edited hunk unshelves with the edit" acceptance is exercised through raw `git apply --index` of the revalidated patch — the same primitive T5 wraps.
- **T4 (edit validation is side-effect-free):** save revalidation runs `read-tree <baseSha>` + `apply --check --cached` under a throwaway `GIT_INDEX_FILE` on the read lane — the real index and worktree are untouched by validation regardless of verdict. A valid save re-consecrates the entry (new sha256 + refreshed file table); an invalid one leaves meta untouched, so the sha256 gate keeps the broken patch unusable everywhere.
- **T4 (revert-offer scope):** pristine bytes are cached when the patch opens via Show Patch; a patch edited through any other route is still blocked on a broken save (integrity gate) but without the one-click Revert Edit — a restart between open and save loses the cached copy by design (no sidecar backups).
- **T4 (binary rows):** binary shelf files render with a `binary` badge and no diff command (`shelf:file:binary` context) — the acceptance names modified/added/deleted only; binary fidelity is already proven by the T3 round-trip.
- **T4 (import base):** imported patches get `baseSha`/`branch` stamped from the repo's HEAD at import time (external patches carry no base); previews of files missing at that base fall back to an empty base side instead of erroring.
- **T5 (byte-safe partial split):** patch bytes are decoded latin1 (byte-preserving) before the `patchParser` section split, so re-encoded section slices are byte-identical even for non-UTF-8 file content; the applied paths are read back from `git apply --numstat -z` on the exact temp patch handed to git — real unquoted paths (unicode-safe) with no octal-unescaping of diff headers on our side.
- **T5 (target changelist):** IntelliJ's unshelve dialog prefills the target changelist with the shelf name — a clean unshelve in the changelists paradigm therefore unstages the applied paths (pathspec-limited `reset -q --`) and files them into a changelist named after the entry (created or reused), untracked files included via `moveFiles`. The staging paradigm leaves everything staged, exactly as `apply --index` put it. No separate "Unshelve to Active Changelist ▸" picker ships: the contributions list names only `unshelve`/`unshelvePartial`, and moving the files afterwards is the changelists view's own DnD job.
- **T5 (deferred delete semantics):** on a conflicted unshelve, delete-after arms a one-shot watcher on the P6 lifecycle's `onDidChangeSessions`; the lifecycle ends a session only when zero unmerged paths remain, so session-end ≙ resolution and the entry is deleted/pruned then. A session abandoned by external surgery (manual `git reset`) also counts as ended — the P9 pre-op snapshot covers that misuse.
- **T5 (partial prune inherits statuses):** pruning applied sections rewrites `changes.patch` to the remaining sections and re-consecrates via `updateAfterEdit`, inheriting each remaining file's status from the previous meta where the path matches — keeping `untracked` distinct from `added` (the parser alone cannot tell them apart).
- **T5 (failure is worktree-clean):** `git apply` is atomic per invocation — both ladder rungs either apply fully or touch nothing, so the final `.rej`-free failure path needs no cleanup; the error toast offers "Export Patch…" (reuses `gittree.shelf.export`).
- **T5 (snapshot labels):** a plain `SNAPSHOT_LABELS.unshelve` ('Before: unshelve') was added next to the §10 matrix's `unshelveWithRemove` so keep-entry unshelves are labeled honestly; the label-matrix unit test iterates the const and covers it automatically.
- **T5 (`GITTREE_TEST_SHELF_PICK` by name):** the pick seam now matches an entry by name before falling back to the numeric index — stable when earlier suites leave entries behind.

## Parity checklist (FEATURES.md §6)
- [x] Stash GUI: save (with message/options), list, apply, pop, drop, branch-from-stash
- [x] Diff any stash (incl. untracked contents) against the current working tree
- [x] Shelve stores `.patch` files on local disk entirely outside `.git`
- [x] Shelf survives deleting/re-initializing the repository
- [x] Shelf tab: view patches, edit them (validated), unshelve to working tree (full/partial, conflict-safe)
