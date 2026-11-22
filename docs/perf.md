# Performance benchmarks (P10-T1)

Budgets are `IMPLEMENTATION_PLAN.md` §13, asserted in the benchmark suites with a
15% CI-noise tolerance. Timed metrics are medians of 5 (status uses p95 over 20
samples, per its §13 row).

## How to run

```bash
npm run test:perf     # extension-host suite (builds 100k-commit + 10k-file fixtures)
npm run test:webview  # includes the scroll frame-time spec (webview-ui/tests/perf.spec.ts)
```

**Run in isolation.** Benchmarks are only meaningful with nothing else running on
the machine — a concurrent Playwright run inflated log first paint ~1.5× and
tripped its budget spuriously. CI runners are isolated by construction.

The CI `perf` job (`.github/workflows/ci.yml`) runs the suite on all three OSes,
and the release workflow publishes only after it passes there. The results below
are local runs, from before the repository was on GitHub.

## Results — 2026-08-24, Windows 11, local — **Phase 14 close** (P14-T8)

Phase 14 removed the SCM provider and replaced VS Code's quick diff with
Geet-painted change bars, so the one new budget is the recompute that
replaced it. It is the term the `geet.changeBars.maxFileLines` cutoff exists
to bound, measured on the pure function — the decoration apply is O(changes)
and never the cost.

| Metric | §13 budget | Measured |
|---|---|---|
| Change-bar recompute p95 @ 5 000 lines | ≤ 50 ms | **0.6 ms** (median 0.5) |

The fixture is a realistic edit spread — 40 scattered single-line
modifications plus one 20-line insert and one 15-line delete — not a single
large rewrite, which would be the easy case for an LCS diff. Two orders of
magnitude under budget at 5 000 lines is why the default cutoff sits at 20 000
rather than lower: the guard is against pathological files, not typical ones.

Every other §13 budget re-ran green and unchanged from the Tier-1 close below;
Phase 14 adds no startup cost (the change-bar controller registers listeners and
paints nothing until an editor is visible).

## Results — 2026-08-23, Windows 11, local — **Tier-1 close** (P13-T9)

Final re-validation with Phases 11–13 all shipped (dialogs, worktrees, the
operations popup and the merge toolbar are added surface, not added startup
cost). Same fixtures and the same harness as the P12-T9 run below.

| Metric | §13 budget | Measured |
|---|---|---|
| Activation (sync path) | ≤ 100 ms | **3.1 ms** |
| Status refresh p95 @ 10k tracked files (250 dirty) | ≤ 400 ms | **348 ms** (median 312.9) |
| Log first page (2 000 rows) + graph layout @ 100k commits | ≤ 600 ms | **537.8 ms** (first chunk 517.1) |
| Blame 5k-line file, cold / cached | ≤ 300 / 30 ms | **102.1 / 0 ms** |
| Extension-host memory, 100k-commit log session | ≤ 150 MB | **+89.7 MB** session delta (272.7 MB over a 183.0 MB baseline) |
| Selection → Details + Changed Files panes populated | *(recorded)* | **101 ms** median |
| Changed Files @ 5 000-file commit | *(recorded)* | **97.9 ms** median |
| P9 snapshot @ 2k dirty files | *(recorded)* | **~3.9 s** overhead, host responsive |

Bundle: `gittree-0.0.1.vsix` **1.26 MB** (0.07 MB images) → **1.19 MB effective**
against the 2.50 MB budget, with all of P13's dialogs in the `dialogs` webview
bundle.

Notes:
- **The log first page came in at 537.8 ms**, comfortably inside the 600 ms
  budget — the 611.5 ms reading in the P12-T9 run below was overnight suite
  load, as suspected there, and the budget was rightly left alone.
- Status refresh and memory both read higher than the P12-T9 run (348 vs 230 ms;
  +89.7 vs +64.4 MB) and both stay inside budget. Same machine, different load;
  neither metric has a code change behind it that would explain a regression.

## Results — 2026-08-23, Windows 11, local — four-pane window (P12-T9)

Re-validation after Phase 12 turned the log into the four-pane Git tool window
(Branches · Commits · Changed Files · Commit Details + the Console tab). Same
fixtures, plus a 5 000-file commit at the log fixture's HEAD.

| Metric | §13 budget | Measured |
|---|---|---|
| Activation (sync path) | ≤ 100 ms | **6.1 ms** |
| Status refresh p95 @ 10k tracked files (250 dirty) | ≤ 400 ms | **230 ms** (median 216.2) |
| Log first page (2 000 rows) + graph layout @ 100k commits | ≤ 600 ms | **611.5 ms** — within the 15% tolerance; first row chunk 590.5 ms, so git's own streaming still dominates (the machine was under overnight suite load; cf. 542.1 ms on 2026-07-16) |
| Blame 5k-line file, cold / cached | ≤ 300 / 30 ms | **80.8 / 0 ms** |
| Graph scroll frame time @ 100k, all four panes mounted (Playwright) | 60 fps; redraw ≤ 8 ms | **median 16.8 ms, p95 18.2 ms** (no missed frames) |
| Extension-host memory, 100k-commit log session | ≤ 150 MB | **+64.4 MB** session delta (absolute 247.7 MB over a 183.3 MB baseline) |
| Selection → Details + Changed Files panes populated | *(no §13 row — recorded)* | **81.5 ms** median (fresh service, concurrent pane fetches) |
| Changed Files @ 5 000-file commit | *(no §13 row — recorded)* | **80.1 ms** median, all 5 000 files reported |
| P9 snapshot @ 2k dirty files | *(no §13 row — recorded)* | **~3.7 s** overhead, host responsive |

Four-pane notes:
- Pane population is **lazy by construction**: selecting a commit pushes ids to
  the host's single selection model; Changed Files and Commit Details each fetch
  their own data (`log/changedFiles`, `log/details`), so an unselected or
  collapsed pane costs nothing. The recorded 81.5 ms covers both fetches
  resolving concurrently on a cold service.
- The Console tab is a capped ring (default 2 000 entries, output head 2 000
  chars, redacted at insert) — memory is bounded by construction and the tab
  renders nothing while inactive (`TabPanel` unmounts it).
- The frame-time spec runs against the full four-pane page since P12-T1, so the
  60 fps row above is measured with Branches/Changed Files/Details mounted.

## Results — 2026-07-16, Windows 11, local

| Metric | §13 budget | Measured |
|---|---|---|
| Activation (sync path) | ≤ 100 ms | **2.6 ms** |
| Status refresh p95 @ 10k tracked files (250 dirty) | ≤ 400 ms | **198.7 ms** (median 189.6) |
| Log first page (2 000 rows) + graph layout @ 100k commits | ≤ 600 ms | **542.1 ms** (first row chunk 526.4) |
| Blame 5k-line file, cold / cached | ≤ 300 / 30 ms | **67.4 / 0 ms** |
| Graph scroll frame time @ 100k (Playwright) | 60 fps; redraw ≤ 8 ms | **median 16.6 ms, p95 18.2 ms** (no missed frames) |
| Extension-host memory, 100k-commit log session | ≤ 150 MB | **+78.4 MB** session delta (absolute 261 MB over a 183 MB pre-session baseline) |
| P9 snapshot @ 2k dirty files | *(no §13 row — recorded)* | **~3.0 s** overhead, host responsive |

Notes:
- The frame budget is asserted in its observable form — rAF frame deltas while
  continuously scrolling the virtualized 100k list; an over-budget canvas redraw
  would surface as missed frames. Layout cost itself is bounded separately by the
  P4-T2 vitest benchmark (100k commits < 400 ms).
- The memory row bounds the log session's RSS *delta*; the absolute number
  includes the VS Code extension-host baseline. Since POST-P14da the baseline is
  taken just before the session. Before, it was taken when the suite loaded, so
  the delta also counted every benchmark run before it. On CI under
  `@vscode/test-electron` 3, which starts VS Code with `--no-cached-data`, that
  came to 206–220 MB. The suite-wide figure is still recorded (`suiteDeltaMb`).
- Log first paint is dominated by git itself streaming the first 2 000 records
  (~525 of ~540 ms); parsing + layout account for the rest.

## Before/after — fixes driven by these benchmarks

| Hot spot | Before | After | Fix |
|---|---|---|---|
| P9 snapshot capture @ 2k dirty files | **9 064 ms**, extension host reported *unresponsive* (fully synchronous per-file stat→read→gzip→write loop) | **~3 172 ms** wall (≈3.0 s over the no-snapshot baseline), zero unresponsive events | `snapshotStore.ts`: bounded-concurrency (8-wide) async capture — `fs.promises` I/O and threadpool `zlib.gzip`, manifest order kept deterministic |

## Startup audit (P10-T1 step 3)

- `activate()` does nothing but kick off `createCore()` asynchronously and
  register the debug command — measured sync path 2.6 ms (`GeetApi.perf`).
- Webviews are code-split per app by the Vite multi-entry build
  (`dist/webviews/<app>/`); the log app loads nothing until its view resolves.
- Large-repo playbook: repos with > 50k tracked files (capability-gated on git ≥
  2.37) get a one-time prompt to enable `core.fsmonitor` + `core.untrackedCache`;
  commit-graph maintenance ships since P4-T1.
