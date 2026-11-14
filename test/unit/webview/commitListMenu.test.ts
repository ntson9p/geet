/**
 * POST-P14cf: the Commit list as a whole. The tick-all box on the counter, and
 * the payload of the list's blank space, whose native menu acts on every change
 * the list shows (New Changelist… while changelist rows are drawn, Tick All /
 * Untick All, Stage All / Unstage All with staging, Expand / Collapse All, Show
 * All Repositories while narrowed, Refresh). The menu's items and their order
 * are commitWindowMenus.test.ts's; what the page does with them, commit.spec.ts's.
 */
import { describe, expect, it } from 'vitest';
import {
  CONFLICTS_GROUP_ID,
  STAGED_GROUP_ID,
  UNSTAGED_GROUP_ID,
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitFilterRepoDto,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitStateDto,
} from '../../../src/shared/protocol';
import { assembleCommitTree, listContext, tickAllState } from '../../../webview-ui/src/commit/commitTree';

const API = 'D:/repos/api';
const WEB = 'D:/repos/web';

function change(path: string, checked: boolean, kind: CommitChangeDto['kind'] = 'modified'): CommitChangeDto {
  return { path, code: '.M', kind, checked };
}

function group(id: string, name: string, changes: CommitChangeDto[], checkable = true): CommitGroupDto {
  return { id, name, isActive: id === 'default', isDefault: id === 'default', checkable, changes };
}

function repo(root: string, label: string, groups: CommitGroupDto[]): CommitRepoDto {
  return { root, label, colorIdx: 0, head: { branch: 'main' }, groups };
}

const api = (ticked: [boolean, boolean, boolean]): CommitRepoDto =>
  repo(API, 'api', [
    group('default', 'Changes', [change('src/a.ts', ticked[0]), change('src/b.ts', ticked[1])]),
    group(UNVERSIONED_GROUP_ID, 'Unversioned Files', [change('notes.md', ticked[2], 'untracked')]),
  ]);
const web = (ticked: boolean): CommitRepoDto =>
  repo(WEB, 'web', [group('default', 'Changes', [change('index.html', ticked)])]);

function state(repos: CommitRepoDto[], overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return {
    repos,
    targets: [],
    message: '',
    amend: false,
    signing: false,
    busy: false,
    modifiedCount: 0,
    checkedCount: 0,
    paradigm: 'changelists',
    ...overrides,
  };
}

const summary = (r: CommitRepoDto): CommitFilterRepoDto => ({
  root: r.root,
  label: r.label,
  colorIdx: 0,
  changes: r.groups.flatMap((g) => g.changes).length,
  ticked: r.groups.flatMap((g) => g.changes).filter((c) => c.checked).length,
});

describe('the tick-all box (POST-P14cf)', () => {
  it('counts every box in the list, new files too, and says how many are ticked', () => {
    expect(tickAllState(assembleCommitTree(state([api([true, false, false]), web(true)])))).toEqual({
      total: 4,
      ticked: 2,
      state: 'partial',
    });
  });

  it('is ticked with every box ticked, and empty with none', () => {
    expect(tickAllState(assembleCommitTree(state([api([true, true, true]), web(true)])))?.state).toBe('checked');
    expect(tickAllState(assembleCommitTree(state([api([false, false, false]), web(false)])))?.state).toBe('unchecked');
  });

  it('leaves out a merge conflict, which has no box', () => {
    const conflicted = repo(API, 'api', [
      group(CONFLICTS_GROUP_ID, 'Merge Conflicts', [change('both.ts', false, 'conflicted')], false),
      group('default', 'Changes', [change('src/a.ts', true)]),
    ]);
    expect(tickAllState(assembleCommitTree(state([conflicted])))).toEqual({ total: 1, ticked: 1, state: 'checked' });
  });

  it('is empty with nothing listed', () => {
    expect(tickAllState(assembleCommitTree(state([repo(API, 'api', [group('default', 'Changes', [])])])))).toEqual({
      total: 0,
      ticked: 0,
      state: 'unchecked',
    });
  });

  it('is not there with staging, where a change goes in by being staged', () => {
    const staged = repo(API, 'api', [group(STAGED_GROUP_ID, 'Staged', [change('src/a.ts', true)], false)]);
    expect(tickAllState(assembleCommitTree(state([staged], { paradigm: 'staging' })))).toBeUndefined();
  });

  it('counts only what a narrowed list shows', () => {
    const shown = api([true, false, false]);
    const hidden = web(true);
    const narrowed = state([shown], { filter: { shown: [summary(shown)], hidden: [summary(hidden)] } });
    expect(tickAllState(assembleCommitTree(narrowed))).toEqual({ total: 3, ticked: 1, state: 'partial' });
  });
});

describe("the list's blank space: its menu's payload (POST-P14cf)", () => {
  const roots = { narrowed: false, roots: [API, WEB] };

  it('names its own section, keeps VS Code’s Cut, Copy and Paste out, and the repositories it reaches', () => {
    const ctx = listContext(assembleCommitTree(state([api([true, false, false]), web(true)])), roots);
    expect(ctx).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitList',
      listShowsChangelists: false,
      listHasUnticked: true,
      listHasTicked: true,
      listCanStage: false,
      listCanUnstage: false,
      listCanFold: true,
      listNarrowed: false,
      listRoots: [API, WEB],
    });
  });

  it('offers Tick All only with something unticked, Untick All only with something ticked', () => {
    const all = listContext(assembleCommitTree(state([api([true, true, true]), web(true)])), roots);
    expect([all['listHasUnticked'], all['listHasTicked']]).toEqual([false, true]);
    const none = listContext(assembleCommitTree(state([api([false, false, false]), web(false)])), roots);
    expect([none['listHasUnticked'], none['listHasTicked']]).toEqual([true, false]);
  });

  it('offers New Changelist… only while changelist rows are drawn, either grouping', () => {
    const byList = assembleCommitTree(state([api([true, false, false]), web(true)], { groupBy: 'changelist' }));
    expect(listContext(byList, roots)['listShowsChangelists']).toBe(true);
    const byRepo = assembleCommitTree(state([api([true, false, false]), web(true)], { groupBy: 'repository' }));
    expect(listContext(byRepo, roots)['listShowsChangelists']).toBe(true);
    const plain = assembleCommitTree(state([api([true, false, false]), web(true)], { groupBy: 'none' }));
    expect(listContext(plain, roots)['listShowsChangelists']).toBe(false);
  });

  it('offers Expand and Collapse All only with rows that fold', () => {
    // One repository, its files in a list: nothing folds.
    const flat = assembleCommitTree(state([api([true, false, false])]));
    expect(listContext(flat, { narrowed: false, roots: [API] })['listCanFold']).toBe(false);
    const folders = assembleCommitTree(state([api([true, false, false])], { groupByDirectory: true }));
    expect(listContext(folders, { narrowed: false, roots: [API] })['listCanFold']).toBe(true);
  });

  it('with staging, offers Stage All and Unstage All by what there is, and no ticks or changelists', () => {
    const halves = repo(API, 'api', [
      group(STAGED_GROUP_ID, 'Staged', [change('src/a.ts', true)], false),
      group(UNSTAGED_GROUP_ID, 'Unstaged', [change('src/b.ts', false)], false),
    ]);
    const ctx = listContext(assembleCommitTree(state([halves], { paradigm: 'staging', groupBy: 'changelist' })), {
      narrowed: false,
      roots: [API],
    });
    expect(ctx).toMatchObject({
      listShowsChangelists: false,
      listHasUnticked: false,
      listHasTicked: false,
      listCanStage: true,
      listCanUnstage: true,
    });
    const onlyNew = repo(API, 'api', [group(UNVERSIONED_GROUP_ID, 'Unversioned Files', [change('n.txt', false, 'untracked')], false)]);
    expect(
      listContext(assembleCommitTree(state([onlyNew], { paradigm: 'staging' })), { narrowed: false, roots: [API] }),
    ).toMatchObject({ listCanStage: true, listCanUnstage: false });
  });

  it('offers Show All Repositories while narrowed, and reaches only the repositories shown', () => {
    const shown = api([true, false, false]);
    const narrowed = state([shown], { filter: { shown: [summary(shown)], hidden: [summary(web(true))] } });
    expect(listContext(assembleCommitTree(narrowed), { narrowed: true, roots: [API] })).toMatchObject({
      listNarrowed: true,
      listRoots: [API],
    });
  });
});
