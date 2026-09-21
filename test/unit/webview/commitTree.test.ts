import { describe, expect, it } from 'vitest';
import type { CommitChangeDto, CommitGroupDto, CommitStateDto } from '../../../src/shared/protocol';
import {
  assembleCommitTree,
  fileCountLabel,
  fileRowContext,
  splitDelta,
} from '../../../webview-ui/src/commit/commitTree';
import {
  countFiles,
  findNode,
  rollup,
  toggle,
  type TreeNode,
} from '../../../webview-ui/src/lib/treeModel';

/** Child row labels of a directory row — the repository rows, in tree order. */
function childNames(node: TreeNode | undefined): string[] {
  return node !== undefined && node.kind === 'dir' ? node.children.map((c) => c.name) : [];
}

function change(path: string, checked = false, kind: CommitChangeDto['kind'] = 'modified'): CommitChangeDto {
  return { path, code: '.M', kind, checked };
}

/** A default changelist for one repo, named as the service names it. */
function defaultList(changes: CommitChangeDto[], name = 'Changes'): CommitGroupDto {
  return { id: 'default', name, isActive: true, isDefault: true, checkable: true, changes };
}

function namedList(id: string, name: string, changes: CommitChangeDto[]): CommitGroupDto {
  return { id, name, isActive: false, isDefault: false, checkable: true, changes };
}

function repo(root: string, label: string, groups: CommitGroupDto[]) {
  return { root, label, groups };
}

function state(overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return {
    repos: [
      repo('D:/repos/demo', 'demo', [
        defaultList([change('api/a.ts', true), change('api/b.ts'), change('docs/x.md')]),
        {
          id: '__unversioned__',
          name: 'Unversioned Files',
          isActive: false,
          isDefault: false,
          checkable: false,
          changes: [change('api/new.ts', false, 'untracked')],
        },
      ]),
    ],
    activeRepo: 'D:/repos/demo',
    targets: ['demo'],
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

/** The two-repo shape the merge exists for. */
function twoRepos(second = defaultList([change('api/a.ts')])): CommitStateDto {
  return state({ repos: [...state().repos, repo('D:/repos/other', 'other', [second])] });
}

describe('assembleCommitTree groups map (P14-T2)', () => {
  it('maps every group row back to its changelist identity', () => {
    const model = assembleCommitTree(state());
    // One entry per group row, and exactly the group rows — a file path here
    // would make the native menu offer changelist actions on a file.
    expect([...model.groups.keys()].sort()).toEqual([...model.groupPaths].sort());
    const def = model.groups.get(model.groupPaths[0]!);
    expect(def).toEqual({
      kind: 'group',
      targets: [{ repoRoot: 'D:/repos/demo', listId: 'default' }],
      isDefault: true,
      checkable: true,
      repoRoot: 'D:/repos/demo',
      listId: 'default',
    });
    const unversioned = model.groups.get(model.groupPaths[1]!);
    expect(unversioned?.listId).toBe('__unversioned__');
    expect(unversioned?.isDefault).toBe(false);
    // Unversioned cannot take part in a commit, so shelve must not be offered.
    expect(unversioned?.checkable).toBe(false);
  });

  it('a single-root group row still names one repository, so scoped actions are unchanged', () => {
    const model = assembleCommitTree(state());
    for (const ref of model.groups.values()) {
      expect(ref.kind).toBe('group');
      expect(ref.repoRoot).toBe('D:/repos/demo');
      expect(ref.targets).toHaveLength(1);
    }
  });

  it('a merged group row carries every repository; each repo row carries one', () => {
    const model = assembleCommitTree(twoRepos());
    const group = model.groups.get('@g:@default');
    expect(group?.kind).toBe('group');
    expect(group?.targets).toEqual([
      { repoRoot: 'D:/repos/demo', listId: 'default' },
      { repoRoot: 'D:/repos/other', listId: 'default' },
    ]);
    // No single repoRoot: an action on this row fans out rather than guessing.
    expect(group?.repoRoot).toBeUndefined();

    const repoRow = model.groups.get('@g:@default@r:D:/repos/other');
    expect(repoRow?.kind).toBe('repo');
    expect(repoRow?.repoRoot).toBe('D:/repos/other');
    expect(repoRow?.listId).toBe('default');
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
    expect(findNode(model.nodes, '@g:@default/api')).toBeDefined();
  });

  it('namespaces node paths per group so identical directories do not collide', () => {
    const model = assembleCommitTree(state());
    // Both groups contain `api/`; they must be distinct expansion keys, or
    // expanding one would expand the other and their rollups would merge.
    const a = findNode(model.nodes, '@g:@default/api');
    const b = findNode(model.nodes, '@g:@unversioned/api');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('maps every leaf back to its repo and relative path', () => {
    const model = assembleCommitTree(state());
    const ref = model.files.get('@g:@default/api/a.ts');
    expect(ref).toEqual({
      repoRoot: 'D:/repos/demo',
      relPath: 'api/a.ts',
      change: change('api/a.ts', true),
    });
    expect(model.files.size).toBe(4);
  });

  it('marks a non-checkable group and its files checkbox-less', () => {
    const model = assembleCommitTree(state());
    expect(model.checkboxless.has('@g:@unversioned')).toBe(true);
    expect(model.checkboxless.has('@g:@unversioned/api/new.ts')).toBe(true);
    expect(model.checkboxless.has('@g:@default/api/a.ts')).toBe(false);
  });

  it('carries the checked set so the rollup reports partial', () => {
    const model = assembleCommitTree(state());
    const api = findNode(model.nodes, '@g:@default/api');
    expect(rollup(api!, model.checked)).toBe('partial');
    expect(rollup(model.nodes[0]!, model.checked)).toBe('partial');
  });
});

describe('assembleCommitTree — one changelist, many repositories (IntelliJ shape)', () => {
  it('shows a single Changes row with a repository row per contributor', () => {
    const model = assembleCommitTree(twoRepos());
    // The headline: NOT one `Changes` per repository.
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes', 'Unversioned Files']);

    const changes = model.nodes[0];
    expect(changes?.kind).toBe('dir');
    expect(childNames(changes)).toEqual(['demo', 'other']);
    expect(countFiles(changes!)).toBe(4);
  });

  it('merges Unversioned Files the same way', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          ...state().repos,
          repo('D:/repos/other', 'other', [
            defaultList([]),
            {
              id: '__unversioned__',
              name: 'Unversioned Files',
              isActive: false,
              isDefault: false,
              checkable: false,
              changes: [change('n.ts', false, 'untracked')],
            },
          ]),
        ],
      }),
    );
    const unversioned = model.nodes.find((n) => n.name === 'Unversioned Files');
    expect(unversioned).toBeDefined();
    expect(model.nodes.filter((n) => n.name === 'Unversioned Files')).toHaveLength(1);
    expect(childNames(unversioned)).toEqual(['demo', 'other']);
  });

  it('keeps the repository row even when its only change is nested', () => {
    // buildTree collapses single-child chains, so a repo whose one file is
    // `docs/x.md` would otherwise render as a single row reading `demo/docs`
    // and the repository row would vanish exactly when it matters most.
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [defaultList([change('docs/x.md')])]),
          repo('D:/repos/other', 'other', [defaultList([change('src/deep/y.ts')])]),
        ],
      }),
    );
    expect(childNames(model.nodes[0])).toEqual(['demo', 'other']);
    expect(findNode(model.nodes, '@g:@default@r:D:/repos/demo/docs')).toBeDefined();
  });

  it('a repository with nothing in the list contributes no row', () => {
    const model = assembleCommitTree(twoRepos(defaultList([])));
    expect(childNames(model.nodes[0])).toEqual(['demo']);
  });

  it('same relative path in two repos stays two distinct leaves', () => {
    const model = assembleCommitTree(twoRepos());
    expect(model.files.get('@g:@default@r:D:/repos/demo/api/a.ts')?.repoRoot).toBe('D:/repos/demo');
    expect(model.files.get('@g:@default@r:D:/repos/other/api/a.ts')?.repoRoot).toBe(
      'D:/repos/other',
    );
    expect(model.files.size).toBe(5);
  });

  it('merges user lists by name, and keeps differently-named ones apart', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [
            defaultList([]),
            // Ids are random per repo, so name is the only thing two repos agree on.
            namedList('cl-aaa', 'Feature X', [change('a.ts')]),
          ]),
          repo('D:/repos/other', 'other', [
            defaultList([]),
            namedList('cl-bbb', 'Feature X', [change('b.ts')]),
            namedList('cl-ccc', 'Feature Y', [change('c.ts')]),
          ]),
        ],
      }),
    );
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes', 'Feature X', 'Feature Y']);
    const featureX = model.groups.get('@g:name:Feature X');
    expect(featureX?.targets).toEqual([
      { repoRoot: 'D:/repos/demo', listId: 'cl-aaa' },
      { repoRoot: 'D:/repos/other', listId: 'cl-bbb' },
    ]);
  });

  it('merges the default list even when one repository renamed it', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [defaultList([change('a.ts')], 'Renamed')]),
          repo('D:/repos/other', 'other', [defaultList([change('b.ts')])]),
        ],
      }),
    );
    // Keyed by isDefault, not by name — a rename in one repo must not split the
    // one row every repository's new changes land in.
    expect(model.nodes).toHaveLength(1);
    expect(model.groups.get('@g:@default')?.targets).toHaveLength(2);
  });

  it('orders default first and Unversioned Files last', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [
            {
              id: '__unversioned__',
              name: 'Unversioned Files',
              isActive: false,
              isDefault: false,
              checkable: true,
              changes: [change('n.ts', false, 'untracked')],
            },
            namedList('cl-a', 'Feature X', [change('a.ts')]),
            defaultList([change('d.ts')]),
          ]),
        ],
      }),
    );
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes', 'Feature X', 'Unversioned Files']);
  });

  it('keeps exactly one empty default row however many roots are open', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/a', 'a', [defaultList([])]),
          repo('D:/repos/b', 'b', [defaultList([])]),
          repo('D:/repos/c', 'c', [defaultList([])]),
        ],
      }),
    );
    // The anchor row survives; it does not multiply by the number of repos.
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes']);
    expect(countFiles(model.nodes[0]!)).toBe(0);
  });

  it('skips empty non-default groups but keeps an empty default one', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [defaultList([]), namedList('other', 'Feature', [])]),
        ],
      }),
    );
    expect(model.nodes.map((n) => n.name)).toEqual(['Changes']);
  });
});

describe('splitDelta', () => {
  it('translates a folder toggle into repo-relative paths', () => {
    const model = assembleCommitTree(state());
    const api = findNode(model.nodes, '@g:@default/api');
    const delta = toggle(api!, 'partial');
    expect(splitDelta(delta, model)).toEqual([
      { repoRoot: 'D:/repos/demo', paths: ['api/a.ts', 'api/b.ts'], checked: true },
    ]);
  });

  it('drops checkbox-less paths so "check everything" cannot include them', () => {
    const model = assembleCommitTree(state());
    const unversioned = findNode(model.nodes, '@g:@unversioned');
    expect(splitDelta(toggle(unversioned!, 'unchecked'), model)).toEqual([]);
  });

  it('ticking one merged group splits into a call per repository', () => {
    const model = assembleCommitTree(twoRepos());
    const changes = findNode(model.nodes, '@g:@default');
    const parts = splitDelta(toggle(changes!, 'unchecked'), model);
    expect(parts.map((p) => p.repoRoot).sort()).toEqual(['D:/repos/demo', 'D:/repos/other']);
    expect(parts.every((p) => p.checked)).toBe(true);
    // Repo-relative, never the namespaced tree path.
    expect(parts.flatMap((p) => p.paths).every((p) => !p.startsWith('@g:'))).toBe(true);
  });

  it('splits one gesture into a call per repository', () => {
    const model = assembleCommitTree(twoRepos(defaultList([change('z.ts')])));
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

describe('fileRowContext (POST-P14v)', () => {
  /** Tree path of a file row, found by the repo-relative path it stands for. */
  function pathOf(model: ReturnType<typeof assembleCommitTree>, relPath: string): string {
    const hit = [...model.files.entries()].find(([, f]) => f.relPath === relPath);
    if (!hit) throw new Error(`no row for ${relPath}`);
    return hit[0];
  }

  it('carries only the clicked row when nothing is selected', () => {
    const model = assembleCommitTree(state());
    const ctx = fileRowContext(model, pathOf(model, 'api/a.ts'), new Set());
    expect(ctx).toMatchObject({
      webviewSection: 'commitFile',
      repoRoot: 'D:/repos/demo',
      relPath: 'api/a.ts',
      relPaths: ['api/a.ts'],
      fileUnversioned: false,
    });
  });

  it('carries the whole selection when the click lands inside it', () => {
    const model = assembleCommitTree(state());
    const a = pathOf(model, 'api/a.ts');
    const b = pathOf(model, 'api/b.ts');
    const ctx = fileRowContext(model, a, new Set([a, b]));
    // Tree order, not click order: this is what the menu's label counts and
    // what a rollback confirmation lists.
    expect(ctx?.['relPaths']).toEqual(['api/a.ts', 'api/b.ts']);
  });

  it('ignores a selection the click landed outside of', () => {
    const model = assembleCommitTree(state());
    const ctx = fileRowContext(
      model,
      pathOf(model, 'docs/x.md'),
      new Set([pathOf(model, 'api/a.ts'), pathOf(model, 'api/b.ts')]),
    );
    expect(ctx?.['relPaths']).toEqual(['docs/x.md']);
  });

  it('flags a selection as unversioned only when every file is', () => {
    const model = assembleCommitTree(state());
    const tracked = pathOf(model, 'api/a.ts');
    const untracked = pathOf(model, 'api/new.ts');
    expect(fileRowContext(model, untracked, new Set())?.['fileUnversioned']).toBe(true);
    // The gate for Add to VCS / Add to .gitignore: a mixed selection would
    // half-apply, so the menu must not offer either.
    expect(
      fileRowContext(model, untracked, new Set([tracked, untracked]))?.['fileUnversioned'],
    ).toBe(false);
  });

  it('never crosses a repository boundary', () => {
    const model = assembleCommitTree(twoRepos());
    const mine = [...model.files.entries()].filter(([, f]) => f.repoRoot === 'D:/repos/demo');
    const theirs = [...model.files.entries()].filter(([, f]) => f.repoRoot === 'D:/repos/other');
    const clicked = mine[0]![0];
    const ctx = fileRowContext(
      model,
      clicked,
      new Set([clicked, mine[1]![0], theirs[0]![0]]),
    );
    expect(ctx?.['repoRoot']).toBe('D:/repos/demo');
    // Every `gittree.*` file command takes one repoRoot; the other repo's row
    // would silently be dropped by the host instead of here.
    expect(ctx?.['relPaths']).toEqual([mine[0]![1].relPath, mine[1]![1].relPath]);
  });

  it('has nothing to say about a directory row', () => {
    const model = assembleCommitTree(state());
    expect(fileRowContext(model, model.groupPaths[0]!, new Set())).toBeUndefined();
  });
});
