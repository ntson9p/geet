/**
 * POST-QA F5: the Commit window's tree in the staging paradigm — rows know
 * their half, so a file staged in part opens, walks and is found as the row
 * the user means, and its menu offers Stage or Unstage.
 */
import { describe, expect, it } from 'vitest';
import {
  STAGED_GROUP_ID,
  UNSTAGED_GROUP_ID,
  UNVERSIONED_GROUP_ID,
  type CommitGroupDto,
  type CommitStateDto,
} from '../../../src/shared/protocol';
import {
  allDiffFiles,
  assembleCommitTree,
  fileRowContext,
  fileSide,
  groupRowContext,
  treePathOf,
} from '../../../webview-ui/src/commit/commitTree';
import type { TreeNode } from '../../../webview-ui/src/lib/treeModel';

const ROOT = 'D:/repos/demo';

function group(id: string, name: string, paths: string[], checked: boolean): CommitGroupDto {
  return {
    id,
    name,
    isActive: false,
    isDefault: false,
    checkable: false,
    changes: paths.map((path) => ({ path, code: checked ? 'M.' : '.M', kind: 'modified', checked })),
  };
}

function state(paradigm: 'staging' | 'changelists'): CommitStateDto {
  return {
    repos: [
      {
        root: ROOT,
        label: 'demo',
        colorIdx: 0,
        groups: [
          group(STAGED_GROUP_ID, 'Staged', ['both.ts', 'only-staged.ts'], true),
          group(UNSTAGED_GROUP_ID, 'Unstaged', ['both.ts'], false),
          group(UNVERSIONED_GROUP_ID, 'Unversioned Files', ['new.ts'], false),
        ],
      },
    ],
    targets: ['demo'],
    message: '',
    amend: false,
    signing: false,
    busy: false,
    modifiedCount: 3,
    checkedCount: 2,
    paradigm,
  };
}

describe('the staging-mode Commit tree', () => {
  const model = assembleCommitTree(state('staging'));

  it('draws no checkbox anywhere: files, folders and node rows', () => {
    const deep = assembleCommitTree({
      ...state('staging'),
      repos: [{ root: ROOT, label: 'demo', colorIdx: 0, groups: [group(UNSTAGED_GROUP_ID, 'Unstaged', ['src/a/x.ts', 'src/b/y.ts'], false)] }],
    });
    const all: string[] = [];
    const walk = (nodes: readonly TreeNode[]): void => {
      for (const n of nodes) {
        all.push(n.path);
        if (n.kind === 'dir') walk(n.children);
      }
    };
    walk(deep.nodes);
    expect(all.length).toBeGreaterThan(4);
    for (const path of all) expect(deep.checkboxless.has(path), path).toBe(true);
    for (const path of model.files.keys()) expect(model.checkboxless.has(path)).toBe(true);
  });

  it('gives each row of a file staged in part its own half', () => {
    const sides = [...model.files.values()].filter((f) => f.relPath === 'both.ts').map(fileSide).sort();
    expect(sides).toEqual(['staged', 'unstaged']);
  });

  it('walks and finds the half a row stands for', () => {
    expect(allDiffFiles(model)).toEqual([
      { repoRoot: ROOT, path: 'both.ts', side: 'staged' },
      { repoRoot: ROOT, path: 'only-staged.ts', side: 'staged' },
      { repoRoot: ROOT, path: 'both.ts', side: 'unstaged' },
      { repoRoot: ROOT, path: 'new.ts', side: 'unversioned' },
    ]);
    const unstagedRow = treePathOf(model, { repoRoot: ROOT, path: 'both.ts', side: 'unstaged' });
    expect(unstagedRow).toBeDefined();
    expect(fileSide(model.files.get(unstagedRow!)!)).toBe('unstaged');
    expect(fileSide(model.files.get(treePathOf(model, { repoRoot: ROOT, path: 'both.ts', side: 'staged' })!)!)).toBe(
      'staged',
    );
  });

  it('tells the row menus which half they are on', () => {
    const staged = treePathOf(model, { repoRoot: ROOT, path: 'only-staged.ts', side: 'staged' })!;
    expect(fileRowContext(model, staged, new Set())).toMatchObject({ stagingSide: 'staged' });
    const groupRows = [...model.groups.entries()].map(([p]) => groupRowContext(model, p)?.stagingSide).sort();
    expect(groupRows).toEqual(['staged', 'unstaged', 'unversioned']);
  });
});

describe('the same tree with changelists', () => {
  it('carries no half at all, even on Unversioned Files', () => {
    const model = assembleCommitTree(state('changelists'));
    expect([...model.files.values()].every((f) => fileSide(f) === undefined)).toBe(true);
    expect(allDiffFiles(model).every((f) => !('side' in f))).toBe(true);
    for (const p of model.groups.keys()) expect(groupRowContext(model, p)).not.toHaveProperty('stagingSide');
  });
});
