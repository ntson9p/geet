# Phase 12 — The Git Tool Window (Tier 1)

**Goal:** close gap-analysis **S2, S10** and §3.4/§3.8/§3.9 — turn the single-pane log webview
into IntelliJ's Git tool window: `Log | Console` tabs, four synchronized panes (Branches ·
Commits · Changed Files · Commit Details) with per-pane toolbars, the full filter row, the
complete commit context menu, and the patch engine those menu items need.
Target shape is `docs/intellij-gap-analysis.md` §2A ("Git tool window", "Right-click menu on a
commit").

**Depends on:** P11-T1 (UI kit: `treeModel`, `FileTree`, `Tabs`, `SplitPane`, `Menu`,
`ToolbarStrip`), P4 (log/graph/blame), P5 (history rewriting).
**Exit criteria:** selecting a commit in the graph updates Changed Files and Commit Details in
the same window; the Branches pane filters the graph; every item in the reference context menu
either works or is registered as a deviation; the §13 graph budgets still hold with four panes
mounted.

---

## Tasks

### P12-T1 · Tool-window shell (tabs + 4-pane layout)
**Depends:** P11-T1 · **Complexity:** M
**Output files:** `webview-ui/src/log/{App.tsx,Shell.tsx,log.css}` (restructured), `src/log/logView.ts`.
**Steps:**
1. `Tabs`: `Log | Console`. Tab selection persisted in webview state; `gittree.log.focus`
   (`alt+9`) focuses the window and the last active tab.
2. Log tab layout via nested `SplitPane`: `[Branches | Commits] | [Changed Files / Commit Details]`
   — a vertical split for the right column, matching §2A. Every ratio persisted; double-click a
   splitter resets to defaults.
3. Each pane gets its own header/toolbar row, so pane actions stop competing for the single
   `view/title` strip. Panes are individually collapsible.
4. Selection is one host-side model (`selectedCommits: string[]`) pushed to all panes, so
   multi-select drives "Compare", "Squash", "Push all up to here" consistently.
5. Preserve the existing keyboard entry points and add `Tab`/`Shift+Tab` pane cycling with a
   visible focus ring on the pane header (P10-T2 a11y rules apply).
**Accept:** integration — layout restores exactly across reload; collapsing a pane does not
lose its state; keyboard reaches all four panes; screen-reader announces pane names.

### P12-T2 · Branches pane + vertical icon rail
**Depends:** T1, P2 · **Complexity:** M
**Output files:** `webview-ui/src/log/BranchesPane.tsx`, `src/log/branchesPaneBridge.ts`.
**Steps:**
1. Tree: `HEAD (Current)` → `Local` (with **folder nodes** from `treeModel`, so `feature/f1`,
   `feature/f1-1`, `feature/f2` collapse under `feature`) → `Remote` per remote → `Tags`.
   Favorites (★) sort first. Reuses `FileTree`'s row primitives, not a second tree impl.
2. Vertical icon rail on the pane's left edge per §2A: `+` new branch, `−` delete,
   `<>` compare with current, `Q` filter/search, `★` favorites-only, `@` show my commits,
   `>` collapse rail. Each is an `aria-label`ed button, not a bare glyph.
3. Selecting one or more refs **filters the Commits pane** to those refs (`git log <ref>…`);
   `HEAD (Current)` restores the default. Selection is additive with `Ctrl`.
4. Per-row context menu shares one action registry with the branches popup (P13-T5) so the two
   surfaces can never drift.
**Accept:** integration — selecting `feature/f1` filters the graph to that ref's commits;
folder collapsing matches the reference layout; every rail button has an accessible name;
context-menu items dispatch the same commands as the popup.

### P12-T3 · Changed Files pane
**Depends:** T1 · **Complexity:** M
**Output files:** `webview-ui/src/log/ChangedFilesPane.tsx`.
**Steps:**
1. `FileTree` over the selected commit's `git show --name-status`, with repo → folder → file
   nodes, `N files` counts on every node, and the repo row showing its path as a dim suffix
   (matching §2A's `demo-git  1 file  demo-git`).
2. Pane toolbar: expand all, collapse all, group-by (tree / flat / by-module), show diff
   preview, `Show History for Revision`.
3. Multi-commit selection shows the aggregate change set (`git diff A^..B --name-status`),
   which is how "Compare Versions" reads in IntelliJ.
4. Click opens the commit-scoped diff (existing `gittree-rev:` content provider).
**Accept:** integration — counts and statuses match `git show --name-status` for a merge
commit, a rename, and a 500-file commit; aggregate mode matches `git diff` for a 3-commit
selection; virtualized rendering holds the §13 budget.

### P12-T4 · Commit Details pane
**Depends:** T1 · **Complexity:** S
**Output files:** `webview-ui/src/log/DetailsPanel.tsx` (rewritten).
**Steps:**
1. Layout per §2A: subject line → `<hash> <author>` → `<email> on <date> at <time>` →
   ref chips (`HEAD`, branch, tag, with the P10-T2 palette).
2. Add what the current panel lacks: committer line when it differs from author, GPG
   signature state, parent links (clickable, feeding `Go to Parent Commit`), and
   `Contained in branches: … Show all` (lazy `git branch --contains`, because it is slow on
   large repos — fetch on click, never on selection).
3. Full commit body with URL and issue-key linkification (issue pattern from settings).
4. `Copy Revision Number`, `Copy Subject`, and body text selection must all work inside the pane.
**Accept:** integration — signature state renders for a signed commit; `--contains` is not
invoked until the link is clicked (asserted via the executor trace); parent link moves the
graph selection.

### P12-T5 · Filter row and toolbar parity
**Depends:** T1 · **Complexity:** M
**Output files:** `webview-ui/src/log/FilterBar.tsx` (rewritten).
**Steps:**
1. Row per §2A: `Branch or tag` combo · `Text or hash` field with `.*` (regex) and `Cc`
   (match-case) toggles · `Branch ▾` `User ▾` `Date ▾` `Paths ▾` dropdowns.
2. Turn the existing filter chips into real **multi-select dropdowns** with search: `Branch`
   (refs, favorites first), `User` (from `git shortlog -sne`, plus "me"), `Date` (presets +
   custom range), `Paths` (picker + free text, multiple).
3. Right-side toolbar icons: refresh, `Go to Hash/Branch/Tag`, `Show Details` toggle,
   `Highlight my commits`, `Collapse linear branches`, `Show long edges`, and preset
   save/restore (`Saved filters ▾`) — IntelliJ persists filter sets and GitTree does not.
4. All filters compose into a single `logFilter.ts` argv build; every filter is reflected in the
   URL-ish view state so reload restores the exact query.
**Accept:** unit — argv assembly for each filter and every combination of regex/match-case;
integration — a saved filter preset restores after reload; `Paths` with two paths matches
`git log -- a b`.

### P12-T6 · Patch engine — Create Patch / Apply Patch
**Depends:** P1-T3 · **Complexity:** M
**Output files:** `src/rewrite/patch/{createPatch.ts,applyPatch.ts}` + unit tests.
**Steps:**
1. §3.9 is currently **entirely absent** — no `format-patch` or `am` anywhere in `src/`.
   `createPatch(range | commits | inclusionSet)` → `git format-patch --stdout` for commits, or
   `buildPatch` for a working-tree selection; writes to a chosen file or the clipboard.
2. `applyPatch(file)` → `git apply --3way` with `git am` for mailbox-format patches
   (detected by `From ` header), reporting rejected hunks as a file list.
3. Both are surfaced by the commit context menu (T7) and the Apply Patch dialog (P13-T4).
4. Reuse `patchParser.splitPatchFiles` for the pre-apply summary (files + hunk counts) so the
   dialog can show what a patch will touch before applying it.
**Accept:** integration — round-trip: create a patch from 2 commits, reset hard, apply, and
assert identical tree hashes; a deliberately conflicting patch reports the rejected files
without leaving `.rej` litter unaccounted for; binary-content patch round-trips byte-exactly.

### P12-T7 · Commit context menu completion
**Depends:** T4, T6 · **Complexity:** M
**Output files:** `src/log/commitActions.ts` (extended), `src/core/vdocs/revTreeFs.ts`.
**Steps:**
1. Add the items the reference menu has and GitTree lacks:
   `Create Patch…` (T6) · `Fixup` · `Squash Into` · `Push All up to Here` ·
   `Branches ›` submenu · `Go to Parent Commit` / `Go to Child Commit` ·
   `Show Repository at Revision`.
2. `Fixup` / `Squash Into` — commit the current inclusion set with `--fixup=<sha>` /
   `--squash=<sha>`, then offer `rebase --autosquash` onto that commit's parent. Refuse with a
   clear reason when the target is not an ancestor of `HEAD`.
3. `Push All up to Here` — `git push <remote> <sha>:refs/heads/<branch>`, with the
   non-fast-forward and "not on current branch" cases handled before invoking.
4. `Branches ›` — branches/tags containing the commit (lazy `--contains`), each with checkout /
   new-branch-from / compare.
5. `Show Repository at Revision` — a **new `FileSystemProvider`** on scheme `gittree-tree:`
   (the existing `gittree-rev:` is a `TextDocumentContentProvider` and can only serve single
   files, so it cannot back a browsable tree). Read-only `stat`/`readDirectory`/`readFile` over
   `git ls-tree` + `git cat-file`, surfaced as a dedicated tree view rather than a workspace
   folder mutation.
6. Also add `Reset → Keep` — `commitActions.ts` currently offers Soft/Mixed/Hard only.
**Accept:** integration per item — fixup+autosquash produces the expected linear history;
`Push All up to Here` pushes exactly through the selected commit; `gittree-tree:` opens a file
from a 3-commits-ago revision read-only; `Reset Keep` refuses when it would discard local
changes, matching `git reset --keep` semantics.

### P12-T8 · Console tab
**Depends:** T1 · **Complexity:** S
**Output files:** `webview-ui/src/log/ConsolePane.tsx`, `src/core/git/commandLog.ts`.
**Steps:**
1. Ring buffer (2 000 entries) fed from the executor's trace hook: timestamp, `git` argv,
   exit code, duration, and stderr/stdout head. The `GitTree` output channel stays as-is;
   this is a structured mirror, not a replacement.
2. Rendering: one collapsible entry per command, failures pre-expanded and colored,
   filter box, `Copy command`, `Copy output`, `Clear`.
3. Redaction is mandatory: the askpass token, URL userinfo, and any `--author` email pass
   through the existing scrubber before entering the buffer.
4. Read-only — no re-run affordance. Deliberate: re-running arbitrary logged mutations from a
   log pane is a footgun.
**Accept:** unit — redaction of a tokenized remote URL and an askpass handshake; integration —
a failing `git` command appears expanded with its exit code; buffer caps at 2 000 without
unbounded memory growth.

### P12-T9 · Perf re-validation and docs
**Depends:** T1–T8 · **Complexity:** S
**Output files:** `test/perf/*`, `docs/perf.md`, `FEATURES.md` §4, `docs/deviations.md`.
**Steps:**
1. Re-run the §13 budgets with four panes mounted: 100k-commit graph scroll, first paint,
   commit-selection → both right panes populated, and the 5 000-file Changed Files case.
   Pane population must be lazy — selection pushes ids, panes fetch their own data.
2. Rewrite `FEATURES.md` §4 with shape criteria drawn from §2A.
3. `docs/perf.md` gains a "four-pane log" section; large-repo playbook updated.
**Accept:** `test:perf` green against the recorded budgets; no budget regressed by more than
the documented tolerance; bundle budget met.

---

## Contributions added this phase
Commands `gittree.log.createPatch`, `gittree.log.fixup`, `gittree.log.squashInto`,
`gittree.log.pushAllUpToHere`, `gittree.log.goToParent`, `gittree.log.goToChild`,
`gittree.log.showRepoAtRevision`, `gittree.log.resetKeep`, `gittree.log.saveFilterPreset`,
`gittree.log.console.clear`, `gittree.patch.apply`. View `gittree.revTree`
(`when: gittree.revTree.active`). FileSystemProvider scheme `gittree-tree`.
Settings `gittree.log.panes.*`, `gittree.log.filterPresets`, `gittree.log.console.limit`.

## Parity checklist (gap-analysis S2, S10 · §3.4, §3.8, §3.9 · FEATURES.md §4)
- [ ] S2 — four synchronized panes with per-pane toolbars in one bottom-docked window
- [ ] S2b — Branches pane with folder nodes and the vertical icon rail; ref selection filters the graph
- [ ] S10 — Console tab with argv, exit code, duration and redaction
- [ ] Commit Details: committer, signature, parents, `Contained in branches` (lazy)
- [ ] Filter row: `Branch or tag`, text/hash with regex + match-case, four multi-select dropdowns, saved presets
- [ ] Commit menu: Create Patch, Fixup, Squash Into, Push All up to Here, Branches ›, Go to Parent/Child, Show Repository at Revision
- [ ] `Reset → Keep` alongside Soft/Mixed/Hard
- [ ] §3.9 patches: `format-patch` create + `am`/`apply --3way` apply, round-trip verified

## Planned deviations
- **`Show Repository at Revision` opens a tree view, not a second project window.** IntelliJ
  opens a full project frame at that revision; VS Code has no equivalent, and mutating
  workspace folders to fake one is worse than a scoped read-only tree.
- **No re-run in the Console tab** (see T8.4).
- **Graph rendering stays canvas + virtualized rows** (master §6) — unchanged and adequate.
- **Diffs opened from Changed Files still use VS Code's diff editor (S5)** — see
  `docs/deviations.md`.
- **No `Update Info` / `Repository` tabs.** IntelliJ's tool window has more tabs than
  `Log | Console`; `Update Info` is folded into the Update Project result notification
  (P13-T2) rather than becoming a fifth pane.
