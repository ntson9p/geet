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

## Parity checklist (FEATURES.md §6)
- [ ] Stash GUI: save (with message/options), list, apply, pop, drop, branch-from-stash
- [ ] Diff any stash (incl. untracked contents) against the current working tree
- [ ] Shelve stores `.patch` files on local disk entirely outside `.git`
- [ ] Shelf survives deleting/re-initializing the repository
- [ ] Shelf tab: view patches, edit them (validated), unshelve to working tree (full/partial, conflict-safe)
