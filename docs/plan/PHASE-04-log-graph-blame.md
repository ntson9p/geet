# Phase 4 — Git Log, Graph & Blame

**Goal:** FEATURES.md §4 (graph view, IntelliSort, filter engine) and §1.2 (gutter blame with heat map and click-through). Delivers the bottom-panel "Git" tool window and the reusable commit-details machinery later phases hook into.

**Depends on:** P1; P0-T9 webview kit.
**Exit criteria:** 100k-commit repo paints < 600 ms, filters intersect correctly, blame toggles from the gutter right-click and clicking an annotation reveals the commit in the log.

---

## Tasks

### P4-T1 · LogService (streaming pager + filters + details)
**Depends:** P0-T2/T3 · **Complexity:** M
**Output files:** `src/log/logService.ts`, `src/log/logFilter.ts` + unit tests for arg building.
**Steps:**
1. `LogFilter` = `{refs?: string[]|'ALL'|'HEAD', authors?: string[], dateRange?: {from?, to?}, paths?: string[], text?: {q, regex, matchCase}, sort: 'topo'|'date'|'intelli'}` → canonical cache key + git args (`--topo-order`/`--date-order`, `--author` repeated, `--since/--until`, `--grep [-i] [-E --perl-regexp? no: -E]`, `--all`/refs, `-- <paths>`).
2. Streamed pages: `git log <args> --format=<P0-T3 constant> -z --parents --skip=<n> --max-count=2000`; emit rows in ~500-row chunks (yield to event loop); LRU(20) page cache keyed `(filterKey, page, headSha)`.
3. Ref decorations map from RefService (branch/tag/HEAD chips per sha, remote dedupe).
4. `getCommitDetails(sha)`: metadata + `git show --name-status -z --format=… <sha>` file list (rename-aware) + body; `getFileDiff(sha, path)` → `gittree-rev:` pair for `vscode.diff`.
5. Maintenance: after fetch/commit bursts, run `git commit-graph write --reachable --changed-paths` (background, capability-gated, throttled daily).
6. Author autocomplete source: `git log --all --format='%aN <%aE>' --use-mailmap` streamed into a dedupe set (cap 100k lines), cached until HEAD changes.
**Accept:** unit: filter→args table incl. intersections; integration: page 0 of `branchy(2k)` fixture < 150 ms warm; details for a rename commit show `R100` pair.

### P4-T2 · GraphLayout engine (pure lib)
**Depends:** T1 (DTO shapes only) · **Complexity:** L
**Output files:** `src/log/graphLayout/{layout.ts,intelliSort.ts,colors.ts}` + extensive vitest with **golden ASCII renderings**.
**Steps:**
1. Input: ordered commits + parent shas (streaming-friendly: `appendPage(commits)` carries lane state across pages). Output per row: `{nodeLane, lanes: LaneSegment[], edges: {from,to,kind:'pass'|'branch'|'merge'}[], colorIdx}`.
2. Lane assignment: classic active-lanes algorithm — node takes its reserved lane (or leftmost free); first parent inherits the lane; extra parents reserve/join lanes; free lanes compacted lazily to keep width stable. Color = stable per lane-birth (palette of 12, theme-aware on the render side).
3. **IntelliSort** (`sort: 'intelli'`): topological re-order emitting each merge's second-parent chain contiguously immediately below the merge until the merge-base, then resuming first-parent — produces IntelliJ's "branch blocks read linearly" effect. Implement as ordering pass over a page window with spill handling (chain crossing a page boundary defers to next page); feature-flagged, falls back to `--topo-order` server-side ordering.
4. ASCII snapshot renderer (`test only`): draws `*`, `|`, `\`, `/` grid — golden files make regressions reviewable by agents.
**Accept:** goldens for: linear, single merge, octopus (3 parents), criss-cross, orphan root mid-stream, page-boundary lane carry; IntelliSort golden shows contiguous branch block; layout of 100k synthetic commits < 400 ms.

### P4-T3 · Log webview (panel tool window)
**Depends:** T1, T2, P0-T9 · **Complexity:** L
**Output files:** `src/log/logView.ts` (host), `webview-ui/src/log/**` (React), contributions: panel container `gittree-panel` ("Git"), webview view `gittree.log`.
**Steps:**
1. Layout: filter bar (T4) · main split = graph+rows (left) / details panel (right, resizable, collapsible). `retainContextWhenHidden: true` (the one allowed instance).
2. Rows in `VirtualList` (fixed height): graph cells drawn on a per-viewport `<canvas>` layer (redraw on scroll frame, ≤ 8 ms), DOM text for subject/author/date/sha + ref chips (branch=blue, tag=yellow, HEAD outline — theme vars only).
3. Infinite scroll: near-end sentinel requests next page over RPC; loading skeleton rows; "Load more" fallback button for a11y.
4. Selection model: single + range/ctrl multi (multi feeds P5); `data-vscode-context='{"webviewSection":"commit","sha":…,"shas":[…],"preventDefaultContextMenuItems":true}'` per row → **native** context menu (`menus.webview/context`), entries filled by T5/P5.
5. Details panel: commit metadata (author/committer/date, full sha copy button, refs), body, changed-file tree (folder rollup toggle); file click → RPC → host opens `vscode.diff`; "Show all in multi-diff" action.
6. Host API for other phases: `revealCommit(sha, {select})` (used by blame click-through, P8 PR commits), `setFilter(filter)` (used by P2-T5 upgrade); state (`filter`, scroll sha) persisted via `setState` + host rehydrate.
7. Keyboard: full roving-tabindex rows, `enter` opens details, `ctrl+c` copies sha, menu key opens context menu.
**Accept:** Playwright: 100k-row fixture stream scrolls 60 fps (trace-asserted), selection + context data correct; integration: `revealCommit` scrolls & selects; reload restores filter+position.

### P4-T4 · Filter bar
**Depends:** T3 · **Complexity:** M
**Output files:** `webview-ui/src/log/FilterBar.tsx`, host pickers in `src/log/logView.ts`.
**Steps:**
1. Chips (IntelliJ order): **Branch** (host QuickPick multi over refs + "All"/"HEAD" presets), **User** (QuickPick with T1 autocomplete, "me" preset from `user.email`), **Date** (presets today/yesterday/week/month + custom range via two InputBoxes with date validation), **Path** (workspace folder/file picker + manual glob input), plus free-text search box (`--grep`) with regex/match-case toggles rendered in-webview.
2. Chips show active value and clear with `×`; all filters intersect (single `LogFilter`); "reset all".
3. Sort selector: Date / Topo / IntelliSort (persists per repo).
**Accept:** each chip round-trips to correct git args (unit) and updates the graph (Playwright); intersected filter (author+path+date) matches `git log` CLI output on fixture.

### P4-T5 · Commit actions & navigation wiring
**Depends:** T3 · **Complexity:** S
**Output files:** `src/log/commitActions.ts`, menu contributions.
**Steps:**
1. `webview/context` menu (single-select): Copy Revision Number, Create Branch from Here…, Create Tag…, Checkout Revision (detached warning), Reset Current Branch to Here… (soft/mixed/hard picker; hard = destructive-flagged), Compare with Local (T1 details vs worktree multi-diff), Open in Browser (remote URL builders github/gitlab patterns, capability-hidden otherwise).
2. Multi-select entries reserved with `when` clauses for P5 (`gittree:rewriteReady`) — placeholder group so P5 only adds commands, not layout churn.
3. Upgrade P2-T5: `gittree.branches.compareWithCurrent` now calls `setFilter({refs: [sel, current], …})` + a two-dot range view: implement range mode `A...B` in LogFilter (left-right badges on rows).
**Accept:** every action runs against fixture (reset hard prompts + snapshots); compare-with-current opens filtered log with side badges.

### P4-T6 · BlameService
**Depends:** P0-T2/T3 · **Complexity:** M
**Output files:** `src/log/blame/blameService.ts` + tests.
**Steps:**
1. `blameFile(uri, docVersion)`: dirty documents blame via `git blame --incremental --porcelain --contents -` (buffer piped to stdin) so annotations are correct without saving; clean docs use plain path invocation.
2. Streamed run assembly → per-line `{sha, author, authorTime, summary, isUncommitted}` (uncommitted lines from `--contents` pseudo-commit → labeled "Uncommitted"); cache `(uri, docVersion)`; prefetch on editor activation when blame is toggled on.
3. `getCommitForLine(uri, line)` helper for hover/status-bar/click-through.
**Accept:** integration: blame of dirty buffer maps edited lines to "Uncommitted", unchanged lines to real shas; 5k-line file cold < 300 ms warm < 30 ms (fixture-benchmarked).

### P4-T7 · Blame UI (gutter column, heat map, click-through)
**Depends:** T6, T3 (`revealCommit`) · **Complexity:** L
**Output files:** `src/log/blame/blameUi.ts`.
**Steps:**
1. Toggle `gittree.blame.toggle` contributed to `menus.editor/lineNumber/context` ("Annotate with Git Blame" — gutter right-click parity) + palette + editor title overflow. Per-document toggle set; `setContext('gittree.blameOn', …)` flips the menu label to "Close Annotations".
2. Gutter column: one `TextEditorDecorationType` per (age-bucket × theme-kind), `before` render options: fixed-width (`ch`-sized, `gittree.blame.format` default `${author|12} ${date|relative} ${sha|7}`), monospace, subtle border-right. Every line carries its own label, with consecutive lines from one commit sharing a background band (`gittree.blame.bandBackground` / `gittree.blame.bandAlternateBackground`) so adjacent groups are told apart — this is the IntelliJ look. (Until POST-P14g this step read "identical consecutive shas render text only on first line of the run (IntelliJ look)", which IntelliJ does not do: it repeats the annotation and bands the groups. The blanked lines that shipped were a faithful build of a wrong sentence.)
3. **Heat map:** bucket = decile of commit time across the file's blame span; alpha ramp on foreground (+ optional background tint setting); "Uncommitted" bucket brightest.
4. Interactivity: hover (registered HoverProvider active while blame on) shows commit card markdown — author, date, subject, body preview + trusted command links **[Show in Log]**(`command:gittree.log.revealCommit?["<sha>"]`), [Copy sha], [Show Diff]; cursor-line status-bar item `$(git-commit) author, 3d ago · subject` whose click also reveals in log (covers "click annotation" parity since decorations aren't natively clickable).
5. Recompute on `onDidChangeTextDocument` (debounced 300 ms, versioned cache), theme-change listener rebuilds types; large-file guard (> 20k lines → confirm).
**Accept:** manual matrix + integration: toggle from gutter menu on/off; hover links reveal commit in log panel; heat map visibly ramps on a fixture with old+new commits; no decoration bleed on edit (versioned invalidation test).

### P4-T8 · File History view
**Depends:** T1, T3 · **Complexity:** S
**Output files:** `src/log/fileHistory.ts`.
**Steps:** `gittree.showFileHistory` (editor title context + explorer context): opens log panel in path mode with `--follow` (single-path capability), row click → diff `parent↔sha` for that path; "Open revision" action. Renames chain visualized with a chip on the boundary row.
**Accept:** history of a renamed fixture file crosses the rename with correct old-path diffs.

---

## Contributions added this phase
Panel container `gittree-panel` with webview view `gittree.log`; commands `gittree.log.{refresh,revealCommit,copySha,createBranchHere,createTagHere,checkoutRevision,resetHere,compareWithLocal,openOnRemote,setFilter}`, `gittree.blame.toggle`, `gittree.showFileHistory`; `editor/lineNumber/context`, `webview/context`, `editor/title/context`, `explorer/context` menu entries.

## Parity checklist (FEATURES.md §4 + §1.2)
- [x] Color-coded topological graph, virtualized and fast (canvas layer over VirtualList; 100k layout < 400 ms measured; windowed DOM verified in Playwright)
- [x] Sort modes: Date, Topo, IntelliSort (contiguous merged-branch blocks — golden-tested DFS reorder)
- [x] Intersecting filters: Branch, User (autocomplete + "me"), Date (presets + validated custom range), Path (picker + glob)
- [x] Free-text message search (literal/regex, match-case)
- [x] Commit context menu with branch/tag/checkout/reset/compare/open-on-remote actions via native webview/context menus (multi-select rewrite entries reserved for P5)
- [x] Toggleable gutter blame from gutter right-click (`editor/lineNumber/context`)
- [x] Per-line author + date + hash column (configurable format, run-collapsed like IntelliJ)
- [x] Age heat-map fading (decile buckets, uncommitted brightest, theme-rebuilt)
- [x] Blame click-through opens the commit in the log tool window (hover command links + cursor status-bar item → revealCommit)

## Deviations
- **P4-T3:** "60 fps trace-asserted" is realized as Playwright assertions that the DOM stays windowed (< 80 rows) across 100k-row scrolling plus the unit-level 100k-commit layout benchmark — headless traces don't expose a direct fps counter.
- **P4-T3:** webview CSP allows `script-src ${cspSource}` alongside the nonce — vite emits shared module chunks whose imports can't carry the entry nonce; the origin only serves `localResourceRoots`.
- **P4-T5:** "Open in Browser" builds github/gitlab commit URLs and reports unknown hosts instead of hiding (capability data for other hosts arrives with P8 providers).
- **Race fix (product):** stream-based queue reads (log pages, authors, blame) now THROW on cancellation — `stream()` resolves with partial output when cancelled, which the OperationQueue treated as success and cached truncated results when a mutation interrupted a read.
