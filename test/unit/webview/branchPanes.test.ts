/**
 * The Repositories panel's two panes (new-way-6): REPOSITORIES over BRANCHES,
 * each folding at its header, the divider between them sharing the height.
 * The owner's twenty repositories pushed the branches out of sight when both
 * were one list; now each pane scrolls on its own and the divider decides.
 */
import { describe, expect, it } from 'vitest';
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';
import { REPO, ROW, TABS } from '../../../webview-ui/src/branches/model';
import {
  BRANCHES_MIN,
  BRANCHES_PANE,
  PANE_HEADER,
  paneLayout,
  paneOpen,
  paneToggleId,
  REPOS_MIN,
  REPOS_PANE,
  REPOS_SHARE,
  reposBodyHeight,
  selectedRepos,
  selectionTitle,
  withPane,
} from '../../../webview-ui/src/branches/paneLayout';

function repo(root: string, label: string): BranchPanelRepoDto {
  return {
    root,
    label,
    colorIdx: 0,
    detached: false,
    unborn: false,
    changes: 0,
    fetching: false,
    locals: [],
    remotes: [],
    tags: [],
    recent: [],
    favorites: [],
    merged: [],
  };
}

describe('the panes, folded and open', () => {
  it('are both open until folded, and keep the id the REPOSITORIES section had', () => {
    const none = new Set<string>();
    expect(paneOpen(none, 'repos')).toBe(true);
    expect(paneOpen(none, 'branches')).toBe(true);
    // A section folded in the one list of before is a pane folded now.
    expect(REPOS_PANE).toBe('sec:repos');
    expect(paneOpen(new Set(['sec:repos']), 'repos')).toBe(false);
    expect(paneToggleId('branches')).toBe(BRANCHES_PANE);
  });

  it('fold and open through the set the folders use, leaving the folders alone', () => {
    const folders = new Set(['dir:local:feature/']);
    const shut = withPane(folders, 'branches', false);
    expect([...shut].sort()).toEqual([BRANCHES_PANE, 'dir:local:feature/']);
    expect(paneOpen(shut, 'branches')).toBe(false);
    expect(paneOpen(shut, 'repos')).toBe(true);
    const open = withPane(shut, 'branches', true);
    expect([...open]).toEqual(['dir:local:feature/']);
  });

  it('hand back the same set when nothing changes, so no render follows', () => {
    const toggled = new Set([REPOS_PANE]);
    expect(withPane(toggled, 'repos', false)).toBe(toggled);
    expect(withPane(toggled, 'branches', true)).toBe(toggled);
  });
});

describe('the panes’ heights', () => {
  // 600px of panel under the toolbar: 556 for the two lists, past two headers.
  const total = 600;
  const bodies = total - 2 * PANE_HEADER;

  it('are headed as VS Code heads a view, and never drag past a row of repositories or the tabs and two rows of branches', () => {
    expect(PANE_HEADER).toBe(22);
    expect(REPOS_MIN).toBe(REPO);
    expect(BRANCHES_MIN).toBe(TABS + 2 * ROW);
  });

  it('give REPOSITORIES what its rows need while that is a modest share', () => {
    const three = 3 * REPO;
    const layout = paneLayout({ total, reposOpen: true, branchesOpen: true, reposContent: three });
    expect(layout).toEqual({ reposBody: three, branchesBody: bodies - three, sash: true });
  });

  it('give twenty repositories their share and no more, so the branches keep most of the panel', () => {
    const twenty = 20 * REPO;
    const layout = paneLayout({ total, reposOpen: true, branchesOpen: true, reposContent: twenty });
    expect(layout.reposBody).toBe(Math.round(bodies * REPOS_SHARE));
    expect(layout.reposBody).toBeLessThan(twenty);
    expect(layout.reposBody + layout.branchesBody).toBe(bodies);
  });

  it('follow the divider once dragged', () => {
    const layout = paneLayout({
      total,
      reposOpen: true,
      branchesOpen: true,
      reposContent: 20 * REPO,
      reposSize: 300,
    });
    expect(layout.reposBody).toBe(300);
    expect(layout.branchesBody).toBe(bodies - 300);
  });

  it('stop the divider at the last repository, at one repository, and short of crowding the branches', () => {
    expect(reposBodyHeight(bodies, 3 * REPO, 400)).toBe(3 * REPO);
    expect(reposBodyHeight(bodies, 20 * REPO, 5)).toBe(REPOS_MIN);
    // Forty repositories would fill the panel: the branches keep their tabs and two rows.
    expect(reposBodyHeight(bodies, 40 * REPO, 10_000)).toBe(bodies - BRANCHES_MIN);
  });

  it('give way in a panel too short for both minimums, the branches first, and never below nothing', () => {
    // 60px of lists: the branches' minimum cannot be kept, one repository can.
    expect(reposBodyHeight(60, 20 * REPO)).toBe(REPOS_MIN);
    expect(reposBodyHeight(10, 20 * REPO)).toBe(10);
    expect(reposBodyHeight(0, 20 * REPO)).toBe(0);
    expect(paneLayout({ total: 30, reposOpen: true, branchesOpen: true, reposContent: 100 })).toEqual({
      reposBody: 0,
      branchesBody: 0,
      sash: true,
    });
  });

  it('let the open pane fill the panel while the other is folded, with no divider to drag', () => {
    expect(paneLayout({ total, reposOpen: true, branchesOpen: false, reposContent: 3 * REPO })).toEqual({
      reposBody: bodies,
      branchesBody: 0,
      sash: false,
    });
    expect(paneLayout({ total, reposOpen: false, branchesOpen: true, reposContent: 3 * REPO })).toEqual({
      reposBody: 0,
      branchesBody: bodies,
      sash: false,
    });
    expect(paneLayout({ total, reposOpen: false, branchesOpen: false, reposContent: 3 * REPO })).toEqual({
      reposBody: 0,
      branchesBody: 0,
      sash: false,
    });
  });

  it('keep a dragged size for when both are open again', () => {
    const folded = paneLayout({
      total,
      reposOpen: true,
      branchesOpen: false,
      reposContent: 20 * REPO,
      reposSize: 120,
    });
    expect(folded.reposBody).toBe(bodies);
    const reopened = paneLayout({
      total,
      reposOpen: true,
      branchesOpen: true,
      reposContent: 20 * REPO,
      reposSize: 120,
    });
    expect(reopened.reposBody).toBe(120);
  });
});

describe('the REPOSITORIES header’s label', () => {
  const api = repo('/api', 'api');
  const shared = repo('/shared', 'shared');
  const web = repo('/web', 'web');
  const all = [api, shared, web];

  it('says nothing while every repository is shown', () => {
    expect(selectedRepos(all, all)).toEqual([]);
  });

  it('names the repository picked, or each of those picked, in the panel’s order', () => {
    expect(selectedRepos(all, [web])).toEqual([web]);
    expect(selectedRepos(all, [api, web])).toEqual([api, web]);
  });

  it('says on hover what the pick does', () => {
    expect(selectionTitle([web])).toBe('Showing the branches of web');
    expect(selectionTitle([api, web])).toBe('Showing the branches of api, web');
  });
});
