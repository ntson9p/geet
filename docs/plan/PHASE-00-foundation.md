# Phase 0 — Foundation & Infrastructure

**Goal:** Everything later phases build on: git execution, parsing, repository model, operation queue, watchers, coexistence mode, credentials, webview platform, and the test harness. No user-visible Git features yet (a hidden "Geet: Show Repository State" debug command is the only surface).

**Depends on:** nothing. **Blocks:** every other phase.

**Exit criteria:** extension activates on a git workspace in < 100 ms sync path; `RepositoryModel` reflects external CLI changes within 500 ms; unit + integration harness runs in CI on win/linux/mac; webview demo app renders with theme + RPC round-trip.

---

## Tasks

### P0-T1 · Repository scaffold, build system, CI
**Depends:** — · **Complexity:** M
**Output files:** `package.json`, `tsconfig.json`, `eslint.config.mjs`, `esbuild.mjs`, `.vscodeignore`, `.gitattributes` (`* text=auto eol=lf`), `.github/workflows/ci.yml`, `src/extension.ts` (stub), `README.md` (stub).
**Steps:**
1. Manifest: `name: gittree`, engine `^1.96.0`, activation `["workspaceContains:.git", "onStartupFinished"]` (cheap fallback for repos discovered late; actual discovery in T7), `main: ./dist/extension.js`.
2. esbuild bundle (`--platform=node --target=node20 --external:vscode`), watch script, `npm run check` = `tsc --noEmit && eslint . && vitest run`.
3. CI: matrix {windows, ubuntu, macos} × git {2.36 via manual install step, system latest}; jobs: check, integration (`@vscode/test-electron`), package (`vsce package --pre-release`).
4. Scripts must be cross-platform (node-based, no bash-only).
**Accept:** CI green on all matrix cells; `vsce package` produces installable vsix; F5 debug launch works.

### P0-T2 · GitExecutor
**Depends:** T1 · **Complexity:** M
**Output files:** `src/core/git/executor.ts`, `errors.ts`, `capabilities.ts`, unit tests.
**Steps:**
1. Locate git: `gittree.gitPath` setting → user's `git.path` setting → `PATH` → well-known Windows locations (`C:\Program Files\Git\cmd\git.exe`). Probe `git --version`, build `GitCapabilities` (e.g. `stashStaged: >=2.35`, `commitGraph: >=2.24`).
2. `exec`/`stream` per §8 contract. Spawn env: `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0` when `noOptionalLocks`, `LC_ALL=C` **only** for commands we parse structurally, askpass vars (T8). Base args: `-c core.quotepath=false -c color.ui=false`.
3. `stream` frames on NUL or LF (caller picks); backpressure by pausing stdout; cancellation kills process tree (`taskkill /T /F` on win).
4. `classifyStderr()` → `GitError.kind` for: index.lock, `would be overwritten by checkout`, `CONFLICT`, auth prompts/`terminal prompts disabled`, `non-fast-forward`, `no upstream`.
5. Structured trace logging to OutputChannel "Geet" (argv, duration, exit code; never contents/secrets).
**Accept:** unit tests for classification table; integration test runs `git version`, `git status` on fixture; cancellation kills mid-`git log` stream on all OSes.

### P0-T3 · Porcelain parsers
**Depends:** T2 · **Complexity:** M
**Output files:** `src/core/git/parsers/{statusV2,refs,logFormat,blameIncremental,stashList,reflog}.ts` + vitest suites with captured-output fixtures.
**Steps:**
1. `status --porcelain=v2 -z --branch`: entries (ordinary/rename/copy/unmerged incl. stage masks), `# branch.ab +A -B`, detached, upstream gone.
2. `for-each-ref --format` (NUL-joined fields): locals, remotes, tags, HEAD symref, upstream + track info.
3. Log line format constant `%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ct%x00%D%x00%s%x00%b%x1e` (record sep `\x1e`) + parser producing `Commit` DTOs.
4. `blame --incremental` streaming state machine → `{sha, origLine, finalLine, count, author, authorTime, summary, previous}` runs.
5. `stash list --format` and reflog `checkout: moving from X to Y` extraction.
**Accept:** golden-fixture tests incl. unicode paths, renames with `-z`, unmerged stages, `(no branch)` detached, gone upstream.

### P0-T4 · RepositoryModel & state store
**Depends:** T3 · **Complexity:** M
**Output files:** `src/core/model/{repositoryModel,refs,statusEntry,inProgressOp}.ts`.
**Steps:**
1. Immutable snapshot type per master §4; `update(partial)` produces new snapshot, diffs changed sections, fires `onDidChange(sections: Set<'head'|'status'|'refs'|'stashes'|'op'>)`.
2. `inProgressOp` detection from `.git` contents: `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/` (interactive: parse `msgnum`/`end`/`head-name`), `rebase-apply/`, `sequencer/`.
3. `workdirGeneration` counter bumped by workspace watcher; part of cache invalidation keys.
**Accept:** unit tests: section diffing; op detection against fixture `.git` trees (mid-rebase, mid-merge, sequencer multi-pick).

### P0-T5 · OperationQueue
**Depends:** T2, T4 · **Complexity:** M
**Output files:** `src/core/ops/operationQueue.ts` + tests.
**Steps:**
1. Per-repo: single mutation lane (FIFO), reader pool (4). Mutation start cancels+requeues in-flight readers.
2. `index-lock` GitError → retry ×5 exp backoff 50→800 ms + jitter; then surface.
3. `onWillRunDestructive` event (consumed by P9 hooks); self-inflicted watcher-suppression window around mutations (expose `isSelfInflicted(ts)` to T6).
4. Progress adapter: mutations auto-wrap in `window.withProgress({location: SourceControl})`, escalate to notification+Cancel after 2 s.
**Accept:** stress test: 20 interleaved reads + 5 mutations preserve serialization; lock-retry test with artificially held `index.lock`.

### P0-T6 · Watchers & StatusRefresher
**Depends:** T4, T5 · **Complexity:** M
**Output files:** `src/core/watch/{gitDirWatcher,workspaceWatcher}.ts`, `src/core/ops/statusRefresher.ts`.
**Steps:**
1. Resolve real git dir (`.git` file → `gitdir:` indirection for worktrees/submodules). Raw `fs.watch` on the paths listed in master §4; re-arm on rename/atomic-replace (git writes via rename!).
2. Workspace `FileSystemWatcher('**/*')` → bump `workdirGeneration`.
3. Debounce 200 ms, coalesce, skip self-inflicted; run status + for-each-ref + ahead/behind reads via queue; push into model.
**Accept:** integration: external `git commit` / `git checkout -b` via CLI reflected in model < 500 ms; no refresh storm during our own commit (≤ 2 status runs).

### P0-T7 · Repo discovery, activation, ModeManager
**Depends:** T4 · **Complexity:** S
**Output files:** `src/core/modeManager.ts`, `src/core/repoDiscovery.ts`, additions to `extension.ts`.
**Steps:**
1. Discover repos: workspace folders + parent-walk (`git rev-parse --show-toplevel`), `onDidChangeWorkspaceFolders`; handle nested repos (outermost wins unless both open).
2. ModeManager: state machine {unset → prompt-once → takeover|companion}; takeover writes `git.enabled: false` (workspace) **after** modal consent (buttons: "Use Geet" / "Keep both" / "Later"); exposes `mode` + `onDidChangeMode`; persists in `workspaceState`.
3. Debug command `gittree.debug.showState` dumps model JSON to an untitled doc.
**Accept:** multi-root fixture discovers 2 repos; consent flow writes setting only on accept; declining leaves built-in untouched and sets companion.

### P0-T8 · Askpass / credential bridge
**Depends:** T2 · **Complexity:** M
**Output files:** `shims/askpass.cjs`, `shims/askpass.{sh,cmd}`, `src/core/git/askpass/server.ts`.
**Steps:**
1. Named pipe (win: `\\.\pipe\gittree-<nonce>`) / unix socket server with random token; env for every spawn: `GIT_ASKPASS=<launcher>`, `GITTREE_ASKPASS_PIPE`, `GITTREE_ASKPASS_TOKEN`, `ELECTRON_RUN_AS_NODE=1`, `VSCODE_GITTREE_NODE=<process.execPath>`.
2. Shim forwards git's prompt (`Username for…`/`Password for…`) over the pipe; server resolves via `vscode.authentication.getSession('github',…)` for github.com HTTPS remotes, `SecretStorage` lookups, else `window.showInputBox({password})`; caches per session with "remember" option.
3. Optional: mirror env into terminals via `context.environmentVariableCollection` behind setting `gittree.terminalAuth`.
**Accept:** integration (mock pipe client) round-trips username/password; https fetch against a token-protected local fixture remote succeeds without terminal prompt.

### P0-T9 · Webview platform kit
**Depends:** T1 · **Complexity:** M
**Output files:** `webview-ui/` workspace (Vite config, `src/lib/{rpc,VirtualList,Toolbar,useVsCodeTheme,context}.tsx`), `src/ui/webviewHost.ts` (host-side: html factory with CSP nonce, `Msg` router, rehydrate hook), `src/shared/protocol.ts`, demo entry `webview-ui/src/demo/`.
**Steps:**
1. Vite multi-entry → `dist/webviews/<app>/{index.js,index.css}`; host factory injects CSP (`default-src 'none'; script-src 'nonce-…'; style-src …`), codicon font, initial state.
2. Typed RPC client/server over §8 `Msg` (request timeout, re-send-on-rehydrate); `data-vscode-context` helper component.
3. `VirtualList`: fixed row height, windowed render, aria rows, roving tabindex, imperative `scrollToIndex`.
4. Playwright harness with mocked `acquireVsCodeApi` for component tests.
**Accept:** demo webview shows theme-correct UI in light/dark/HC, RPC echo round-trip test, VirtualList renders 100k rows smoothly in Playwright trace.

### P0-T10 · Test harness & fixture repos
**Depends:** T1, T2 · **Complexity:** M
**Output files:** `test/fixtures/fixtureRepo.ts`, `test/integration/setup.ts`, sample suites.
**Steps:**
1. `FixtureRepo` builder API: `commit(files)`, `branch`, `merge --no-ff`, `conflictPair()`, `detach()`, `startRebase()`, CRLF/unicode/rename cases; builds into scratch temp dir; disposes reliably on Windows (retry unlink).
2. Canned histories: `linear(200)`, `branchy(2k, merges)`, `conflict-basic`, `mid-rebase`.
3. Wire `@vscode/test-electron` runner: open fixture as workspace, activate, expose `getCore()` test hook (`gittree.debug` export gated to test env).
**Accept:** sample integration test (activate → model has HEAD) green on CI matrix.

---

## Contributions added this phase
`gittree.debug.showState` command (hidden from palette via `when: config.gittree.trace`), OutputChannel "Geet". Nothing else user-visible.

## Parity checklist
- [x] Infrastructure only — no FEATURES.md items land here, but §4 master invariants (queue, watcher, suppression, retry) all demonstrably work. (Queue serialization + lock retry: `test/unit/core/ops/operationQueue.test.ts`; watcher → refresher → model incl. suppression: `test/unit/core/ops/statusRefresher.test.ts` + `test/integration/suite/watchRefresh.test.ts`.)

## Deviations
- **P0-T1:** a minimal integration bootstrap (`test/integration/runTests.ts`, `suite/index.ts`, one activation test) lands in T1 rather than T10 so the CI `integration` job specified in T1 step 3 is actually runnable; T10 replaces the ad-hoc scratch workspace with the `FixtureRepo` builder. Also added `LICENSE` (manifest declares MIT; keeps `vsce package` non-interactive), `.gitignore`, and `.vscode/{launch,tasks}.json` (T1 acceptance requires F5 debug launch). The test runner scrubs an inherited `ELECTRON_RUN_AS_NODE` from its env — otherwise the downloaded VS Code starts as plain Node when tests are launched from a terminal inside VS Code/Electron.
- **P0-T1 (CI verification):** the repo has no GitHub remote in this environment, so "CI green on all matrix cells" cannot be executed here; the three jobs' local equivalents (`npm run check`, `npm run test:integration` on Windows, `npm run package`) all pass. The workflow file follows the specified matrix and needs a first push to validate.
