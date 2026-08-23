import { describe, expect, it } from 'vitest';
import type { CommitChangeDto, CommitStateDto } from '../../../src/shared/protocol';
import {
  assembleCommitTree,
  fileCountLabel,
  splitDelta,
} from '../../../webview-ui/src/commit/commitTree';
import { countFiles, findNode, flatten, rollup, toggle } from '../../../webview-ui/src/lib/treeModel';

function change(path: string, checked = false, kind: CommitChangeDto['kind'] = 'modified'): CommitChangeDto {
  return { path, code: '.M', kind, checked };
}

function state(overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return {
    repos: [
      {
        root: 'D:/repos/demo',
        label: 'demo',
        groups: [
          {
            id: 'default',
            name: 'Changes',
            isActive: true,
            isDefault: true,
            checkable: true,
            changes: [change('api/a.ts', true), change('api/b.ts'), change('docs/x.md')],
          },
          {
            id: '__unversioned__',
            name: 'Unversioned Files',
            isActive: false,
            isDefault: false,
            checkable: false,
            changes: [change('api/new.ts', false, 'untracked')],
          },
        ],
      },
    ],
    activeRepo: 'D:/repos/demo',
    message: '',
    amend: false,
    signing: false,
    busy: false,
    modifiedCount: 4,
    checkedCount: 1,
    paradigm: 'changelists',
    ...overrides,
  };
}

function labels(model: ReturnType<typeof assembleCommitTree>): string[] {
  return flatten(model.nodes, new Set(model.nodes.flatMap(() => []))).map((r) => r.node.name);
}

describe('assembleCommitTree groups map (P14-T2)', () => {
  it('maps every group row back to its changelist identity', () => {
    const model = assembleCommitTree(state());
    // One entry per group row, and exactly the group rows — a file path here
    // would make the native menu offer changelist actions on a file.
    expect([...model.groups.keys()].sort()).toEqual([...model.groupPaths].sort());
    const def = model.groups.get(model.groupPaths[0]!);
    expect(def).toEqual({
      repoRoot: 'D:/repos/demo',
      groupId: 'default',
      isDefault: true,
      checkable: true,
    });
    const unversioned = model.groups.get(model.groupPaths[1]!);
    expect(unversioned?.groupId).toBe('__unversioned__');
    expect(unversioned?.isDefault).toBe(false);
    // Unversioned cannot take part in a commit, so shelve must not be offered.
    expect(unversioned?.checkable).toBe(false);
  });

  it('keeps group identity distinct per repo when two repos share a list id', () => {
    const s = state();
    const second = { ...s.repos[0]!, root: 'D:/repos/other', label: 'other' };
    const model = assembleCommitTree({ ...s, repos: [s.repos[0]!, second] });
    const roots = [...model.groups.values()].map((g) => g.repoRoot);
    expect(new Set(roots)).toEqual(new Set(['D:/repos/demo', 'D:/repos/other']));
    expect(model.groups.size).toBe(4);
  });

  it('never returns a group ref for a file row', () => {
    const model = assembleCommitTree(state());
    for (const filePath of model.files.keys()) {
      expect(model.groups.get(filePath)).toBeUndefined();
    }
  });
});

describe('assembleCommitTree', () => {
  it('produces one group row per changelist with folder rows beneath', () => {
    const model = assembleCommitTree(state());
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes', 'Unversioned Files']);
    const changes = model.nodes[0];
    expect(changes?.kind).toBe('dir');
    expect(countFiles(changes!)).toBe(3);
    expect(findNode(model.nodes, '@g:D:/repos/demo:default/api')).toBeDefined();
  });

  it('namespaces node paths per group so identical directories do not collide', () => {
    const model = assembleCommitTree(state());
    // Both groups contain `api/`; they must be distinct expansion keys, or
    // expanding one would expand the other and their rollups would merge.
    const a = findNode(model.nodes, '@g:D:/repos/demo:default/api');
    const b = findNode(model.nodes, '@g:D:/repos/demo:__unversioned__/api');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('maps every leaf back to its repo and relative path', () => {
    const model = assembleCommitTree(state());
    const ref = model.files.get('@g:D:/repos/demo:default/api/a.ts');
    expect(ref).toEqual({
      repoRoot: 'D:/repos/demo',
      relPath: 'api/a.ts',
      change: change('api/a.ts', true),
    });
    expect(model.files.size).toBe(4);
  });

  it('marks a non-checkable group and its files checkbox-less', () => {
    const model = assembleCommitTree(state());
    expect(model.checkboxless.has('@g:D:/repos/demo:__unversioned__')).toBe(true);
    expect(model.checkboxless.has('@g:D:/repos/demo:__unversioned__/api/new.ts')).toBe(true);
    expect(model.checkboxless.has('@g:D:/repos/demo:default/api/a.ts')).toBe(false);
  });

  it('carries the checked set so the rollup reports partial', () => {
    const model = assembleCommitTree(state());
    const api = findNode(model.nodes, '@g:D:/repos/demo:default/api');
    expect(rollup(api!, model.checked)).toBe('partial');
    expect(rollup(model.nodes[0]!, model.checked)).toBe('partial');
  });

  it('adds a repo folder row only when the workspace has several roots', () => {
    const single = assembleCommitTree(state());
    expect(labels(single)).not.toContain('demo');

    const multi = assembleCommitTree(
      state({
        repos: [
          ...state().repos,
          {
            root: 'D:/repos/other',
            label: 'other',
            groups: [
              {
                id: 'default',
                name: 'Changes',
                isActive: true,
                isDefault: true,
                checkable: true,
                changes: [change('api/a.ts')],
              },
            ],
          },
        ],
      }),
    );
    // Same relative path in two repos must stay two distinct leaves.
    expect(multi.files.size).toBe(5);
    const roots = [...multi.files.values()].map((f) => f.repoRoot);
    expect(new Set(roots).size).toBe(2);
  });

  it('skips empty non-default groups but keeps an empty default one', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          {
            root: 'D:/repos/demo',
            label: 'demo',
            groups: [
              { id: 'default', name: 'Changes', isActive: true, isDefault: true, checkable: true, changes: [] },
              { id: 'other', name: 'Feature', isActive: false, isDefault: false, checkable: true, changes: [] },
            ],
          },
        ],
      }),
    );
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes']);
  });
});

describe('splitDelta', () => {
  it('translates a folder toggle into repo-relative paths', () => {
    const model = assembleCommitTree(state());
    const api = findNode(model.nodes, '@g:D:/repos/demo:default/api');
    const delta = toggle(api!, 'partial');
    expect(splitDelta(delta, model)).toEqual([
      { repoRoot: 'D:/repos/demo', paths: ['api/a.ts', 'api/b.ts'], checked: true },
    ]);
  });

  it('drops checkbox-less paths so "check everything" cannot include them', () => {
    const model = assembleCommitTree(state());
    const unversioned = findNode(model.nodes, '@g:D:/repos/demo:__unversioned__');
    expect(splitDelta(toggle(unversioned!, 'unchecked'), model)).toEqual([]);
  });

  it('splits one gesture into a call per repository', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          ...state().repos,
          {
            root: 'D:/repos/other',
            label: 'other',
            groups: [
              {
                id: 'default',
                name: 'Changes',
                isActive: true,
                isDefault: true,
                checkable: true,
                changes: [change('z.ts')],
              },
            ],
          },
        ],
      }),
    );
    const all = { paths: [...model.files.keys()], next: true };
    const parts = splitDelta(all, model);
    expect(parts.map((p) => p.repoRoot).sort()).toEqual(['D:/repos/demo', 'D:/repos/other']);
    expect(parts.every((p) => p.checked)).toBe(true);
  });
});

describe('fileCountLabel', () => {
  it('matches IntelliJ wording', () => {
    expect(fileCountLabel(1)).toBe('1 file');
    expect(fileCountLabel(4)).toBe('4 files');
    expect(fileCountLabel(0)).toBe('0 files');
  });
});
