# Accepted deviations from IntelliJ

GitTree's goal is IntelliJ IDEA's Git UI/UX inside VS Code. Some divergences are deliberate:
either the VS Code API cannot express the IntelliJ artifact, or the IntelliJ artifact depends on
an IDE platform feature that has no analogue here.

This file is the **single register** of those divergences. It exists because
`docs/parity-audit.md` previously recorded ✅ against a spec that undercounted IntelliJ's real
surface, which made genuine gaps invisible. Rules:

- Anything not listed here is a **gap to close**, not a deviation — see
  `docs/intellij-gap-analysis.md`.
- Each entry states the API reason. "It was more work" is not a reason.
- `Revisitable` says what would have to change for the deviation to go away.

| # | Deviation | Revisitable |
|---|---|---|
| [D1](#d1--differences-viewer) | Diffs use VS Code's diff editor, not IntelliJ's Differences Viewer | **Narrowed — Route A shipped (P14-T7); the renderer stays deviated** |
| [D2](#d2--dialogs-are-not-os-modal) | Dialogs are editor-area webview panels | No (API) |
| [D3](#d3--no-anchored-popups) | Popups are not anchored to their trigger widget | No (API) |
| [D4](#d4--vcs-widget-location) | Branch widget lives in the status bar, not a top toolbar | No (API) |
| [D5](#d5--branches-popup-drill-in) | Branches popup drills into folders instead of collapsing in place | Only via webview popup (rejected) |
| [D6](#d6--file-status-colors) | File status colors are approximated from theme colors | Partially |
| [D7](#d7--ide-platform-features-omitted) | IDE-platform commit checks and post-commit upload omitted | No (no analogue) |
| [D8](#d8--show-repository-at-revision) | `Show Repository at Revision` opens a tree view, not a project frame | No (API) |
| [D9](#d9--no-update-info-tab) | No `Update Info` tool-window tab | Yes (low value) |
| [D10](#d10--console-tab-is-read-only) | Console tab cannot re-run commands | Deliberate |
| [D11](#d11--no-provider-integrations) | No GitHub/GitLab integration, no accounts, no remote actions | No (project constraint) |
| [D12](#d12--local-history-is-bespoke) | Local History is a bespoke store, not the Timeline API | Yes, if the API stabilizes |
| [D13](#d13--inclusion-is-line-granular) | Per-change inclusion is line-range granular | Yes (small) |
| [D14](#d14--tri-editor-merge-layout) | Merge uses three real editors, not IntelliJ's pane chrome | Deliberate (a win) |
| [D15](#d15--push-tags-current-branch-means---follow-tags) | `Push tags: Current Branch` maps to `--follow-tags` | No (no git equivalent) |
| [D16](#d16--worktree-lockprunable-flags-are-derived-on-git--236) | Worktree lock/prunable derived from disk on git &lt; 2.36 | Yes (drop when git 2.36 is the floor) |
| [D17](#d17--apply-non-conflicting-changes-acts-on-conflict-blocks-not-the-whole-diff) | `Apply non-conflicting changes` acts on conflict blocks; git pre-applies the rest | Only by dropping git's own re-merge |
| [D18](#d18--change-bars-sit-at-the-content-edge) | Change bars sit at the content edge, ~21px right of VS Code's own lane | No (no public API targets that lane) |
| [D19](#d19--the-change-popup-is-keyboard-invoked-hover-is-opt-in) | The change popup opens from a key (hover is opt-in), not by clicking the bar | No (decorations expose no click handler) |
| [D20](#d20--vs-codes-own-diff-arrows-remain-beside-gittrees) | VS Code's next/prev-change arrows remain beside GitTree's | Only via Route B |
| [D21](#d21--change-bar-anchoring-can-differ-by-one-line) | Change-bar anchoring can differ from VS Code's by one line | No (inherent to owning the diff) |
| [D22](#d22--explorer-decorations-are-a-setting-not-a-negotiation) | Explorer decorations are a plain setting, not conditioned on the built-in extension | Deliberate |
| [D23](#d23--changelists-are-stored-per-repository-presented-per-project) | Changelists are stored per repository and merged into one row for display; user lists merge by name | Yes (costly, low value) |
| [D24](#d24--the-log-graph-renders-one-repository-at-a-time) | The log graph renders one repository at a time, so `Paths ▾ · Roots` is a single-select | Yes (a phase of work) |
| [D25](#d25--the-annotation-age-ramp-is-quantised-to-five-steps) | The blame age gradient has five steps instead of a continuous ramp | No (API) |
| [D26](#d26--four-opt-in-sidebar-panes-intellij-has-no-equivalent-of) | Branches, Worktrees, Local History and Stashes are opt-in sidebar panes | Yes (`gittree.sidebar.extraViews`) |
| [D27](#d27--all-roots-branch-operations-are-the-ones-that-need-no-per-root-input) | Only branch operations needing no per-root input are offered across all roots | Yes (costly, low value) |
| [D28](#d28--the-status-bar-widget-is-an-action-not-a-readout) | The status-bar widget is a button that opens the popup, not a second branch readout | Yes (`gittree.statusBar`) |
| [D29](#d29--a-repositories-section-and-a-branches-view-in-the-sidebar) | A Repositories section, and a Branches view that follows it, in the sidebar | Yes (mechanical) |
| [D30](#d30--update-project-asks-with-a-message-box-not-a-dialog) | Update Project asks Merge or Rebase with a native message box; `Don't show again` moves to the result | No (no modal surface can hold a radio button) |
| [D31](#d31--updates-set-local-changes-aside-with-gits-autostash-not-the-shelf) | Updates set local changes aside with git's `--autostash`, not the shelf — and not at all over staged content | Yes (a shelf-based saver) |
| [D32](#d32--push-rejected-asks-with-a-message-box-its-checkboxes-move-out-of-it) | A rejected push asks Merge or Rebase with a native message box; `Remember…` moves to the result, *Update all repositories* to a setting | No (API) |
| [D33](#d33--console-and-worktrees-cannot-be-closed) | In the Git tool window only the extra Log tabs close; Console and Worktrees always stay | Deliberate (owner's decision) |
| [D34](#d34--the-sidebars-branches-panel-is-gittrees-own-design) | The sidebar's Branches panel is GitTree's own design: status first, one list for every repository, a card per branch | Deliberate (owner's request) |

---

## D1 · Differences Viewer

**The headline deviation.** Every diff in GitTree — from the commit window, the log's Changed
Files pane, branch compare, stash/shelf preview, Local History — opens VS Code's native diff
editor (`vscode.diff`). IntelliJ's Differences Viewer is a purpose-built component with its own
toolbar, and none of it is reachable through the VS Code API.

### What IntelliJ has that the native diff editor does not

| IntelliJ control | VS Code equivalent |
|---|---|
| `Side-by-side viewer ▾` — Side-by-side · Unified · Two-side with line-by-line | `diffEditor.renderSideBySide` (boolean only; no line-by-line mode) |
| `Do not ignore ▾` — Do not ignore · Trim whitespaces · Ignore whitespaces · Ignore whitespaces and empty lines · Ignore imports and formatting | `diffEditor.ignoreTrimWhitespace` (boolean only) |
| `Highlight words ▾` — Highlight words · lines · split changes · do not highlight | none |
| `≫` / `≪` per-change apply arrows in the gutter between panes | none in the diff editor (merge editor only, not extensible) |
| Per-change **include checkbox** + `N differences, M included` | none |
| Collapse unchanged fragments (with configurable context) | `diffEditor.hideUnchangedRegions.*` (close) |
| Align changes | none |
| Compare with Clipboard · Switch to three-side | none |
| Annotate (blame) inside the diff | GitTree's blame decorations do not apply to diff editors |
| Per-side revision header with lock icon and EOL indicator | diff editor title only |
| Sync-scroll toggle | always on, not toggleable |

The blocking items are the three dropdowns, the per-change arrows and the per-change
checkboxes. VS Code exposes no API to add controls *inside* a diff editor: `editor/title` can
add title-bar buttons and `scm/change/title` can add per-change actions in quick-diff, but
neither can render a dropdown in the diff toolbar or a checkbox on a change.

### What GitTree does instead

- All diffs open the native diff editor.
- P11 adds `InlineDiff` — a **scoped** read-only side-by-side renderer used only inside the
  commit window and dialogs, where the per-change include checkbox and the
  `N differences, M included` counter are functionally required (they *are* IntelliJ's commit
  gesture). It is not a general diff viewer and deliberately has no toolbar.

### If you want to build the real thing later

Three routes, cheapest first. They are additive — A is worth doing regardless.

**Route A — dress the native editor (small, ~1 task).**
Add an `editor/title` menu group on GitTree diff editors that flips the settings VS Code does
expose: side-by-side/inline, ignore-trim-whitespace, hide-unchanged-regions, plus
`Go to Next/Previous Difference` and `Compare with Clipboard` (open a diff against a temp
document). Buys roughly the top third of the table with no new rendering, no bundle cost, and
no loss of editor features. **Recommended regardless of whether B or C ever happens.**

**Route B — full webview diff viewer (large, a phase of its own).**
Own the rendering: virtualized two-column renderer over `core/patch`'s `LineChange[]`, its own
toolbar, per-change arrows and checkboxes, alignment and collapsing. Costs, all real:

- **Syntax highlighting.** VS Code's TextMate grammars are not accessible from a webview. You
  either ship a highlighter (Shiki with a trimmed grammar/theme set is the realistic choice) or
  render unhighlighted. Shiki collides with the P10-T5 bundle budget — that budget would have to
  be renegotiated, and lazily loading it per-language is the only way to keep it sane.
- **Editor features lost:** find/replace, multi-cursor, folding, go-to-definition, hover, the
  user's editor keybindings, and IME in any editable pane. Read-only diffs feel this less, but
  "diff then edit the result" flows break.
- **Large files.** The native editor is heavily optimized; a webview renderer needs its own
  virtualization plus a size cutoff that falls back to the native editor.
- **Accessibility.** VS Code's Accessible Diff Viewer is a real feature; it would have to be
  reimplemented to keep the P10-T2 commitments.

Do not use Monaco-in-webview: master §6 already rejected it for the merge view (loses LSP), and
it would double the bundle.

**Route C — hybrid (medium).**
Keep the native editor for text; add a companion webview strip (or a `WebviewView` beside it)
carrying the dropdowns, the change list with include checkboxes, and navigation — driving the
native editor through decorations, revealed ranges and CodeLenses. Gets most of the toolbar and
the inclusion model while keeping every editor feature. Awkward in one respect: the controls are
not physically inside the diff's toolbar, so it looks adjacent rather than integrated.

**Recommendation for a future phase:** do **A** first as part of any Tier 2 work, then decide
between C and B based on whether the per-change arrows matter more than editor fidelity.

### Status: Route A shipped in P14-T7 — this deviation is narrowed, not closed

GitTree now contributes its own controls to its own diffs (`when: isInDiffEditor &&
gittree.diff.active`): previous/next change, side-by-side/inline, ignore-whitespace and
collapse-unchanged. It also has something IntelliJ has and the native editor structurally
cannot: **cross-file change navigation**. VS Code wraps to the top of the same file at the last
change because a diff editor knows two documents and nothing about a sequence; GitTree opens
the diffs, so it knows the sequence and reproduces IntelliJ's two-stage gesture — the first
press arms and names the next file, the second press crosses, and the end of the last file
stops rather than wrapping.

**What is still deviated:** the renderer itself. Side-by-side/unified/two-side-with-line-by-line
as three modes rather than a boolean, the five-way ignore-whitespace list, highlight
granularity (words/lines/split), the `≫`/`≪` per-change apply arrows between panes, per-change
include checkboxes outside the commit window, and "align changes" all remain out of reach
without Route B.

**Route B is gated, not rejected.** It costs a phase of its own and trades away syntax
highlighting (TextMate grammars are unreachable from a webview), find/replace, multi-cursor,
folding, go-to-definition, hover, the user's editor keybindings, IME in editable panes,
large-file performance, and the Accessible Diff Viewer that P10-T2 commits to. Revisit it
behind a spike measuring bundle cost and large-file performance, as above — not as a
refactor.

---

## D2 · Dialogs are not OS-modal

**IntelliJ:** modal dialogs that block interaction with the rest of the IDE.
**GitTree:** `dialogHost` (P11-T1) opens a `WebviewPanel` in the editor area, styled as a
dialog, with `aria-modal="true"`, a focus trap, `Esc` to cancel and `Enter` for the default
action. The rest of the window stays interactive.
**Why:** VS Code has no modal webview. `showQuickPick`/`showInputBox` are the only modal
surfaces, and they cannot render a two-pane dialog with an option list.
**Revisitable:** no, absent a new API.

## D3 · No anchored popups

**IntelliJ:** popups anchor to the widget that opened them (branches popup under the branch
widget, gear popup at the gear icon).
**GitTree:** QuickPicks appear centered at the top; the commit gear popup renders inside the
commit webview.
**Why:** no API to position a QuickPick or a webview relative to a UI element.
**Revisitable:** no.

**Related (P11):** context menus *inside webviews* with per-row interpolated labels
(`Merge 'feature/f1' into 'master'`) render via the UI kit's own `Menu` component —
`data-vscode-context` can only raise statically-contributed `webview/context` items. Where the
labels are static (the Shelf tab's rows), the native `webview/context` route is used, and
native menus stay in use for all tree views.

## D4 · VCS widget location

**IntelliJ (New UI):** `<project> ▾  ⑂ <branch> ▾` in the **top-left main toolbar**, with
incoming (blue) / outgoing (green) indicators.
**GitTree:** status-bar item at the bottom with ahead/behind counts; same information, same
click target behaviour.
**Why:** VS Code extensions cannot contribute to the title bar or a top toolbar.
**Revisitable:** no.

## D5 · Branches popup drill-in

**IntelliJ:** folder nodes expand and collapse in place inside the popup.
**GitTree:** picking a folder row opens a scoped popup with a `‹ Back` row and a breadcrumb
title; typing searches flat across every level, so drill-in never traps you.
**Why:** `QuickPick` has no tree/collapse model. A webview popup was rejected in master §6
(loses native search and keyboard parity) and the reference screenshot supports that call — the
field literally reads "Search for branches and actions", which is what QuickPick is for.
**Revisitable:** only by accepting the webview trade-off.

## D6 · File status colors

**IntelliJ:** 15 named file statuses, each with a per-theme color, editable on a settings page;
directories with modified descendants are highlighted.
**GitTree:** the statuses that map onto VS Code's decoration and theme color model, with a
`gittree.colors.*` override block and directory highlighting derived from the change tree
(P11-T8). `FileDecorationProvider` is file-level and badge-shaped, so statuses that IntelliJ
distinguishes by color alone may collapse together in the explorer.
**Revisitable:** partially — inside GitTree's own webview trees the full palette is achievable;
the file explorer stays limited by the decoration API.

## D7 · IDE-platform features omitted

Commit-options rows with no VS Code analogue are **not implemented and not rendered**
(P11-T5 gear popup): `Update copyright`, `Check malicious dependencies`, `Run Configuration`,
and the entire `After Commit` / `Upload files to <server>` section (IntelliJ's deployment
integration). `Rearrange code` is also omitted: VS Code has no cross-language member-rearrange
code-action kind (`source.organizeImports` is already the Optimize imports row, and
`source.sortMembers` exists only for individual languages with no capability probe that does
not execute every provider), so the row is hidden rather than shown-inert per the plan.
IntelliJ's Cleanup "Choose profile" maps to **which code-action kind the Cleanup check
applies** (`gittree.commit.checks.cleanupKind`, default `source.fixAll`, e.g.
`source.fixAll.eslint`) — inspection profiles themselves have no analogue.
The plan's contributions list also names a `gittree.commit.author` *setting*; the author
override is per-repo `workspaceState` instead (plan step 2), because a workspace-level setting
cannot differ per repository in a multi-root workspace.
**Why:** these are IntelliJ platform features (copyright profiles, run configurations,
deployment targets, package-checker), not Git features.
**Revisitable:** no, unless the equivalent VS Code ecosystem feature is in scope.

## D8 · Show Repository at Revision

**IntelliJ:** opens a full project frame at that revision.
**GitTree:** a read-only tree view backed by a `gittree-tree:` `FileSystemProvider` over
`git ls-tree` + `git cat-file` (P12-T7).
**Why:** VS Code has no second project frame; faking one by mutating workspace folders is worse
than a scoped read-only tree.

## D9 · No `Update Info` tab

**IntelliJ:** a tool-window tab summarizing the last Update Project.
**GitTree:** a result notification with commits pulled / files changed and a "Show in Log"
action that opens the log filtered to the fetched range (P13-T2).
**Revisitable:** yes, but it duplicates the log for little gain.

## D10 · Console tab is read-only

The Console tab (P12-T8) shows argv, exit code, duration and output for every executed git
command, with secrets redacted. It deliberately offers **no re-run**: re-executing an arbitrary
logged mutation from a log pane is a footgun. **Deliberate, not an API limit.**

## D11 · No provider integrations

No GitHub/GitLab integration, no account sign-in, no pull-request UI, no remote-side actions.
This is a standing project constraint, not an API limitation: Phase 8 was skipped by owner
decision. `Clone` accepts a URL and does not enumerate remote repositories.

## D12 · Local History is bespoke

**GitTree:** its own snapshot store plus git-operation and reflog recovery, complementing the
native Timeline rather than implementing it.
**Why:** `TimelineProvider` is a proposed API and cannot ship in a published extension.
**Revisitable:** yes, if it stabilizes — the store would stay, the surface would gain a Timeline
contribution.

## D13 · Inclusion is line-granular

Per-change include checkboxes operate on `LineChange[]` ranges. IntelliJ can include a
word-level change inside a line.
**Revisitable:** yes, and small — it needs a word-level differ feeding `buildPatch`. Deferred
because line-range granularity covers essentially every real commit-shaping case.

## D14 · Tri-editor merge layout

GitTree's merge uses three **real** VS Code editors (left read-only, center writable, right
read-only) rather than reproducing IntelliJ's exact pane chrome. The center pane therefore keeps
full language support — autocomplete, diagnostics, formatting — while resolving conflicts, which
a webview merge view would lose. Recorded as a deviation for honesty, but it is a **win**, and
P13-T8 closes the toolbar gaps (Left/All/Right apply-non-conflicting, live conflict counter,
per-side Show Details).

## D15 · `Push tags: Current Branch` means `--follow-tags`

IntelliJ's push dialog offers `All` / `Current Branch` for tags. Git has no "tags on this
branch" flag; the closest true equivalent is `--follow-tags`, which pushes annotated tags
reachable from the commits being pushed. **GitTree uses `--follow-tags` for `Current Branch`
and `--tags` for `All`** (P13-T1), and the dialog's "will run" line always shows which one is
about to run, so the mapping is visible rather than implied.
**Revisitable:** only by enumerating `git tag --merged <branch>` and pushing an explicit refspec
list, which would push lightweight tags IntelliJ also skips. Not worth the divergence.

## D16 · Worktree lock/prunable flags are derived on git < 2.36

`git worktree list --porcelain` only began reporting `locked` and `prunable` in
**git 2.36**. On older builds the porcelain is silent about both, so the Worktrees view
would never show a lock badge and prune's stale records would be invisible.
**GitTree derives them from git's own on-disk layout instead** (P13-T6): a linked worktree's
`.git` is a pointer file to its admin directory, a lock is a `locked` file there whose contents
are the reason, and a missing worktree directory is prunable by definition. The derivation only
ever *adds* information — a git that already reports the flags keeps them, and the two agree.
**Revisitable:** it can be deleted once the minimum supported git is 2.36 or newer.

## D17 · `Apply non-conflicting changes` acts on conflict blocks, not the whole diff

IntelliJ's merge viewer models **every** difference between the base and either side as a
"change", so `Apply non-conflicting changes: Left / All / Right` has plenty to apply. GitTree's
merge model comes from `git merge-file -p --diff3` over the index stages, and **git applies every
non-overlapping change itself before the tri-editor ever opens** — verified empirically: a change
one side makes with no counterpart on the other never appears inside a conflict block.

So in GitTree these three actions operate on what remains *inside* the conflict blocks
(P13-T8): `All` runs the magic-wand cascade — including the two-sided rules (disjoint interleave,
whitespace-only divergence) — while `Left` and `Right` take only a block a single side owns, and
otherwise report `No non-conflicting changes to apply` with the live counter rather than quietly
taking a side. The toolbar shape matches the reference and the semantics stay honest; the
"take my side everywhere" verbs are the separate `Accept Yours` / `Accept Theirs` actions.
**Revisitable:** only by abandoning git's own re-merge and computing the full three-way diff
ourselves, which would lose byte-exact parity with what git would have written.

## D18 · Change bars sit at the content edge

**IntelliJ:** a narrow change-marker strip between the line numbers and the text.
**VS Code:** its own quick-diff bars render in an internal "line decorations" lane, in the same
place.
**GitTree:** an `isWholeLine` decoration with a 3px left border, which lands at the left edge of
the *content* area.

**Why:** no public decoration API targets that lane. Measured on VS Code 1.134 at
`window.zoomLevel: 2`, VS Code's bar sits at x=431–434 and the border technique at x=462–465 —
about 21px right at 100% zoom, at the identical 4px width. The alternative, `gutterIconPath`,
renders in the **glyph margin**: 54px the *other* way, only 2px wide, and sharing a lane with
breakpoints. The border was chosen on width fidelity and to keep breakpoints uncontested.
**Revisitable:** no, absent a new API.

## D19 · The change popup is keyboard-invoked; hover is opt-in

**IntelliJ:** clicking a gutter marker opens a compact popup with the previous text and a
toolbar. Hovering the marker shows nothing.
**GitTree:** the same actions — Rollback / Stage / Commit View — open at the cursor from
`gittree.change.showActions` (`Ctrl+Alt+G H`). The full popup, previous text included, also
opens on hover over a changed line when `gittree.changeBars.hoverActions` is on; it is **off by
default** (POST-P14aa).

**Why:** VS Code exposes no click handler for a `TextEditorDecorationType`, and no API opens a
diff peek widget at a location. Native quick-diff bars are clickable because VS Code core
implements that itself. A `CodeLens` variant was rejected: it costs a text line per change,
which a gutter marker does not. Hover shipped on by default until the owner asked for it gone:
IntelliJ opens nothing on hover, and a popup that appears whenever the pointer crosses an edited
line lands on top of the language server's own hover on exactly the lines being worked on. It
was kept behind a setting rather than deleted because it is the only **mouse** route to hunk
actions — off, they are keyboard-only.
**Revisitable:** no, absent a new API. A click handler on the bar would make both the hover
and this entry unnecessary.

## D20 · VS Code's own diff arrows remain beside GitTree's

**GitTree** contributes previous/next-change arrows to its own diffs, and they sort first.
VS Code's built-in arrows stay visible next to them and still wrap within the file.

**Why:** an extension cannot unregister a core menu item. Users can hide the built-ins from the
editor-toolbar context menu, but GitTree cannot do it for them. The keyboard is unaffected —
`F7`/`Shift+F7` are GitTree's and scoped to its diffs.
**Revisitable:** only via Route B, which would replace the editor and so remove its toolbar with
it. Deleting two buttons is not a reason to take on that trade.

## D21 · Change-bar anchoring can differ by one line

GitTree computes its own hunks, so where an insertion sits between two equally plausible
anchors — most often blank lines — its bar may start one line from where VS Code's did. Both are
correct diffs of the same change; the block covers the same number of lines.

**Why:** inherent to owning the diff instead of reading VS Code's.
**Revisitable:** no.

## D22 · Explorer decorations are a setting, not a negotiation

**Before P14:** GitTree skipped explorer decorations in "companion" mode so as not to double up
with the built-in Git extension's.
**Now:** `gittree.decorations.fileExplorer` (default on). GitTree does not inspect what other
extensions are doing.

**Why:** the plan for P14-T6 proposed detecting `vscode.git` and defaulting the setting off once.
That was rejected during implementation: it writes a setting on the user's behalf unprompted,
and it makes GitTree's behaviour depend on another extension — the exact coupling this phase
exists to remove, and a contradiction of its own exit criterion that enabling or disabling the
built-in Git extension changes nothing about how GitTree behaves. Someone running both who
dislikes the overlap turns one of them off.
**Revisitable:** deliberate.

## D23 · Changelists are stored per repository, presented per project

In IntelliJ a changelist is a *project*-level object: one `Changes` node holds files from every
VCS root, and a list named `Feature X` spans three repositories at once. GitTree builds one
`ChangelistService` per repository (`gittree.changelists.<root>`).

**The tree reads as IntelliJ's.** `assembleCommitTree` merges the same changelist across
repositories into one row, with a repository row per contributor beneath it — a single `Changes`
and a single `Unversioned Files`, not one of each per repository. Actions on a merged row fan out
to every repository behind it; the repository row keeps the scoped versions. A new changelist is
created in *every* repository, so the merged row is not a facade over lists that exist in only
some of them, and `Move to…` offers the same names everywhere.

**Where the merge is exact, and where it is an approximation.** The default list and Unversioned
Files carry the same id in every repository (module constants), so they merge by **id** — a
repository always has exactly those two, and nothing is being guessed. A user-created list gets a
random per-repo id, so it can only merge by **name**. Two lists that happen to share a name are
therefore treated as one list. That is the deviation.

**What is still per repository.** Storage and the active-list flag — each repository has its own
active changelist, where IntelliJ has one per project. Nothing renders activeness in the tree, so
this is invisible today, but `Set Active` on a merged row sets it in every repository rather than
expressing a single project-level fact. Shelving also stays scoped: a shelf belongs to a
repository, so the action is offered on repository rows and on single-root group rows, never on a
row spanning several.

**What it does *not* affect.** Committing. `Commit` spans every repository with something ticked —
one message, one commit each — and `Commit this changelist` on a merged row does the same,
narrowed to that list.

**Why the storage stays per repository.** `changelistsFor(repo)` is consumed by the shelf, stash,
undo-drop, log commit actions and the SCM dialogs — 38 call sites across 9 modules. Going
project-global changes list membership from a repo-relative path to a `(repoRoot, path)` pair,
makes `reconcile()` watch N repository models instead of one, and needs a migration for the
per-repository persisted state. The presentation merge buys the fidelity without any of that.

**Revisitable:** yes. The remaining reasons to go truly global are the name-collision case above
and a single project-level active list. Neither is visible in ordinary use.

## D24 · The log graph renders one repository at a time

IntelliJ's Log merges every VCS root into **one** graph. Its `Paths ▾` popup therefore opens
with a `Roots` section of checkboxes — all ticked by default — and un-ticking a root removes
that root's commits from the graph. Root filtering is just path filtering at repository
granularity.

GitTree's log renders **one** repository. `Paths ▾ · Roots` lists every repository the
workspace has, with the same colour swatches, but the rows are **radios**: picking one moves
the log to that repository. The section answers "which repository am I looking at, and how do
I look at another" — it cannot answer "show me these three at once".

**Why the rows are radios and not checkboxes.** Rendering them as checkboxes and silently
enforcing one tick would look like the reference and behave like nothing at all. A radio says
what the surface can actually do at a glance, which is the point of the section.

**What it would take to remove.** Not a rendering change — a different log. `LogService.getPage`
pages one repository with `--skip`/`--max-count`; N repositories share no commits, so paging
becomes a k-way date merge with a cursor per root and git's own skip arithmetic stops applying.
Every row would need a repository identity (`LogRowDto.repoRoot`), and with it `getDetails`,
`changedFiles`, `openFileDiff`, `containedBranches`, `goTo`, `showFileHistory` and all of
`commitActions` — which resolve their repository from the *session* today — would resolve it per
commit instead. The Branches pane, the Changed Files pane and the Console are each scoped to one
repository as well. `sort: 'topo'` has no meaning across disjoint histories; only date order does.

**What was done instead.** The repository stopped being *guessed*. It used to be re-derived from
the focused editor on every re-init — and a re-init happens on every filter change, refresh and
rehydrate — so a filter change while another repository's file was focused moved the log there
and re-ran a repo-relative filter against it. Now the focused editor seeds the choice once and
only an explicit act moves it: a `Roots` row, or a command that names its repository. Moving root
drops the parts of a filter that name one repository (paths, an explicit ref list, a range) and
keeps the parts that travel.

**Revisitable:** yes, as a phase of work. Nothing above is blocked by a VS Code API — the graph,
the paging model and the per-commit repository identity are all ours to change.

## D25 · The annotation age ramp is quantised to five steps

**IntelliJ:** the annotation gutter shades each cell by its commit's age, interpolating a
continuous gradient between **five anchor colours** from the colour scheme
(Editor → Color Scheme → Version Control → Annotations) across the revisions the file actually
has.

**GitTree:** the same five anchors are contributed as themable colours
(`gittree.blame.age1Background` … `age5Background`, newest first) and `ageStep` quantises the
ramp to five steps. The ranking is IntelliJ's — position among the file's own distinct commit
times, not wall-clock age.

**Why:** interpolating needs the anchors' resolved RGB values, and no VS Code API exposes one.
A `ThemeColor` is an opaque handle: the id is resolved inside the renderer when the
decoration's CSS is built, and the extension host never sees a colour. The alternative —
hard-coding literal colours per theme kind — would buy a smooth ramp at the cost of one no
theme and no user could change, which is *further* from IntelliJ, where the anchors are theme
data by design.

**What it costs in practice:** less than it sounds. IntelliJ interpolates, but the eye
resolves roughly four or five bands out of the result, and the label on every row carries the
exact date anyway — the colour orders rows, it does not date them.

**Revisitable:** yes, cheaply. Two independent routes, neither blocked today: contribute more
steps (the only cost is that many more public colour ids — five matches what a user tuning
IntelliJ's scheme actually sees), or interpolate for real if VS Code ever exposes theme-colour
resolution. The ramp is one function and the anchors are already contributed colours.

---

## D26 · Four opt-in sidebar panes IntelliJ has no equivalent of

**IntelliJ:** the Commit tool window holds the `Commit` and `Shelf` tabs (plus `Stash`, and
one merged tab when *Combine stashes and shelves* is on) and **nothing beneath them**. Branches
are reached from the branch widget popup and the Git tool window's Branches pane; worktrees
from the Git tool window's Worktrees tab; Local History from `Show History`, which opens its
own window. None of the four is a permanent section of the commit surface.

**GitTree:** the default shape is now the same — POST-P14k moved worktrees to the Git tool
window, POST-P14l gave stashes their `Stash` tab, and POST-P14n gates
`gittree.branchesLegacy`, `gittree.worktrees`, `gittree.localHistory` and `gittree.stashes`
behind `gittree.sidebar.extraViews` (default `false`). Turning the setting on brings all four
back as collapsed sections.

**Amended by POST-P14u (D29).** Branches is no longer one of the four. `gittree.branches` was
promoted to the repository-scoped Branches view, which opens unconditionally; the
all-repositories tree this deviation is about kept its provider and moved to
`gittree.branchesLegacy`, still behind the same setting. Everything below still describes
that tree and the other three.

**Why a setting and not `"visibility": "hidden"`, which POST-P14m tried first:** `visibility`
is only a **first-registration default**. VS Code persists a view container's layout the first
time it renders and never consults the default again, so on every existing install the four
panes kept showing — the change reached new profiles only, which is precisely where the tests
run. A `when` clause is evaluated live and removes the view outright, so it reaches an
upgraded user. `phase14` now asserts this against a **live view**: it turns the setting on,
focuses the stashes pane until `TreeView.visible` is true, then turns the setting off and
requires the pane to disappear. A manifest assertion cannot see that difference, which is how
the first attempt shipped broken.

Two of the four are also revealed **on demand**, the way `gittree.compare` is, because a view
that is not contributed cannot be focused and the commands that reveal them would otherwise
have become silent no-ops: the branches popup's last header button arms
`gittree.branches.active`, and `gittree.history.show` arms `gittree.localHistory.active`
before focusing. For Local History that is *closer* to IntelliJ than a standing pane —
`Show History` opens the window when you ask for it.

**Why keep them at all:** they are genuinely useful in VS Code's idiom, where a docked tree is
the cheapest way to keep something in view, and the owner asked for them to stay reachable.
Deleting four working surfaces to reach a shape a user can restore in one click is a worse
trade than leaving them off by default. Nothing depends on them: every action they offer is
registered as a command and reachable from the relocated surface.

**What it costs:** one extra surface per registry that has to keep agreeing with the others —
the POST-P14d failure mode, where three surfaces of the branch registry offered four, one and
nine menu rows for the same ref. The mitigation is structural rather than procedural: the
relocated surfaces **dispatch into the same commands** the trees do
(`worktreesPaneBridge`, `stashBridge`, `shelfBridge`, `branchesPaneBridge` all forward to
`gittree.*` commands) instead of reimplementing them, so a divergence has to be introduced
deliberately rather than by omission.

**Revisitable:** yes, in either direction. Deleting the four views and their ~34 menu
contributions is a mechanical change; so is promoting one back to visible if the tab it moved
to turns out to be the wrong home.

## D27 · All-roots branch operations are the ones that need no per-root input

**IntelliJ:** in a multi-root project the branches popup is project-level — repository rows
with their current branch, then `Common Local Branches` / `Common Remote Branches` /
`Common Tags`, the refs every root carries. An operation invoked on a common branch runs on
**all** roots, and where it needs input — a new branch's name, a delete confirmation — it is
asked for **once** and applied everywhere.

**GitTree (POST-P14p):** the shape is the same, and so is the fan-out, but only for the
operations that need no input: `Checkout`, `Update`, `Merge into the current branch`,
`Rebase the current branch onto it`, `Pull into the current branch using Merge` / `… using
Rebase`, and `Push`. These are `branchActions.ts` entries dispatched by id once per root, so
the behaviour is the registry's and cannot drift; only the *label* is rewritten, because the
registry interpolates the current branch ("Merge 'x' into 'main'") and at the project level
the roots need not share one — a label naming the first root's branch would be wrong about
the others.

**What is not offered on a common row:** `New Branch from…`, `Rename`, `Delete`,
`Delete on Remote`, `New Worktree from…` — each takes its input *inside* the per-repository
call (`BranchOps.newBranchFrom` opens its input box, `deleteBranch` its confirmation), so
fanning them out would ask seven times for one decision. Also absent are
`Compare with '<current>'` and `Show Diff with Working Tree`, which would open a diff editor
per root. All of them stay one click away: pick the repository row, and its own popup is the
full, unchanged action list.

**Why not hoist the prompts:** it is a real refactor, not a wrapper. Every one of those
`BranchOps` methods interleaves its prompt with its git work — `newBranchFrom` asks for a
name, then asks create-or-checkout, then enqueues; `deleteBranch` runs `branch -d`, reads the
"not fully merged" failure, and only then confirms a force-delete. Hoisting the input means
splitting each into a *decide* half and an *apply* half and re-pointing the six existing call
sites (the popup, the tree, the log's Branches pane, the drag-and-drop handler, the command
ids, the tracked-branch submenu) at the pair. That is worth doing; it is not worth doing
silently inside a task about which repository a fetch belongs to.

**Two smaller consequences, both deliberate:**

* **An operation offered by only some roots is still offered, and says so** —
  `Checkout in 5 of 7 repositories`. Requiring every root would hide `Checkout` the moment a
  single root was already on that branch, which is the ordinary state of a project whose
  repositories track one branch and exactly when you want to bring the stragglers across.
  Roots where the action does not apply are skipped, not attempted, and a run where it applies
  nowhere says "nothing to do" rather than appearing to do nothing.
* **The fan-out stops at the first refusal**, reporting which roots were already done — the
  idiom `runCommitAcross` established. Carrying on would start a merge in roots 3…7 while
  root 2 sits in conflict.

**Also still per repository:** the project level's `Push…` verb opens its existing
single-repository dialog, which is built per root (`pushDialog`'s `repoLabel`); making it
multi-root is the same decide/apply split as above. `Commit…` and `Fetch` *are* project-wide
from that level, because both already had a no-argument all-roots form (`runCommitAcross`, and
POST-P14o's fan-out). **`Update Project…` joined them in POST-P14ae**: once its question became a
message box (D30) there was no per-root dialog left to split — one question covers every
repository, which then updates in order and stops at the first failure, skipping any it cannot
update and naming them in the question.

**Revisitable:** yes, and the order is clear — hoisting the input out of `BranchOps` unlocks
`New Branch`, `Rename` and `Delete` on a common row, and the same split unlocks a multi-root
Push dialog.

## D28 · The status-bar widget is an action, not a readout

**IntelliJ (New UI):** `⌥ <branch> ▾` in the top-left toolbar — a *menu opener* that happens
to show the branch, with the divergence counts living in the popup it opens (capped there at
`99+`).
**VS Code:** the built-in Git extension already contributes a branch name **and** ahead/behind
counts to the status bar, and does it well.
**GitTree:** a compact button — `$(list-tree) GitTree $(chevron-down)`, one constant width — that
opens the branches popup. Branch, upstream and exact counts move to its tooltip. It grows only
for what the built-in widget does *not* show: an in-progress operation, and a conflict count.

**Why it carries the product's name** (POST-P14t). The first cut of this button was
`$(git-branch)$(chevron-down)`: unlabelled, and drawn with *the same codicon VS Code's own branch
widget uses*, two entries away from it in the same strip. Compactness had been read as a licence
to say nothing, and the result failed at both jobs an affordance has — it did not distinguish
itself from the widget it was deliberately not duplicating, and it gave someone who had just
installed the extension nothing to aim at. The name is the cheapest fix for both, and it costs
no information: VS Code is already showing the branch a few centimetres to the left, which is
the same premise this whole deviation rests on. `$(list-tree)` is a placeholder chosen for what
it is *not* — `$(git-branch)`, `$(git-commit)` and `$(source-control)` are all already in this
strip. `media/gittree-mark.svg` belongs here instead, once `contributes.icons` carries it as a
font glyph; an SVG cannot reach status-bar text any other way. `full` keeps `$(git-branch)`:
there the widget *is* the branch readout and the branch name is its label.

**Why:** shipping a second readout beside VS Code's own is duplication, not fidelity — four
status-bar items saying the same thing. IntelliJ's widget is compact because it is an
affordance, not a report, and adopting that shape removes the duplication at its source rather
than making a duplicate smaller. It bounds the width as a side effect: `$(arrow-down) 26050
$(arrow-up) 10893` had nothing capping either side.

**What this deviation is *not*:** the fix for "the branch button disappears". That was diagnosed
here as width — a wide widget falling off the end of a crowded status bar — and that diagnosis
was wrong. The real cause was a shared `StatusBarItem` id across per-repository controllers, so
any repository's `hide()` disposed the entry the active one had shown; POST-P14s has it, and
`ui/statusBar.ts` carries the mechanism. This deviation stands on the duplication argument
alone, which is what it was actually argued from.

**The readout is not gone, it is conditional.** `gittree.statusBar: auto` (the default) resolves
to `full` — branch name plus counts, capped at `99+` — when the built-in Git extension is absent
or `git.enabled` is false, because then nobody else is drawing one. Detection is deliberately
conservative: VS Code exposes no way to see that a user hid those entries from the status bar's
own context menu, so `button`, `full` and `off` are available explicitly. GitTree only ever
*reads* `git.enabled`; it never writes it (`discovery.test.ts` asserts that).

**Revisitable:** yes, that is what the setting is for.

## D29 · A Repositories section, and a Branches view in the sidebar

**IntelliJ:** there is no repositories window. A multi-root project surfaces its roots inside
the branch widget's popup — a row per repository, then `Common Local Branches` /
`Common Remote Branches` / `Common Tags` — and inside the Git tool window's own root filter.
Branches themselves live in two places: that popup, and the Git tool window's Branches pane.
There is no notion of a "current repository" anywhere in the UI; scope is picked per
operation (which is what D27 is about).

**GitTree:** the sidebar gains two sections. **Branches** (`gittree.branches`) is the popup's
content standing open, scoped to one repository. **Repositories** (`gittree.repositories`)
lists every root with its current branch and its distance from upstream, and chooses which
repository Branches shows; it is contributed only when `gittree.multiRepo` is set, and starts
collapsed with the root count beside its title.

**Why, against a project whose first principle is IntelliJ fidelity.** Two reasons, and only
the second is about IntelliJ.

The first is that **the status bar cannot carry a primary entry point.** Cursor has no status
bar at all — confirmed from the owner's own window, where GitTree's Git tool window and
activity-bar icon are both present and the bottom strip simply does not exist. Everything
POST-P14r through POST-P14t did to that widget is invisible to every Cursor user. A surface
that some IDEs in our supported set do not render is a surface nothing may depend on.

The second is that the persistent branches surface **is** IntelliJ's — P12-T2 built it, as the
Git tool window's Branches pane, where JetBrains keeps it. What POST-P14u changes is where a
VS Code user meets it. That is the Tier-1 failure this project already has a name for from
POST-P14k, *capability specified without container*, pointed the other way: the container was
faithful and nobody found it. GitTree's own sidebar is the container a VS Code user opens.

**What this deliberately is not.** Focus is a **view filter, not a mode.** It scopes the two
sections that draw it. `Ctrl+K`, `Ctrl+T`, Push and every other command keep resolving their
repository from the active editor, unchanged. Both references split it exactly this way —
VS Code's Source Control selection filters that view while its status-bar branch follows the
editor; IntelliJ's log has a root filter while its widget follows the editor — and the
alternative is the failure mode: wiring focus into *some* commands lets the sidebar name one
repository while `Ctrl+K` commits another, with nothing on screen to say so. The section
header names its repository, so the filter is never silent. Making focus global is a real
option and a separate one; it is a refactor of the six copies of `pickRepo`, not a side
effect of adding a view.

**Where it differs from VS Code, deliberately.** Three places, because "like the Source
Control view" turns out to describe two different VS Code views:

* **Rows do not expand.** VS Code's *Source Control* view expands a repository to its
  changes; its *Repositories* view does not expand at all. Ours is the selector, so it does
  not expand — changes belong to the Commit view.
* **Selection is single and total.** VS Code's Repositories view is multi-select and its
  selection is a visibility filter; ours focuses exactly one and cannot focus none, because
  the Branches view below it must always have something to draw.
* **Right-click reaches the verbs.** In VS Code the repository verbs are on the row's `⋯`
  button (`scm/repository`, 14 entries) and right-click gives `scm/sourceControl`, which is
  *Close Repository* and two worktree rows. Ours puts the verbs on right-click, where a user
  expects them. They are named GitTree's way, not VS Code's — `Update Project…`, not `Pull`
  — because that is what those commands are called everywhere else in this extension.

**What it costs.** One more surface over the branch-action registry, which is the POST-P14d
failure mode and is mitigated the same structural way: the Branches view emits the **same**
`contextValue`s from the **same** `branchActions.branchContextValue`, so all 21
`view/item/context` clauses serve both trees with no second menu to maintain; its `Actions`
rows are literally `HUB_VERBS`, the popup's own list; its sections come from
`branchHubModel.hubSections`, lifted out of the popup's `buildPopupItems`; and its
drag-and-drop dispatches into the legacy tree's existing `showDropActions`. A unit test
asserts every branch-row clause names both view ids, and fails if one is narrowed back.

**Revisitable:** yes. Deleting the two views is mechanical, and the legacy tree is one setting
away in the meantime. The open question is whether focus should become the global repository
scope — deliberately left for its own task.

**Superseded in part by D34:** the Branches view is no longer the popup standing open, and the
Repositories section joined the opt-in panes, since the Branches panel lists the repositories
itself.

## D30 · Update Project asks with a message box, not a dialog

**IntelliJ:** `Ctrl+T` opens a small modal dialog — *Merge incoming changes into the current
branch* / *Rebase the current branch on top of incoming changes* as two radio buttons,
`Don't show again`, `OK` / `Cancel`, and in some states `Reset to the Remote Branch`.
**GitTree:** a native modal message box titled *Update Project*. Its text names what is being
updated — `develop ← origin/develop · 3 behind · 0 ahead` — and, with
`gittree.dialogs.showCommandLine` on, the exact commands behind each button. The buttons are
`Merge`, `Rebase`, `Reset to the Remote Branch` and VS Code's own `Cancel`; pressing one is
the `OK`. The strategy answered last comes first, so `Enter` repeats it the way IntelliJ's
pre-selected radio does. `Don't show again` moved to the update's result notification as
`Don't Ask Again`.

**Why:** VS Code gives an extension no modal surface that can hold a radio button or a checkbox
(D2). P13 answered with a webview dialog in an editor tab, and for this dialog that was the wrong
trade: a whole tab, pushed into the editor area, for one two-way choice — the owner's word for it
was "a weird page". The message box *is* modal and centred, as IntelliJ's dialog is, and a
two-way choice is exactly what a pair of buttons expresses. A checkbox is the one thing it cannot
hold, so the opt-out moved to the one place the user is looking right after answering. The
other eleven P13 dialogs keep their editor-tab panels: they hold file trees, commit lists and
flag dropdowns, which no message box can.

**Two smaller differences.** IntelliJ shows `Reset to the Remote Branch` only in some states —
it is in one reference screenshot and absent from another, and its rule is not known here — so
GitTree always offers it, last, where `Enter` cannot reach it, behind its own confirmation and a
Local History snapshot. And the answer is remembered in workspace *state* rather than in a
setting: it changes on every answer, and writing a setting that often would keep rewriting a
`.vscode/settings.json` that many repositories track. IntelliJ keeps its equivalent in
`workspace.xml` for the same reason.

**Revisitable:** only with a new API — a modal webview, or checkboxes in `showInformationMessage`.

## D31 · Updates set local changes aside with git's autostash, not the shelf

**IntelliJ:** Update Project never refuses because you are mid-work. It saves your uncommitted
changes first — to the shelf by default, or a stash (*Settings → Version Control → Git*) —
merges or rebases, and puts them back, opening its merge dialog if putting them back conflicts.
**GitTree:** the same guarantee, through git's own `--autostash` on the `merge` or `rebase`.
When putting the changes back conflicts, the files are left conflicted, a copy stays in the stash,
the result is a warning that says so, and GitTree's conflict session opens as `stash-pop`.
Before this, a bare `git rebase` refused on any uncommitted change and a bare `git merge`
refused whenever an incoming commit touched a file you had edited.

**Why the stash and not the shelf:** `--autostash` is the one mechanism that survives the
integrate step *stopping*. On a conflicted merge or rebase, git holds the stash and re-applies it
when the user finishes, whichever tool they finish in; a saver of GitTree's own would have to
remember a pending unshelve across a conflict resolution it does not control.

**Two refinements, both measured rather than assumed.**
* **Intent-to-add entries** (`git add -N`, which *Add to VCS* and the changelist commit path
  create) make `git stash` fail outright — "Cannot save the current worktree state" — so
  `--autostash` alone would have *broken* updates that plain `git merge` handles. They are taken
  out of the index around the step and put back after; stopped on a conflict, they stay
  untracked until it is finished (they remain in their changelist, and the result says so).
* **Staged content is never stashed.** `--autostash` restores content but not the index — a
  half-staged file comes back wholly unstaged — which would silently undo deliberate staging in
  the staging paradigm. With anything staged, the plain command runs and git either proceeds
  with the index intact or refuses in its own words, before changing anything.

`git merge --autostash` needs git 2.27; below that, the merge half runs as before.

**Revisitable:** yes — a shelf-based saver with its own pending-restore bookkeeping would match
IntelliJ's default exactly. The stash was chosen because git already owns that bookkeeping.

## D32 · Push Rejected asks with a message box; its checkboxes move out of it

**IntelliJ:** a push the remote rejects because it has commits you do not opens *Push
Rejected* — a warning icon, *Push of the current branch "X" was rejected. Remote changes need to
be merged before pushing.*, `☐ Remember the update method and update silently in the future`,
and `[Merge] [Rebase] [Cancel]` with the saved update method as the default. In a project with
several repositories it also has *Update all repositories*.
**GitTree:** the same question as a native modal message box, a warning as IntelliJ's is: its
sentence (naming the repository too when the workspace has several), then — with
`gittree.dialogs.showCommandLine` on — what each button runs, the update and then the same push
again. The buttons are `Merge`, `Rebase` and VS Code's own `Cancel`, the last answer first; the
answer is shared with Update Project, as IntelliJ keeps one update method for both. `Remember…`
is `Don't Ask Again` on the result, and it writes IntelliJ's own setting — *Auto-update if push
of the current branch was rejected* — as `gittree.push.autoUpdateIfRejected`.

**Why:** D30's reason, and D30's answer: no modal surface an extension can open holds a
checkbox, and GitTree's two update questions should behave alike.

**Also different:**
* ***Update all repositories* is a setting** (POST-P14ag), `gittree.push.updateAllRepositoriesIfRejected`,
  on by default — the owner's decision, matching the checkbox as IntelliJ first shows it. The
  question names the other repositories it will update, where IntelliJ shows the ticked box. As
  in IntelliJ, every update runs before anything is pushed again, and nothing is pushed again
  unless all of them went through; the updates run in workspace order and stop at the first
  failure, as Update Project's do.
* **The result's links.** "Show details in console" is `Show Details`, which opens the Console
  tab. "View files updated during the push" is `Show in Log`, filtered to what came in (D9: no
  Update Info tab). "Create pull request" is absent (D11).
* **Unpushed merge commits.** IntelliJ's warning is kept — Merge first, `Rebase Anyway`, no
  `Remember` — and, since a silent rebase would flatten them, the question is asked even with
  auto-update on while Rebase is the remembered answer.
* **Rounds.** If the remote moves again while GitTree updates, it updates and pushes again with
  the same answer, at most three times. IntelliJ also retries; its bound is not known here.

**Revisitable:** only with a new API, as D30 — the two checkboxes would move back into the
question.

## D33 · Console and Worktrees cannot be closed

**IntelliJ:** every tab in the Git tool window but the first Log tab has a `×`, Console and
Worktrees included, and right-clicking one offers Close Tab, Close Other Tabs and Close All Tabs.
**GitTree:** the same strip in the same order (Log, Console, Worktrees, then the extra Log tabs
opened by `+`, File History, Compare with Current and an update's Show in Log), with a `×`,
middle-click and that menu, but only the extra Log tabs ever close. The menu opens on every tab,
with Close Tab greyed out on the three that stay.

**Why:** the owner's decision (2026-11-01). A closed Console or Worktrees tab would need a way
back, which IntelliJ provides through its menus and GitTree has no surface for, and a tab closed
by accident is lost work for no gain. IntelliJ's `⌄` beside `+` is omitted for the same reason:
it offers nothing GitTree's strip lacks.

**Revisitable:** yes, if a reopen route is added (the VCS Operations Popup is the natural one).

## D34 · The sidebar's Branches panel is GitTree's own design

**IntelliJ:** branches live in the branch widget's popup (transient, search-first, a submenu per
branch) and in the Git tool window's Branches pane (a tree that filters the log). There is no
standing panel that combines every repository's state with its branches.
**GitTree:** the sidebar's Branches section is a panel designed for VS Code's sidebar:
* every repository's status first;
* then one list of branches for all of them, recent and starred first;
* a card per branch with the actions its state calls for;
* an inline New Branch form, and Clean Up Branches….

**Why:** the owner's request. The earlier panel copied the popup into a standing view (D29), and
what made the popup good made the panel poor:
* verb rows took the top of the list for good;
* a branch row did nothing on a click;
* a flat menu was the only way to act;
* a repository tree repeated every shared branch once per repository.

A native tree of the same content (kept on the branch `new-way-3-native-tree-demo`) was tried
and judged no better.

**What stays IntelliJ's:**
* every action is the shared registry's, under IntelliJ's names, run the same way;
* the popup is unchanged;
* the log's Branches pane is still the pane IntelliJ has.

What is new is the arrangement:
* status, then relevance, then the full lists;
* one row per branch name across repositories;
* a card instead of a submenu for the common actions.

**Revisitable:** yes — the popup and the opt-in trees (`gittree.sidebar.extraViews`) are
untouched.

