/**
 * The Repositories panel's two panes (new-way-6), with several repositories:
 * REPOSITORIES over BRANCHES, each with a header that folds it and a list that
 * scrolls on its own, and a divider between them that the pointer drags. The
 * shape is VS Code's own panes: an open pane fills what the other leaves, a
 * shut one is its header alone, and the header of a shut pane under an open
 * one sits at the bottom.
 *
 * Pure: the sizes are worked out here, from numbers, so every rule is
 * unit-tested; `App.tsx` measures and draws.
 */
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';
import { REPO, ROW, TABS } from './model';

/** A pane header's height: VS Code's own (`--pane-header-size`). */
export const PANE_HEADER = 22;

/**
 * The panes' fold state lives in the panel's `toggled` set, as the folders'
 * does. `sec:repos` is the id the REPOSITORIES section had when it was a row of
 * the one list, so a section folded before is a pane folded now.
 */
export const REPOS_PANE = 'sec:repos';
export const BRANCHES_PANE = 'sec:branches';

export type PaneId = 'repos' | 'branches';

export function paneToggleId(pane: PaneId): string {
  return pane === 'repos' ? REPOS_PANE : BRANCHES_PANE;
}

/** Both panes are open until folded. */
export function paneOpen(toggled: ReadonlySet<string>, pane: PaneId): boolean {
  return !toggled.has(paneToggleId(pane));
}

/** `toggled` with the pane opened or shut; the same set when nothing changes. */
export function withPane(toggled: ReadonlySet<string>, pane: PaneId, open: boolean): ReadonlySet<string> {
  if (paneOpen(toggled, pane) === open) return toggled;
  const next = new Set(toggled);
  if (open) next.delete(paneToggleId(pane));
  else next.add(paneToggleId(pane));
  return next;
}

/** REPOSITORIES never drags below one repository's row. */
export const REPOS_MIN = REPO;
/** BRANCHES never drags below its tabs and two rows. */
export const BRANCHES_MIN = TABS + 2 * ROW;
/** Until the divider is dragged, REPOSITORIES takes up to this share, and no more than it needs. */
export const REPOS_SHARE = 0.4;

export interface PaneLayoutInput {
  /** The height both panes share, headers included. */
  readonly total: number;
  readonly reposOpen: boolean;
  readonly branchesOpen: boolean;
  /** What every repository row (and banner) adds up to. */
  readonly reposContent: number;
  /** The REPOSITORIES list's height the divider was dragged to; none: the automatic one. */
  readonly reposSize?: number;
}

export interface PaneLayout {
  /** The REPOSITORIES list's height; 0 while it is folded. */
  readonly reposBody: number;
  /** The BRANCHES list's height; 0 while it is folded. */
  readonly branchesBody: number;
  /** The divider is there to drag: both panes are open. */
  readonly sash: boolean;
}

/**
 * The REPOSITORIES list's height with both panes open: what was asked for (the
 * dragged size, else the automatic share), never past its last row, never so
 * tall that BRANCHES drops below its minimum, and never below one row — the
 * minimums giving way, REPOSITORIES' last, only when the panel is too short to
 * keep both.
 */
export function reposBodyHeight(bodies: number, reposContent: number, reposSize?: number): number {
  const content = Math.max(0, reposContent);
  const wanted = reposSize ?? Math.min(content, Math.round(bodies * REPOS_SHARE));
  const most = Math.min(content, bodies - BRANCHES_MIN);
  const least = Math.min(REPOS_MIN, content, bodies);
  return Math.max(0, Math.round(Math.max(least, Math.min(wanted, most))));
}

export function paneLayout(input: PaneLayoutInput): PaneLayout {
  const bodies = Math.max(0, input.total - 2 * PANE_HEADER);
  if (input.reposOpen && input.branchesOpen) {
    const reposBody = reposBodyHeight(bodies, input.reposContent, input.reposSize);
    return { reposBody, branchesBody: Math.max(0, bodies - reposBody), sash: true };
  }
  // One pane open fills the panel, as an expanded view does; none open leaves the headers.
  return {
    reposBody: input.reposOpen ? bodies : 0,
    branchesBody: input.branchesOpen ? bodies : 0,
    sash: false,
  };
}

/**
 * What the REPOSITORIES header says the panel is narrowed to: the repositories
 * picked, in the panel's order; none while every repository is shown.
 */
export function selectedRepos(
  repos: readonly BranchPanelRepoDto[],
  scopeRepos: readonly BranchPanelRepoDto[],
): readonly BranchPanelRepoDto[] {
  return scopeRepos.length < repos.length ? scopeRepos : [];
}

/** The header label's hover, and what a screen reader hears of it. */
export function selectionTitle(selected: readonly BranchPanelRepoDto[]): string {
  return `Showing the branches of ${selected.map((r) => r.label).join(', ')}`;
}
