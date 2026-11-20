# Geet — Master Implementation Blueprint

**Goal:** A VS Code extension ("Geet", id `gittree`) with 100% feature and UX parity with IntelliJ IDEA Ultimate's Git integration, per [FEATURES.md](FEATURES.md).
**Audience:** Autonomous AI coding agents. This file is binding for every task. Per-phase task specs live in [docs/plan/](docs/plan/).
**Generated:** 2026-07-11 · Source spec: FEATURES.md @ commit `1a87412`.

---

## 0. Agent operating rules

1. Read this file fully once; then read only the phase file for your task.
2. Pick the lowest-numbered task in your assigned phase whose `Depends:` list is fully merged. One task = one branch (`pXX/tY-short-slug`) = one PR.
3. **Definition of Done:** `npm run check` passes (typecheck + eslint + unit tests), integration smoke suite green on the fixture repo, the phase file's parity checklist items covered by the task are ticked in the PR diff, and no proposed VS Code APIs are used.
4. Platform floors: **VS Code engine `^1.96.0`**, **git ≥ 2.36** (probe at startup via `git --version`; build a `GitCapabilities` map and degrade gracefully below floor), Node 20 (VS Code's bundled runtime), TypeScript strict mode.
5. Every git invocation goes through `GitExecutor` (§8) with **argument arrays — never shell strings**. Never parse localized git output; use porcelain/`--format` output with `-z` NUL delimiters wherever git supports it.
6. Shared files (`package.json`, `src/extension.ts`) are edited **append-only**: each phase exposes a single `registerPhaseXX(ctx, core)` entry point and its own `contributes` block section, to keep parallel agents conflict-free.
7. All UI must work in light / dark / high-contrast themes and be fully keyboard-operable. All user-visible strings go through `vscode.l10n.t()`.
8. Do not commit generated artifacts (`dist/`, `out/`, `.vsix`).

---

## 1. Product summary & non-goals

Geet replaces the built-in Git experience with an IntelliJ-grade one: changelists **and** staging paradigms, a graph log tool window, drag-and-drop interactive rebase, a true 3-pane merge editor with full IntelliSense in the result pane, shelve, deep GitHub/GitLab review, and an operation-scoped Local History failsafe.

**Non-goals (v1):** SVN/Hg/Perforce, submodule management beyond listing, JetBrains "Analyze Code" depth beyond LSP diagnostics (we gate on `vscode.languages.getDiagnostics`), Code With Me-style collaboration, worktree management UI.

---

## 2. Architecture overview

```
┌─ UI surfaces ────────────────────────────────────────────────────────────┐
│ SCM view (input, groups) · TreeViews: Changelists, Branches, Stash,      │
│ Shelf, Conflicts, Pull Requests, Local History · QuickPicks (Branches    │
│ popup, msg history) · Status bar widget · Editor decorations, CodeLens,  │
│ quick-diff peek · Webviews: Log Graph, Interactive Rebase, Compare,      │
│ PR Timeline · Tri-Editor merge composition (3 real editors)              │
├─ Application services ───────────────────────────────────────────────────┤
│ BranchService · ChangelistService · CommitService · CheckPipeline ·      │
│ LogService · BlameService · RebaseService · MergeService · StashService ·│
│ ShelfService · ReviewService (GitHub/GitLab) · LocalHistoryService       │
├─ Domain core ────────────────────────────────────────────────────────────┤
│ RepositoryModel (observable state) · OperationQueue (1 writer, N readers)│
│ GitExecutor · Porcelain parsers · GitDirWatcher · SnapshotStore ·        │
│ PatchBuilder · VirtualDocs (content/FS providers)                        │
├─ Platform ───────────────────────────────────────────────────────────────┤
│ child_process(git) · fs · VS Code API · GitHub GraphQL/REST · GitLab REST│
└──────────────────────────────────────────────────────────────────────────┘
```

- **Process model:** everything runs in the extension host except webview renderers. Parallelism comes from git child processes; large parses stream and yield (`setImmediate` every ~2 000 lines) to keep the event loop responsive. No worker threads in v1.
- **Multi-root / multi-repo:** every service is keyed by repository; UI scopes to the "active" repo (derived from active editor, falling back to a repo picker), mirroring the built-in git extension's behavior.
- **Virtual document schemes** (registered once in P0, reused everywhere):
  - `gittree-rev:` read-only file content at a revision or index stage (`?ref=<sha>|:1|:2|:3`), via `TextDocumentContentProvider`.
  - `gittree-merge:` writable in-memory merge result docs, via `FileSystemProvider`.
  - `gittree-snap:` read-only Local History snapshot content.
  - `gittree-pr:` read-only PR base/head content served from provider APIs (cached).

---

## 3. Coexistence with the built-in Git extension

> **SUPERSEDED by Phase 14** (`docs/plan/PHASE-14-owning-the-scm-surface.md`). Geet no
> longer coexists *by negotiation*: it does not compete for the built-in extension's surfaces,
> so there is nothing to negotiate. The mode machinery below is gone — `ModeManager`, the
> consent modal and the `gittree.mode` setting were deleted in P14-T6, and a one-shot migration
> removes the `git.enabled` override from any workspace that had consented to takeover.
>
> **What holds now:** Geet registers no `vscode.scm` SourceControl, contributes no `scm/*`
> menus, hosts its views in its own activity-bar container, paints its own change bars, and
> reads no `git.*` configuration. Enabling or disabling the built-in Git extension changes
> nothing about how Geet behaves. The single remaining overlap — explorer file decorations,
> which both extensions can badge — is a plain user setting, `gittree.decorations.fileExplorer`
> (deviation D22).
>
> The original table is kept below as history, because PROGRESS.md and six phase documents
> reference it. **It no longer describes the product.**

~~Two SCM providers on one repo means duplicate gutter bars, status entries and status-bar items. `ModeManager` (P0-T7) owns the strategy; **every UI-registering module must consult it**.~~

| ~~Mode~~ | ~~Behavior~~ | ~~When~~ |
|---|---|---|
| ~~**Takeover** (recommended default)~~ | ~~One-time consent modal explains the change, then writes `git.enabled: false` to workspace settings. Geet provides all SCM UI.~~ | ~~User accepts onboarding prompt.~~ |
| ~~**Companion**~~ | ~~Built-in git stays on. Geet does **not** register its `QuickDiffProvider` or `FileDecorationProvider`; its SourceControl hosts only the changelist/commit UI.~~ | ~~User declines, or until they opt in.~~ |

~~Notes: never flip `git.enabled` without explicit consent (Marketplace policy + trust). Read the user's `git.path` setting first when locating the git binary.~~ The `git.path` fallback was also removed in P14-T5: Geet resolves the binary from `gittree.gitPath`, `PATH` and well-known install locations only.

---

## 4. State management & concurrency (binding design)

**RepositoryModel** (per repo) holds an immutable snapshot: `headRef, headSha, upstream, aheadBehind, refs[], statusEntries[] (worktree+index), inProgressOp (merge|rebase|cherry-pick|revert + step/total), stashes[], lastFetchAt, capabilities`. Mutations produce a new snapshot and fire `onDidChange(changedSections)`. All views subscribe; none run git directly.

**OperationQueue** (per repo):
- One **mutation lane** (serialized writes: commit, checkout, rebase-step, stash, apply…). Each mutation carries `{label, isDestructive, snapshotLabel?}`; destructive ones trigger a pre-operation Local History snapshot (P9) once available.
- A **reader pool** (max 4 concurrent: status, log pages, blame). Readers are cancelled and rescheduled when a mutation starts.
- `index.lock` contention (external git/CLI): classify from stderr, retry ×5 with 50→800 ms exponential backoff + jitter before surfacing.
- Long ops wrap in `window.withProgress` (SourceControl location; notification with Cancel if > 2 s). Cancellation = SIGTERM (POSIX) / `taskkill /T` (Windows).

**Watchers → refresh pipeline:**
- `fs.watch` on `.git/HEAD`, `.git/index`, `.git/packed-refs`, `.git/refs/**`, `.git/MERGE_HEAD`, `.git/CHERRY_PICK_HEAD`, `.git/REVERT_HEAD`, `.git/rebase-merge/`, `.git/rebase-apply/`, `.git/sequencer/` (the VS Code workspace watcher excludes `.git` by default, so use raw `fs.watch`, handling `.git`-file worktrees).
- One workspace `FileSystemWatcher('**/*')` for worktree changes (respects `files.watcherExclude`).
- Events debounce 200 ms and coalesce into a single `StatusRefresher.refresh()` → `git status --porcelain=v2 -z --branch --untracked-files=all` with `GIT_OPTIONAL_LOCKS=0`.
- **Self-inflicted-event suppression:** the queue marks a window around its own mutations; watcher events inside it fold into the single post-op refresh.

**Caches & invalidation:** blame keyed by `(uri, documentVersion)`; log pages keyed by canonical filter string (LRU 20); ref list; author list. Invalidation keys: `(HEAD sha, index mtime, workdirGeneration counter)`.

**Credentials:** GIT_ASKPASS bridge exactly like the built-in extension: spawn env sets `GIT_ASKPASS` to a tiny shim (`.cmd`+`.sh`) that re-invokes `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and talks to the extension over a token-authenticated named pipe / unix socket; the extension answers from `vscode.authentication` (GitHub) or `SecretStorage`, else shows an input box. Always set `GIT_TERMINAL_PROMPT=0`. Optionally export the same askpass into integrated terminals via `context.environmentVariableCollection`.

---

## 5. Traceability matrix — every FEATURES.md item → strategy → APIs → tasks

### §1 Global UI & editor integration

| Spec item | Realization | Key VS Code APIs / git plumbing | Tasks |
|---|---|---|---|
| 1.1 Color-coded gutter bars (added/modified/deleted) | Register our SourceControl's `quickDiffProvider`; VS Code renders the bars natively | `scm.createSourceControl`, `QuickDiffProvider.provideOriginalResource` (serves `gittree-rev:` HEAD-or-index content) | P1-T2 |
| 1.1 Click-to-diff floating popup | Native dirty-diff peek widget (comes free with quick diff) | core behavior; no extra API | P1-T2 |
| 1.1 Inline rollback / stage / commit from popup | Contribute commands to the peek widget's toolbar | `menus.scm/change/title` (command receives `(uri, changes[], index)`); rollback applied as reverse `WorkspaceEdit` (undoable) | P1-T3 |
| 1.2 Toggle "Annotate with Git Blame" from gutter right-click | Gutter context menu contribution | `menus.editor/lineNumber/context` (+ command palette fallback) | P4-T7 |
| 1.2 Per-line author/date/hash column | Per-line `TextEditorDecorationType` with `before` content (GitLens-proven technique) | `window.createTextEditorDecorationType`, `setDecorations`; `git blame --incremental --porcelain`, `--contents -` for dirty buffers | P4-T6, P4-T7 |
| 1.2 Heat-map color fading by age | Compute rgba alpha per age bucket (percentile of commit times in file), light/dark variants | decoration render options per bucket (10 pre-created types) | P4-T7 |
| 1.2 Click blame → open commit in log | Hover markdown with `command:` links (`isTrusted`), status-bar blame entry for cursor line, `gittree.log.revealCommit` | `languages.registerHoverProvider`, `MarkdownString.isTrusted`, `onDidChangeTextEditorSelection` | P4-T7 → P4-T3 |
| 1.3 Status-bar widget: branch + in/out arrows | `SourceControl.statusBarCommands` (same slot the built-in git uses) with `$(git-branch) main $(arrow-down)2 $(arrow-up)1`; counts from `git rev-list --left-right --count @{u}...HEAD` after auto-fetch | `SourceControl.statusBarCommands` | P1-T5 |
| 1.3 Click widget → Branches popup | Command opens P2 QuickPick | — | P1-T5, P2-T2 |

### §2 Branch management

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Searchable popup with categories | `window.createQuickPick` with `QuickPickItemKind.Separator` groups: Current / Favorites / Recent / Local / Remote; native type-to-filter | QuickPick API | P2-T2 |
| Recent branches by checkout frequency | Parse `git reflog --format=%gs` `checkout: moving from X to Y` entries; score by recency+frequency | reflog parser | P2-T1 |
| Favorites star | Per-item `QuickInputButton` (star icon) toggling a `globalState` set; favorites pinned to top | `QuickPickItem.buttons`, `onDidTriggerItemButton` | P2-T1, P2-T2 |
| Smart Checkout on dirty-conflict | Classify checkout stderr (`would be overwritten`); modal offers Smart Checkout / Force / Cancel; flow = `stash push -u` → checkout → `stash pop`; pop conflict → keep stash, open P6 session | `window.showWarningMessage({modal:true})` | P2-T4 |
| Per-branch context actions (checkout, checkout+rebase, new branch from, rename, delete, push) | QuickPick item "…" button opens an actions QuickPick; **plus** a persistent Branches TreeView with real right-click menus | `menus.view/item/context` + `TreeItem.contextValue` | P2-T2, P2-T3, P2-T6 |
| Compare with Current (commits + file diffs) | Two-sided commit lists (`git log --left-right A...B`) + multi-file diff (`git diff A...B --name-status`) opened in the multi-diff editor; upgraded to a rich webview tab after P4 | `vscode.changes` command, `gittree-rev:` docs | P2-T5 (P4-T5 upgrade) |
| Show Diff with Working Tree | `git diff <branch> --name-status` → multi-diff editor | `vscode.changes` | P2-T5 |

### §3 Commit lifecycle

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Two paradigms, user-configurable | `gittree.commit.paradigm`: `changelists` (default) \| `staging`; ParadigmManager swaps the UI | settings + `setContext` for `when` clauses | P3-T1 |
| Changelists (index-bypassing buckets) | ChangelistService model persisted in `workspaceState`; UI = TreeView **with checkboxes** contributed into the SCM container; drag-and-drop moves files between lists; SCM view itself shows only the commit input box | `TreeItemCheckboxState`, `TreeView.onDidChangeCheckboxState`, `TreeDragAndDropController`, `contributes.views.scm` | P3-T2, P3-T3 |
| Commit checked files bypassing the index | `git commit --only -- <paths>`; untracked files get `git add -N` first (verify in integration test) | plumbing | P3-T5 |
| Staged/Unstaged split | Two `SourceControlResourceGroup`s (native SCM look) | SCM API | P3-T4 |
| Hunk/line-level staging with `>>` | Open index↔worktree diff editor; "Stage/Unstage/Revert Selected Ranges" via editor selection → minimal patch (`PatchBuilder`) → `git apply --cached [--reverse] --unidiff-zero -` | `menus.editor/context` + diff-editor gutter commands | P3-T4 |
| Pre-commit checks 1–5 | `CheckPipeline` of `CommitCheck`s: format modified ranges (`executeFormatRangeProvider` on diff-derived ranges), organize imports (`source.organizeImports` code action), diagnostics gate (save → await quiesce → threshold modal Review/Commit Anyway), TODO scan of **added** diff lines (configurable regex), cleanup (`source.fixAll`) | `vscode.languages.getDiagnostics`, `onDidChangeDiagnostics`, `executeCodeActionProvider`, `withProgress` | P3-T7, P3-T8 |
| Commit message history dropdown | Ring buffer (50) in `globalState` per repo; QuickPick + up-arrow keybinding on SCM input | QuickPick, `scm.inputBox` | P3-T6 |
| Amend checkbox | Toggle loads `git log -1 --format=%B` into input; commit runs `--amend` | `commit --amend` | P3-T5 |
| Sign commit toggle | Toolbar toggle icon; commit adds `-S` (or `-c commit.gpgsign=true`); detect signing config; Windows pinentry caveat documented | `menus.scm/title` toggle via `setContext` | P3-T5 |

### §4 Git log & history

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Topological color-coded graph | React webview in a **bottom-panel view container** (IntelliJ tool-window parity); canvas-drawn lanes/edges + DOM virtualized rows; pure-TS `GraphLayout` lane-assignment lib | `contributes.viewsContainers.panel`, `WebviewViewProvider`, canvas | P4-T2, P4-T3 |
| Date / Topo / IntelliSort | `git log --date-order|--topo-order` streamed; IntelliSort = custom DFS topo emitting each merge's second-parent chain contiguously below the merge (feature-flagged) | `git log --format=…%x00 -z --parents`, `commit-graph write --reachable` for speed | P4-T1, P4-T2 |
| Filters: branch / user / date / path (intersecting) | Filter bar in webview → canonical `LogFilter` → args: refs list, `--author` (multi), `--since/--until`, `-- <pathspec>`, `--grep -i` | author autocomplete from cached `git log --format='%aN <%aE>' --use-mailmap` dedupe | P4-T4 |
| Commit context menu (native feel inside webview) | `data-vscode-context='{"sha":…}'` on rows + `menus.webview/context` contributions → real native menus | `webview/context` menu contribution | P4-T3, P4-T5 |
| Interactive rebase (drag-and-drop, action dropdowns) | Dedicated React webview: pointer-based row DnD, per-row action select (pick/reword/squash/fixup/drop), squash-group preview, message editors. Execution: `GIT_SEQUENCE_EDITOR` shim writes our plan into the todo file; rewords/squash messages via `exec git commit --amend -F <msgfile>` steps (no GIT_EDITOR juggling). `ELECTRON_RUN_AS_NODE=1` in spawn env so the shim can run via `process.execPath` | `WebviewPanel`, sequence-editor shim, `.git/rebase-merge/{done,end,msgnum}` progress | P5-T1, P5-T2 |
| Undo Commit | Guard: warn if `git merge-base --is-ancestor <sha> @{u}` (already pushed). `git reset --soft HEAD^`; in changelist mode also unstage and file the changes into a new changelist named after the commit subject | plumbing | P5-T3 |
| Revert Commit | `git revert` (multi-select aware) with conflict handoff to P6 | plumbing | P5-T4 |
| Cherry-Pick | `git cherry-pick` from log selection; conflict handoff; `-x` optional setting | plumbing | P5-T4 |
| Drop Commit | Background `git rebase --autostash --onto <sha>^ <sha>` with pushed-commit guard and merge-in-range warning | plumbing | P5-T3 |

### §5 3-way merge engine

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Conflicts dialog (file list + Accept Yours/Theirs/Merge) | `gittree.conflicts` TreeView (SCM container) with inline per-file actions + accept-all title actions; auto-revealed toast when conflicts appear | TreeView + `view/item/context` inline commands; `git checkout --ours/--theirs -- <p>` + `git add` | P6-T1 |
| 3-pane Left(Yours)/Center(Result)/Right(Theirs) | **Tri-Editor composition of three real editors**: `vscode.setEditorLayout` 3 columns; left/right = read-only `gittree-rev:` stage docs (`:2`/`:3`); center = writable `gittree-merge:` result doc → **full native IntelliSense in center** (the reason we reject Monaco-in-webview). Scroll-synced via `onDidChangeTextEditorVisibleRanges` + `revealRange` with feedback guard | `setEditorLayout`, `FileSystemProvider`, TextDocumentContentProvider, decorations | P6-T2, P6-T3 |
| Conflict model | Regenerate canonically from stages: `git show :1|:2|:3:<path>` + `git merge-file -p --diff3` → segment list `[common | conflict{base,ours,theirs}]`; block positions tracked with decoration ranges (VS Code auto-adjusts them on edit) | plumbing | P6-T2 |
| Chevrons `>>` / `<<` | CodeLens on left/right/center docs per conflict block: "Accept Yours ≫", "≪ Accept Theirs", "Accept Both", "Ignore"; applying replaces the block's range in the result doc | `languages.registerCodeLensProvider`, keybindings | P6-T4 |
| Magic Wand | Auto-resolver: rules = identical changes → take either; one side == base → take other; disjoint base-anchored sub-ranges inside block → weave; whitespace-only divergence → take substantive side (configurable). Toolbar action + resolved-count toast; heavy unit fixture suite | pure TS lib | P6-T5 |
| Accept Left / Accept Right (global) | Title-bar commands resolving all blocks one way | `menus.editor/title` on result doc | P6-T4 |
| Apply / abort lifecycle | "Apply" writes result to worktree, `git add`, closes session, offers `merge|rebase|cherry-pick --continue`; abort commands throughout; optional bridge to the native merge editor via internal `_open.mergeEditor` behind a capability probe + setting | OperationQueue integration | P6-T6, P6-T7 |

### §6 Stash & shelve

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Stash GUI (save/list/diff/apply/pop/drop/branch) | StashService + Stashes TreeView (stash → files); create flow with message + `--include-untracked`/`--staged` (git ≥ 2.35) options; per-file diff vs working tree via `gittree-rev:` (`stash@{n}` incl. 3rd-parent untracked handling) | TreeView, `vscode.diff`, `git stash …` | P7-T1, P7-T2 |
| Shelve (patches outside `.git`) | Patch store in `globalStorage` (survives repo deletion; path configurable): `git diff --binary --full-index HEAD` (+ `add -N` dance for untracked, index restored after) + sidecar JSON metadata; **verify patch re-applies cleanly before** optionally reverting the worktree | plumbing + fs | P7-T3 |
| Shelf tab UI: view / edit / unshelve | Shelf TreeView; open patch in editor with revalidation on save; per-file before/after reconstruction; unshelve = `git apply --3way` (conflicts → P6), partial unshelve via filtered patch; delete-after-unshelve option; `.patch` import/export | TreeView, editor | P7-T4, P7-T5 |

### §7 Provider integrations

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Auth | GitHub via built-in `vscode.authentication.getSession('github', …)`; GitLab via our own registered `AuthenticationProvider` (PAT + OAuth device flow, `SecretStorage`); self-hosted hosts configurable | auth APIs, `registerUriHandler` | P8-T1 |
| PR list + filters (assignee/author/state) | `ReviewProvider` abstraction; TreeView with query groups + filter QuickInputs; polling with backoff + ETag cache | TreeView; GitHub GraphQL, GitLab REST | P8-T2..T4 |
| In-IDE diffs | `gittree-pr:` FileSystemProvider for base/head; per-file `vscode.diff` + "all files" multi-diff; checkout PR branch via `git fetch origin pull/<n>/head` / `merge-requests/<iid>/head` | FS provider, `vscode.changes` | P8-T5 |
| Line comments, reviews (Approve/Request Changes), merge | `vscode.comments.createCommentController` threads mapped to provider review threads; position re-mapping across new commits via diff hunks; pending-review batching; merge/squash/rebase + delete-branch via API | Comment API | P8-T6, P8-T7 |
| Timeline + CI status | PR Timeline webview: conversation, reviews, commits, checks/pipelines with live poll | webview | P8-T7 |

### §8 Local History

| Spec item | Realization | Key APIs / plumbing | Tasks |
|---|---|---|---|
| Record every save / test run / git operation | SnapshotStore (content-addressed gzip blobs + JSON manifests in `globalStorage`, size/age budgets + GC). Hooks: OperationQueue pre/post labels on destructive mutations; `tasks.onDidEndTaskProcess` labels; optional debounced save snapshots (default off — native Local History covers saves; we **bridge**, not duplicate) | fs, tasks API | P9-T1, P9-T2 |
| Restore after destructive command | "Show Local History" (repo root or file): snapshot list → multi-diff vs current (`gittree-snap:` + `vscode.changes`) → selective restore as undoable `WorkspaceEdit` (with paranoia pre-restore snapshot). Reflog watcher detects `reset --hard`/branch deletion and toasts "Recover…" (branch at dangling sha / snapshot restore) | QuickPick/TreeView | P9-T3, P9-T4 |
| Bridge to native Timeline | Timeline **provider** API is still proposed → not used. We document/deep-link native file-save Local History and provide our own repo-wide operation snapshots on top | — | P9-T3 |

---

## 6. Bespoke-UX gap decisions (IntelliJ artifact → VS Code realization)

| IntelliJ artifact | Chosen realization | Rejected alternative & why |
|---|---|---|
| Branches popup | QuickPick (separators, item buttons, multi-step flows) + persistent TreeView for real context menus | Webview popup: non-native focus/search, poor keyboard parity |
| Changelist checkboxes | TreeView `TreeItemCheckboxState` + DnD controller inside SCM container | SCM resource groups: no checkbox support |
| Commit dialog pre-check UI | Native: view-title toggles + gear QuickPick (multi-select) + progress pipeline | Webview commit dialog: loses native SCM input, IME/undo quirks |
| Interactive rebase drag-and-drop | React webview (pointer DnD) + native menus via `data-vscode-context`; sequence-editor shim executes | TreeView DnD: can't render action dropdowns/squash grouping inline |
| 3-way merge with autocompleting center pane | Tri-Editor: three real editors, writable virtual result doc → full LSP | Monaco-in-webview: no LSP autocomplete (violates spec); native merge editor kept as optional bridge (layout ≠ IntelliJ, internal open command) |
| Click-to-diff gutter popup with rollback | Native quick-diff peek + `scm/change/title` actions — pixel-equivalent affordance | Custom hover widget: can't anchor to gutter reliably |
| Blame heat map | Pre-created decoration types per age bucket, `before` text column | `registerFileDecorationProvider`: file-level only |
| Log graph | Canvas + virtualized DOM rows in panel webview | TreeView: cannot draw edges; SCM "history" APIs: proposed |
| Local History | Own snapshot store + native Timeline complement | `TimelineProvider`: proposed API, unpublishable |

---

## 7. Repository layout & ownership

```
git-tree-vsix/
├── package.json                # manifest; per-phase contributes blocks (append-only)
├── tsconfig.json  eslint.config.mjs  .vscodeignore  .gitattributes (eol=lf)
├── esbuild.mjs                 # extension-host bundle → dist/extension.js
├── src/
│   ├── extension.ts            # thin: builds Core, calls registerPhaseXX()
│   ├── shared/protocol.ts      # RPC + DTO types (host ⇄ webview, single source)
│   ├── core/                   # P0 owns
│   │   ├── git/  (executor.ts, parsers/, capabilities.ts, errors.ts, askpass/)
│   │   ├── model/ (repositoryModel.ts, refs.ts, statusEntry.ts)
│   │   ├── ops/   (operationQueue.ts, statusRefresher.ts)
│   │   ├── watch/ (gitDirWatcher.ts, workspaceWatcher.ts)
│   │   ├── vdocs/ (revContentProvider.ts, mergeFs.ts, snapFs.ts)
│   │   ├── patch/ (patchBuilder.ts, patchParser.ts)
│   │   └── modeManager.ts
│   ├── scm/                    # P1: sourceControl.ts, quickDiff.ts, decorations.ts
│   ├── branches/               # P2
│   ├── commit/                 # P3: changelists/, staging/, checks/, messageHistory.ts
│   ├── log/                    # P4: logService.ts, graphLayout/ (pure lib), blame/
│   ├── rewrite/                # P5: rebase/ (incl. shims/), undoDrop.ts, revertCherryPick.ts
│   ├── merge/                  # P6: session.ts, triEditor.ts, resolver/ (magic wand)
│   ├── stash/  shelf/          # P7
│   ├── review/                 # P8: providers/ (github.ts, gitlab.ts), comments/, prTree.ts
│   ├── localHistory/           # P9: snapshotStore.ts, hooks.ts, restoreUx.ts
│   └── ui/                     # shared: quickpicks.ts, statusBar.ts, progress.ts
├── webview-ui/                 # Vite + React 18 multi-entry workspace
│   └── src/{lib/, log/, rebase/, compare/, pr/}   → dist/webviews/<app>/
├── shims/                      # seq-editor.cjs, askpass.cjs (+ .sh/.cmd launchers)
├── test/
│   ├── unit/                   # vitest: parsers, layout, resolver, patch
│   ├── integration/            # @vscode/test-electron against fixture repos
│   └── fixtures/               # fixtureRepo.ts builder + merge/ triples
└── docs/plan/                  # this blueprint's phase files
```

Ownership: a phase only creates/edits its own directories plus append-only registration in `extension.ts`/`package.json`. `src/shared/protocol.ts` changes require a note in the PR description (webview + host both compile against it).

---

## 8. Shared contracts (binding TypeScript)

```ts
// core/git
interface GitExecutor {
  readonly version: string; readonly caps: GitCapabilities;
  exec(repo: RepoId, args: string[], o?: ExecOpts): Promise<GitResult>;         // buffered
  stream(repo: RepoId, args: string[], onLine: (l: string) => void, o?: ExecOpts): Cancellable; // NUL/LF framed
}
interface ExecOpts { stdin?: string; env?: Record<string,string>; token?: CancellationToken; noOptionalLocks?: boolean }
interface GitResult { stdout: string; stderr: string; exitCode: number }
class GitError extends Error { kind: 'index-lock'|'would-overwrite-checkout'|'merge-conflict'|'auth'|'not-fast-forward'|'no-upstream'|'unknown'; stderr: string }

// core/ops
interface Operation<T> { label: string; kind: 'read'|'mutate'; isDestructive?: boolean; snapshotLabel?: string;
  run(git: GitExecutor, token: CancellationToken): Promise<T> }
interface OperationQueue { enqueue<T>(repo: RepoId, op: Operation<T>): Promise<T>; onWillRunDestructive: Event<DestructiveOpEvent> }

// commit
interface Changelist { id: string; name: string; comment?: string; isDefault: boolean; isActive: boolean; files: Uri[] }
interface CommitCheck { id: string; label: string; configKey: string;
  run(ctx: { repo: RepoId; files: Uri[]; token: CancellationToken; progress: Progress<string> }): Promise<CheckResult> }
type CheckResult = { ok: true } | { ok: false; blocking: boolean; message: string; reveal?: () => Promise<void> }

// merge
interface ConflictBlock { id: number; base: string[]; ours: string[]; theirs: string[];
  resolution?: 'ours'|'theirs'|'both'|'auto'|'manual'; resultRange: Range /* decoration-tracked */ }

// review
interface ReviewProvider { host: 'github'|'gitlab'; capabilities: ReviewCaps;
  listPullRequests(q: PRQuery): Promise<PRSummary[]>; getPullRequest(id: PRId): Promise<PRDetail>;
  listThreads(id: PRId): Promise<ReviewThread[]>; createComment(...): Promise<void>; reply(...): Promise<void>;
  submitReview(id: PRId, verdict: 'approve'|'request_changes'|'comment', body?: string): Promise<void>;
  merge(id: PRId, m: 'merge'|'squash'|'rebase', deleteBranch: boolean): Promise<void>;
  checks(id: PRId): Promise<CheckRun[]> }

// localHistory
interface SnapshotManifest { id: string; ts: number; label: string;
  trigger: 'operation'|'task'|'save'|'manual'; files: { relPath: string; blobSha: string; mode: number }[] }

// webview RPC (src/shared/protocol.ts) — every request idempotent or guarded; webviews reload
type Msg =
  | { v: 1; id: string; kind: 'req';  method: string; params: unknown }
  | { v: 1; id: string; kind: 'res';  result?: unknown; error?: { code: string; message: string } }
  | { v: 1; id: string; kind: 'evt';  method: string; params: unknown };
```

---

## 9. Webview platform standards (P0-T9 delivers the kit)

- React 18 + TypeScript + Vite, one entry per app, output `dist/webviews/<app>/`. No CDN resources; strict CSP with nonce; `asWebviewUri` for all assets.
- Theming exclusively via `--vscode-*` CSS variables; codicons via the bundled font. No hardcoded colors.
- State: `vscode.getState/setState` for scroll/selection + full rehydrate protocol from host on `visible` (log view uses `retainContextWhenHidden: true`; all others must survive disposal).
- Native context menus from webview DOM: `data-vscode-context` JSON attributes + `contributes.menus.webview/context`. Custom HTML menus are forbidden.
- Shared lib `webview-ui/src/lib`: `rpc.ts` (typed client for §8 `Msg`), `VirtualList` (fixed row height, aria row semantics, roving tabindex), `Toolbar`, `FilterChip`, `useVsCodeTheme`.
- Accessibility: every action keyboard-reachable; focus outlines; `aria-live` for async results.

---

## 10. Engineering standards

- **Errors:** all git failures normalize to `GitError`; one `ErrorHandler` maps kinds to UX (e.g. `would-overwrite-checkout` → Smart Checkout modal; `auth` → sign-in flow) with "Show Log" button → OutputChannel "Geet" (`gittree.trace` verbose setting logs full argv + timing, never file contents or secrets).
- **Safety:** destructive ops declare `isDestructive` (checkout-dirty, reset, rebase, drop, stash pop/drop, unshelve-with-remove, rollback, clean, branch -D) → P9 snapshot + confirmation modal listing affected files. Patch application validates target paths stay inside the repo root.
- **Secrets** only in `SecretStorage`; provider tokens least-scope; no PII in logs/telemetry (telemetry is opt-in, respects `telemetry.telemetryLevel`, P10).
- **Lint gates:** `@typescript-eslint/no-floating-promises`, no `any` in `src/shared`, disposables registered into per-feature `DisposableStore`s.
- **Windows first-class** (dev machine is Windows): long paths (`core.longpaths` probe), CRLF (never normalize file content ourselves; diff with repo config), AV file-lock retries, gpg pinentry note, `.cmd` shims. CI matrix: windows/ubuntu/macos × git {2.36, latest}.

---

## 11. Phase plan, dependency graph & parallel lanes

| Phase | File | Delivers | Hard deps |
|---|---|---|---|
| P0 Foundation | [PHASE-00](docs/plan/PHASE-00-foundation.md) | Executor, model, queue, watchers, mode manager, askpass, webview kit, test harness | — |
| P1 Core SCM | [PHASE-01](docs/plan/PHASE-01-core-scm.md) | SourceControl, quick diff + peek actions, file ops, status widget, basic commit/push/pull | P0 |
| P2 Branches | [PHASE-02](docs/plan/PHASE-02-branches.md) | Popup, branch ops, Smart Checkout, compare | P1 |
| P3 Commit lifecycle | [PHASE-03](docs/plan/PHASE-03-commit-lifecycle.md) | Changelists, staging, hunk staging, checks, amend/sign/history | P1 |
| P4 Log, graph, blame | [PHASE-04](docs/plan/PHASE-04-log-graph-blame.md) | Log service, layout lib, log webview, filters, blame | P1 |
| P5 History rewriting | [PHASE-05](docs/plan/PHASE-05-history-rewriting.md) | Interactive rebase, undo/drop/revert/cherry-pick, force-with-lease | P4, P2; **P9-T1/T2 must be merged first** |
| P6 Merge engine | [PHASE-06](docs/plan/PHASE-06-merge-engine.md) | Conflicts view, tri-editor, chevrons, magic wand, lifecycle | P1 |
| P7 Stash & shelve | [PHASE-07](docs/plan/PHASE-07-stash-shelve.md) | Stash GUI, shelf store + UI, unshelve | P1, P6 |
| P8 Providers | [PHASE-08](docs/plan/PHASE-08-provider-integrations.md) | GitHub/GitLab PRs, comments, reviews, timeline | P0 (auth), P1 |
| P9 Local history | [PHASE-09](docs/plan/PHASE-09-local-history.md) | Snapshot store + hooks (T1/T2 **early**, right after P0), restore UX | P0 |
| P10 Hardening | [PHASE-10](docs/plan/PHASE-10-hardening-release.md) | Perf, a11y, onboarding, telemetry, packaging | all |

**Parallel lanes** (independent agent streams after P0):
`A:` P1→P3 (SCM core) · `B:` P2 (branches) · `C:` P0-T9→P4→P5 (webviews) · `D:` P6→P7 (merge/stash) · `E:` P8 (providers) · `F:` P9-T1/T2 immediately, P9-T3/T4 after P4.

---

## 12. Testing strategy

1. **Unit (vitest, pure):** porcelain parsers, `GraphLayout` (golden ASCII-art graph snapshots), magic-wand resolver (fixture triples `test/fixtures/merge/*/{base,ours,theirs,expected}`), `PatchBuilder`, IntelliSort, reflog recency scoring.
2. **Integration (@vscode/test-electron + real git):** `fixtureRepo.ts` scripts temp repos (merge histories, conflicts, unicode paths, CRLF files, detached HEAD, in-progress rebase). Covers: status/commit/checkout flows, smart checkout, `--only` commits incl. intent-to-add, hunk staging round-trips, rebase shim end-to-end, stash/shelve round-trips, snapshot/restore.
3. **Webview component (Playwright against Vite dev server, mocked `acquireVsCodeApi`):** graph rendering, DnD reorder, filter bar.
4. **Smoke e2e:** activation < budget, SCM appears, commit, checkout, log paints on the fixture repo.

---

## 13. Performance budgets (enforced by P10 CI benchmarks)

| Metric | Budget |
|---|---|
| Activation (sync path) | ≤ 100 ms |
| Status refresh p95 @ 10k dirty-capable files | ≤ 400 ms |
| Log first paint @ 100k commits | ≤ 600 ms (first 2 000 rows streamed) |
| Graph scrolling | 60 fps (virtualized; canvas redraw ≤ 8 ms/frame) |
| Blame cold / cached | ≤ 300 ms / ≤ 30 ms |
| Extension-host memory with 100k-commit log session | ≤ 150 MB |

---

## 14. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| `_open.mergeEditor` is internal | Bridge could break on VS Code update | Tri-editor is the default UI; bridge behind capability probe + setting, failure falls back silently |
| Timeline provider API stays proposed | Can't inject into native Timeline | Own Local History views; native file-save history complements |
| Double-SCM confusion | Duplicate gutters/status | ModeManager + consent onboarding; companion mode skips overlapping providers |
| git version variance | Feature breakage (`stash --staged` needs 2.35+, etc.) | `GitCapabilities` probe; per-feature degrade with explanatory tooltip |
| Windows quirks (locks, CRLF, pinentry, long paths) | Flaky ops | Retry/backoff, CI on windows-latest, docs; never rewrite line endings |
| Virtual result doc: some language servers want on-disk files | Degraded IntelliSense in merge center pane | `gittree.merge.resultMode` setting: `virtual` (default) \| `markers` (edit real file in place) |
| Provider rate limits | Stale PR data | GraphQL batching, ETag/conditional requests, poll backoff, manual refresh |
| Huge repos | Slow log/status | `commit-graph write` maintenance, `--no-optional-locks`, offer `core.fsmonitor` enablement prompt, paging everywhere |

---

## 15. Settings & command namespaces

Settings prefix `gittree.` — key groups: `gitPath`, `mode` (takeover/companion), `commit.paradigm`, `commit.checks.{reformat,optimizeImports,analyze,analyzeSeverity,todo,todoPattern,cleanup}`, `commit.sign`, `blame.{heatmap,format}`, `log.{sort,pageSize}`, `merge.{ui,resultMode,autoResolveWhitespace}`, `branches.{recentCount,defaultAction}`, `smartCheckout.behavior`, `autofetch.{enabled,intervalSeconds}`, `shelf.path`, `localHistory.{enabled,maxSizeMb,retentionDays,snapshotOnSave,maxFileSizeKb}`, `github.hosts`, `gitlab.hosts`, `trace`.

Commands prefix `gittree.` grouped by area (`gittree.branches.*`, `gittree.commit.*`, `gittree.log.*`, `gittree.rebase.*`, `gittree.merge.*`, `gittree.stash.*`, `gittree.shelf.*`, `gittree.pr.*`, `gittree.history.*`). The canonical list is each phase file's Contributions section; `package.json` is the source of truth.
