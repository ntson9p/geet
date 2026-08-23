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
| [D1](#d1--differences-viewer) | Diffs use VS Code's diff editor, not IntelliJ's Differences Viewer | **Yes — planned, see below** |
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
between C and B based on whether the per-change arrows matter more than editor fidelity. A
plausible `PHASE-14-differences-viewer.md` would be: T1 Route A · T2 inclusion/change-list
strip (C) · T3 decision gate on B with a spike measuring bundle cost and large-file
performance · T4–T6 the renderer if the gate passes · T7 accessibility parity · T8 fallback
rules and docs.

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
