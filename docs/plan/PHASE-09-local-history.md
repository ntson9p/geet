# Phase 9 — The Failsafe: Local History

**Goal:** FEATURES.md §8 — an offline, git-independent timeline of project states recorded around saves, test runs and **every destructive git operation**, restorable in a few clicks after a bad `reset --hard` or deleted file. Complements (never duplicates) VS Code's native file-save Local History.

**Scheduling note (binding):** **T1 and T2 start immediately after P0 and must be merged before P5 ships** — history rewriting may not reach users without the safety net. T3/T4 land after P4 (multi-diff/log UX reuse). The VS Code Timeline *provider* API is proposed-only and must not be used; our UX is self-hosted views + the native Timeline for per-file saves.

**Depends on:** P0 (T1/T2); P4 (T3/T4).
**Exit criteria:** `git reset --hard` of uncommitted work is fully recoverable in < 5 clicks; store honors size/age budgets; snapshot overhead on a 10k-file repo mutation ≤ 150 ms typical (dirty files only).

---

## Tasks

### P9-T1 · SnapshotStore
**Depends:** P0-T1 · **Complexity:** M
**Output files:** `src/localHistory/snapshotStore.ts` + unit tests.
**Steps:**
1. Layout under `<globalStorage>/history/<repoId>/`: `blobs/<sha256[0:2]>/<sha256>.gz` (content-addressed, gzip) + `manifests/<ulid>.json` (master-§8 `SnapshotManifest`). Content addressing dedupes unchanged files across snapshots for free.
2. API: `snapshot(label, trigger, files: Uri[]) → id` (reads current bytes; skips missing), `list(filter?)`, `read(id, relPath) → bytes`, `delete(id)`, `gc()`.
3. Limits: per-file cap `gittree.localHistory.maxFileSizeKb` (default 1024; oversized recorded as metadata-only stub with a "too large" marker), binary files included up to cap (they're exactly what `reset --hard` victims cry about).
4. GC: run on idle activation + post-snapshot when over budget — drop manifests beyond `retentionDays` (default 30) then oldest-first until under `maxSizeMb` (default 500); blobs swept when unreferenced (refcount from surviving manifests). Never GC the most recent snapshot per repo.
5. Concurrency: store is single-writer via a lightweight intra-extension mutex; corruption-tolerant reads (bad manifest → skipped + trace log).
**Accept:** unit: dedupe (two snapshots of same content = one blob), GC size/age policies, stub handling, unicode/deep paths on Windows (long-path safe via `\\?\` when needed).

### P9-T2 · Operation & task hooks
**Depends:** T1, P0-T5 · **Complexity:** M
**Output files:** `src/localHistory/hooks.ts`.
**Steps:**
1. Subscribe `OperationQueue.onWillRunDestructive`: enumerate affected files **cheaply** = current status entries (modified+staged+untracked) ∪ operation-declared extra paths (e.g. rollback targets); `snapshot('Before: <op label>', 'operation', files)` synchronously before the mutation runs (budgeted; > 2 000 dirty files → progress + still proceed). Post-op success adds a paired `After: …` label only when the op modified the worktree (checkout/merge/rebase), enabling before/after compare.
2. Destructive op coverage matrix (from master §10): checkout-dirty, force-checkout, reset (any mode), rebase (start/continue/skip/abort), merge, cherry-pick/revert, stash pop/apply/drop/clear, unshelve-with-remove, rollback (file/hunk/group), clean-untracked, branch -D, smart-checkout stash steps. Each op's `snapshotLabel` reviewed in this task and asserted by a table-driven test.
3. Test-run labels: `tasks.onDidEndTaskProcess` → if task group is test/build (`task.group`), label-only snapshot (`'After task: <name>'`, files = currently-dirty only) behind `gittree.localHistory.taskLabels` (default on, cheap).
4. Optional save snapshots: `onDidSaveTextDocument` debounced 30 s per file behind `gittree.localHistory.snapshotOnSave` (**default off** — native Local History owns per-save granularity; we point users there).
5. Kill-switch honored everywhere: `gittree.localHistory.enabled: false` → hooks no-op, views explain.
**Accept:** integration: every op in the coverage matrix produces a manifest with the right label + file set (table-driven over fixture repo); disabled setting produces zero writes; snapshot failure (read-only store dir) warns once but never blocks the git operation.

### P9-T3 · Browse & restore UX
**Depends:** T1/T2, P4 (multi-diff idiom), P0-T9 (optional) · **Complexity:** M
**Output files:** `src/localHistory/restoreUx.ts`, `src/core/vdocs/snapFs.ts` (`gittree-snap:` provider), view `gittree.localHistory` (SCM container, collapsed by default).
**Steps:**
1. Entry points (IntelliJ parity): explorer/editor context "Local History → Show History" (file/folder-scoped) and repo-level command + view. TreeView groups manifests by day → snapshot rows (`label · time · N files`); file-scoped invocations pre-filter to manifests touching that path.
2. Snapshot row actions: **Compare with Current** → multi-diff (`vscode.changes`) of `gittree-snap:<id>/<path>` vs current files (missing-now files diff against empty); per-file rows → single `vscode.diff`.
3. **Restore**: whole snapshot or checked file subset (QuickPick multi) → applied as one `WorkspaceEdit` (create/overwrite/restore-deleted; undoable in-session) after a paranoia `snapshot('Before restore', …)`; summary toast with "Undo restore".
4. Native-bridge affordance: file-scoped history view shows a footer link "Per-save versions: open native Timeline" (`workbench.view.timeline` focus command) — bridges the spec's Timeline mention without proposed APIs.
5. Purge controls: delete snapshot, "Clear Local History…" (typed confirmation), storage-usage row with GC-now.
**Accept:** e2e: seed edits → snapshot → further edits → compare shows both directions → subset restore recreates deleted file byte-identical and is undoable; folder-scoped entry filters correctly.

### P9-T4 · Destruction detection & recovery prompts
**Depends:** T2, T3 · **Complexity:** S
**Output files:** `src/localHistory/recoveryWatch.ts`.
**Steps:**
1. Reflog watcher (`.git/logs/HEAD` tail on change): detect externally-run `reset --hard`/`checkout -f`/branch deletion (reflog subject parse) that our queue didn't initiate; if the pre-event status had dirty files (last model snapshot) or commits became unreachable → toast: "That looked destructive. Restore files from Local History / Recover commit <shortsha> (create branch) / Dismiss".
2. "Recover commit" = `git branch recovered/<shortsha> <sha>` after `cat-file -e` liveness check.
3. Our own destructive ops finish with a quiet status-bar hint (`$(history) snapshot saved`) linking to T3 — discoverability without nagging; frequency-capped.
**Accept:** integration: external `git reset --hard HEAD~1` with dirty worktree fires the toast; recover-branch resurrects the sha; hint appears at most once per session per op type.

---

## Contributions added this phase
View `gittree.localHistory`; commands `gittree.history.{show,showForPath,compareSnapshot,restoreSnapshot,restoreFiles,deleteSnapshot,clearAll,gcNow}`; explorer/editor context submenu "Local History"; settings `gittree.localHistory.{enabled,maxSizeMb,retentionDays,maxFileSizeKb,snapshotOnSave,taskLabels}`.

## Parity checklist (FEATURES.md §8)
- [x] Automatic recording around every destructive git operation (+ test-run labels, optional save snapshots) — hook mechanism + binding SNAPSHOT_LABELS matrix landed (T2); each later phase's destructive ops must declare these labels (asserted by the table-driven test).
- [x] Completely git-independent storage (survives `.git` deletion; lives in globalStorage)
- [ ] Right-click → Local History → Show History at file, folder and repo scope
- [ ] Compare any recorded state with current, then restore exact file states selectively
- [ ] Bad `reset --hard` / deleted uncommitted file is recoverable; external destruction is detected and prompts recovery
- [ ] Bridges to VS Code's native Timeline for per-save file history
