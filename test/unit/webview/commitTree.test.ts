import { describe, expect, it } from 'vitest';
import type { CommitChangeDto, CommitGroupDto, CommitStateDto } from '../../../src/shared/protocol';
import {
  allDiffFiles,
  assembleCommitTree,
  collapsedAll,
  commitDiffWalk,
  fileCountLabel,
  fileRowContext,
  groupByOf,
  groupRowContext,
  headLabel,
  splitDelta,
  treePathOf,
  twinRow,
  twinRows,
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

/** `colorIdx` is the palette slot the host hands out (`rootColorIndices`). */
function repo(root: string, label: string, groups: CommitGroupDto[], colorIdx = 0) {
  return { root, label, colorIdx, groups };
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
  return state({ repos: [...state().repos, repo('D:/repos/other', 'other', [second], 1)] });
}

describe('what a diff from the Commit window walks', () => {
  const DEMO = 'D:/repos/demo';
  const file = (path: string, repoRoot = DEMO) => ({ repoRoot, path });
  const rowOf = (model: ReturnType<typeof assembleCommitTree>, path: string, repoRoot = DEMO): string =>
    treePathOf(model, { repoRoot, path })!;

  it('is the whole list as the tree shows it, Unversioned Files last', () => {
    const model = assembleCommitTree(state());
    const walk = commitDiffWalk(model, new Set(), rowOf(model, 'docs/x.md'));
    expect(walk.explicit).toBe(false);
    expect(walk.files).toEqual([
      file('api/a.ts'),
      file('api/b.ts'),
      file('docs/x.md'),
      file('api/new.ts'),
    ]);
  });

  it('crosses changelists', () => {
    const model = assembleCommitTree(
      state({
        repos: [
          repo(DEMO, 'demo', [
            defaultList([change('z.ts')]),
            namedList('l1', 'Feature', [change('a.ts')]),
          ]),
        ],
      }),
    );
    expect(commitDiffWalk(model, new Set(), rowOf(model, 'z.ts')).files).toEqual([file('z.ts'), file('a.ts')]);
  });

  it('crosses repositories, each file knowing its own', () => {
    const model = assembleCommitTree(twoRepos());
    const { files } = commitDiffWalk(model, new Set(), rowOf(model, 'api/a.ts', 'D:/repos/other'));
    expect(files.map((f) => f.repoRoot)).toContain(DEMO);
    expect(files.map((f) => f.repoRoot)).toContain('D:/repos/other');
    expect(files.at(-1)).toEqual(file('api/a.ts', 'D:/repos/other'));
  });

  it('is only the rows selected with several selected, and says so', () => {
    const model = assembleCommitTree(state());
    const a = rowOf(model, 'api/a.ts');
    const x = rowOf(model, 'docs/x.md');
    expect(commitDiffWalk(model, new Set([x, a]), x)).toEqual({
      files: [file('api/a.ts'), file('docs/x.md')],
      explicit: true,
    });
  });

  it('agrees with the list the host is told about when it changes', () => {
    const model = assembleCommitTree(state());
    expect(allDiffFiles(model)).toEqual(commitDiffWalk(model, new Set(), rowOf(model, 'api/a.ts')).files);
  });

  it('finds no row for a file that has left the list', () => {
    expect(treePathOf(assembleCommitTree(state()), file('gone.ts'))).toBeUndefined();
  });

  it('tells two repositories apart when a path is in both', () => {
    const model = assembleCommitTree(twoRepos());
    const here = treePathOf(model, file('api/a.ts'));
    const there = treePathOf(model, file('api/a.ts', 'D:/repos/other'));
    expect(here).toBeDefined();
    expect(there).toBeDefined();
    expect(here).not.toBe(there);
  });
});

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

  it("a repository row carries its repository's colour, in every list it shows up in", () => {
    const unversioned: CommitGroupDto = {
      id: '__unversioned__',
      name: 'Unversioned Files',
      isActive: false,
      isDefault: false,
      checkable: false,
      changes: [change('fresh.ts', false, 'untracked')],
    };
    const model = assembleCommitTree(
      state({
        repos: [
          repo('D:/repos/demo', 'demo', [defaultList([change('a.ts')]), unversioned], 4),
          repo('D:/repos/other', 'other', [defaultList([change('b.ts')]), unversioned], 7),
        ],
      }),
    );
    // Its colour, not its files' status: the same slot under Changes and under
    // Unversioned Files, where everything beneath it is untracked.
    expect(model.groups.get('@g:@default@r:D:/repos/demo')?.colorIdx).toBe(4);
    expect(model.groups.get('@g:@default@r:D:/repos/other')?.colorIdx).toBe(7);
    expect(model.groups.get('@g:@unversioned@r:D:/repos/demo')?.colorIdx).toBe(4);
    expect(model.groups.get('@g:@unversioned@r:D:/repos/other')?.colorIdx).toBe(7);
    // A changelist row stands for several repositories, so it wears none.
    expect(model.groups.get('@g:@default')?.colorIdx).toBeUndefined();
    expect(model.groups.get('@g:@unversioned')?.colorIdx).toBeUndefined();
  });

  it('a repository whose colour did not arrive takes the first slot', () => {
    // The DTO crosses postMessage, where nothing checks it.
    const bare = { root: 'D:/repos/other', label: 'other', groups: [defaultList([change('b.ts')])] };
    const model = assembleCommitTree(
      state({ repos: [...state().repos, bare as unknown as CommitStateDto['repos'][number]] }),
    );
    expect(model.groups.get('@g:@default@r:D:/repos/other')?.colorIdx).toBe(0);
  });

  it('a single repository has no repository row to colour', () => {
    const model = assembleCommitTree(state());
    expect([...model.groups.values()].some((ref) => ref.kind === 'repo')).toBe(false);
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

/** The Unversioned Files bucket of one repository. */
function unversionedList(changes: CommitChangeDto[]): CommitGroupDto {
  return {
    id: '__unversioned__',
    name: 'Unversioned Files',
    isActive: false,
    isDefault: false,
    checkable: true,
    changes,
  };
}

/**
 * Two repositories, repositories first. `web` sends its lists out of order (new
 * files first, the default last) so the tree has to put them in IntelliJ's.
 */
function byRepository(overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return state({
    groupBy: 'repository',
    repos: [
      repo(
        'D:/repos/api',
        'api',
        [
          defaultList([change('src/a.ts', true), change('src/b.ts')]),
          unversionedList([change('notes.md', false, 'untracked')]),
        ],
        0,
      ),
      repo(
        'D:/repos/web',
        'web',
        [
          unversionedList([change('todo.txt', false, 'untracked')]),
          namedList('fix', 'Login fix', [change('src/login.ts')]),
          defaultList([change('app.ts', true)]),
        ],
        1,
      ),
    ],
    ...overrides,
  });
}

describe('Repository › Changelist (D37)', () => {
  it('puts each repository at the top, its own lists beneath in IntelliJ order', () => {
    const model = assembleCommitTree(byRepository());
    expect(model.groupBy).toBe('repository');
    expect(model.nodes.map((n) => n.name)).toEqual(['api', 'web']);
    expect(model.nodes.map((n) => n.path)).toEqual(['@r:D:/repos/api', '@r:D:/repos/web']);
    expect(model.groupPaths).toEqual(['@r:D:/repos/api', '@r:D:/repos/web']);
    expect(childNames(model.nodes[0])).toEqual(['Changes', 'Unversioned Files']);
    // The default first, the user's lists next, Unversioned Files last.
    expect(childNames(model.nodes[1])).toEqual(['Changes', 'Login fix', 'Unversioned Files']);
    expect(model.nodes[0]?.depth).toBe(0);
    expect(findNode(model.nodes, '@r:D:/repos/api@g:@default')?.depth).toBe(1);
    expect(findNode(model.nodes, '@r:D:/repos/api@g:@default/src')?.depth).toBe(2);
    expect(findNode(model.nodes, '@r:D:/repos/api@g:@default/src/a.ts')?.depth).toBe(3);
  });

  it('counts every file of a repository, in all its lists', () => {
    const model = assembleCommitTree(byRepository());
    expect(model.nodes.map((n) => countFiles(n))).toEqual([3, 3]);
  });

  it('leaves out a repository with nothing, and an empty list under one', () => {
    const model = assembleCommitTree(
      state({
        groupBy: 'repository',
        repos: [
          repo('D:/repos/a', 'a', [defaultList([]), unversionedList([change('n.txt', false, 'untracked')])]),
          repo('D:/repos/b', 'b', [defaultList([])]),
        ],
      }),
    );
    expect(model.nodes.map((n) => n.name)).toEqual(['a']);
    expect(childNames(model.nodes[0])).toEqual(['Unversioned Files']);
  });

  it('with nothing changed anywhere, shows the one empty Changes row the other grouping shows', () => {
    const model = assembleCommitTree(
      state({
        groupBy: 'repository',
        repos: [repo('D:/repos/a', 'a', [defaultList([])]), repo('D:/repos/b', 'b', [defaultList([])])],
      }),
    );
    expect(model.groupBy).toBe('repository');
    expect(model.nodes.map((n) => n.path)).toEqual(['@g:@default']);
    expect(model.groups.get('@g:@default')?.kind).toBe('group');
  });

  it('draws one repository by changelist whatever the setting says', () => {
    const model = assembleCommitTree(state({ groupBy: 'repository' }));
    expect(model.groupBy).toBe('changelist');
    expect(model.nodes.map((n) => n.path)).toEqual(['@g:@default', '@g:@unversioned']);
    expect(groupByOf(state({ groupBy: 'repository' }))).toBe('changelist');
    expect(groupByOf(byRepository())).toBe('repository');
    expect(groupByOf(byRepository({ groupBy: 'changelist' }))).toBe('changelist');
  });

  it('reads anything but repository as the default, as a state from an older host would carry', () => {
    const odd = byRepository({ groupBy: 'sideways' as unknown as CommitStateDto['groupBy'] });
    expect(groupByOf(odd)).toBe('changelist');
    const { groupBy: _, ...without } = byRepository();
    expect(groupByOf(without as CommitStateDto)).toBe('changelist');
  });

  it('a repository row stands for every change of its repository; a list under it for one copy', () => {
    const model = assembleCommitTree(byRepository());
    const web = model.groups.get('@r:D:/repos/web');
    expect(web).toMatchObject({
      kind: 'repository',
      shows: 'repository',
      repoRoot: 'D:/repos/web',
      colorIdx: 1,
      hasTracked: true,
      checkable: true,
    });
    expect(web?.listId).toBeUndefined();
    expect(web?.targets).toEqual([
      { repoRoot: 'D:/repos/web', listId: 'default' },
      { repoRoot: 'D:/repos/web', listId: 'fix' },
      { repoRoot: 'D:/repos/web', listId: '__unversioned__' },
    ]);
    const fix = model.groups.get('@r:D:/repos/web@g:name:Login fix');
    expect(fix).toMatchObject({
      kind: 'repo',
      shows: 'list',
      repoRoot: 'D:/repos/web',
      listId: 'fix',
      isDefault: false,
      targets: [{ repoRoot: 'D:/repos/web', listId: 'fix' }],
    });
    // Only a row that shows a repository wears its colour.
    expect(fix?.colorIdx).toBeUndefined();
  });

  it('knows a repository whose changes are all new files has nothing to roll back', () => {
    const model = assembleCommitTree(
      state({
        groupBy: 'repository',
        repos: [
          repo('D:/repos/a', 'a', [defaultList([]), unversionedList([change('n.txt', false, 'untracked')])]),
          repo('D:/repos/b', 'b', [defaultList([change('x.ts')])]),
        ],
      }),
    );
    expect(model.groups.get('@r:D:/repos/a')?.hasTracked).toBe(false);
    expect(model.groups.get('@r:D:/repos/b')?.hasTracked).toBe(true);
  });

  it('carries the branch on every row that shows a repository, in both groupings', () => {
    const head = { branch: 'main', upstream: 'origin/main' };
    const repos = [
      { ...repo('D:/repos/a', 'a', [defaultList([change('x.ts')])]), head },
      repo('D:/repos/b', 'b', [defaultList([change('y.ts')])]),
    ];
    const byRepo = assembleCommitTree(state({ groupBy: 'repository', repos }));
    expect(byRepo.groups.get('@r:D:/repos/a')?.head).toEqual(head);
    expect(byRepo.groups.get('@r:D:/repos/b')?.head).toBeUndefined();
    expect(byRepo.groups.get('@r:D:/repos/a@g:@default')?.head).toBeUndefined();
    const byList = assembleCommitTree(state({ repos }));
    expect(byList.groups.get('@g:@default@r:D:/repos/a')).toMatchObject({ shows: 'repository', head });
    expect(byList.groups.get('@g:@default')?.shows).toBe('list');
    expect(byList.groups.get('@g:@default')?.head).toBeUndefined();
  });

  it('lists its files repository by repository, which is the order a diff walks', () => {
    const model = assembleCommitTree(byRepository());
    expect(allDiffFiles(model)).toEqual([
      { repoRoot: 'D:/repos/api', path: 'src/a.ts' },
      { repoRoot: 'D:/repos/api', path: 'src/b.ts' },
      { repoRoot: 'D:/repos/api', path: 'notes.md' },
      { repoRoot: 'D:/repos/web', path: 'app.ts' },
      { repoRoot: 'D:/repos/web', path: 'src/login.ts' },
      { repoRoot: 'D:/repos/web', path: 'todo.txt' },
    ]);
  });

  it("ticks a repository's new files with the rest of it", () => {
    const model = assembleCommitTree(byRepository());
    const api = findNode(model.nodes, '@r:D:/repos/api')!;
    expect(rollup(api, model.checked)).toBe('partial');
    expect(splitDelta(toggle(api, rollup(api, model.checked)), model)).toEqual([
      { repoRoot: 'D:/repos/api', paths: ['src/a.ts', 'src/b.ts', 'notes.md'], checked: true },
    ]);
  });

  it('knows each folder as a folder of one repository list, whatever the grouping', () => {
    const byRepo = assembleCommitTree(byRepository());
    const byList = assembleCommitTree(byRepository({ groupBy: 'changelist' }));
    const folder = { repoRoot: 'D:/repos/api', listId: 'default', rel: 'src' };
    expect(byRepo.folders.get('@r:D:/repos/api@g:@default/src')).toEqual(folder);
    expect(byList.folders.get('@g:@default@r:D:/repos/api/src')).toEqual(folder);
    // A changelist or repository row is not a folder.
    expect(byRepo.folders.has('@r:D:/repos/api')).toBe(false);
    expect(byRepo.folders.has('@r:D:/repos/api@g:@default')).toBe(false);
  });

  it('never shares a path with the other grouping, so each keeps its own rows open', () => {
    const byRepo = assembleCommitTree(byRepository());
    const byList = assembleCommitTree(byRepository({ groupBy: 'changelist' }));
    const paths = (m: typeof byRepo): string[] => {
      const out: string[] = [];
      const walk = (nodes: readonly TreeNode[]): void => {
        for (const n of nodes) {
          out.push(n.path);
          if (n.kind === 'dir') walk(n.children);
        }
      };
      walk(m.nodes);
      return out;
    };
    const mine = new Set(paths(byRepo));
    expect(paths(byList).filter((p) => mine.has(p))).toEqual([]);
    expect(paths(byRepo).every((p) => p.startsWith('@r:'))).toBe(true);
    expect(paths(byList).every((p) => p.startsWith('@g:'))).toBe(true);
  });
});

describe('twinRow: the same rows in the other grouping', () => {
  const byList = assembleCommitTree(byRepository({ groupBy: 'changelist' }));
  const byRepo = assembleCommitTree(byRepository());

  it('finds a file as the same file', () => {
    expect(twinRow(byList, byRepo, '@g:@default@r:D:/repos/api/src/a.ts')).toBe('@r:D:/repos/api@g:@default/src/a.ts');
    expect(twinRow(byRepo, byList, '@r:D:/repos/web@g:@unversioned/todo.txt')).toBe(
      '@g:@unversioned@r:D:/repos/web/todo.txt',
    );
  });

  it('finds a folder as the same folder of the same list', () => {
    expect(twinRow(byList, byRepo, '@g:@default@r:D:/repos/api/src')).toBe('@r:D:/repos/api@g:@default/src');
    expect(twinRow(byRepo, byList, '@r:D:/repos/web@g:name:Login fix/src')).toBe('@g:name:Login fix@r:D:/repos/web/src');
  });

  it("finds one repository's copy of a list as the same copy: under the list there, over its files here", () => {
    expect(twinRow(byList, byRepo, '@g:name:Login fix@r:D:/repos/web')).toBe('@r:D:/repos/web@g:name:Login fix');
    expect(twinRow(byRepo, byList, '@r:D:/repos/web@g:name:Login fix')).toBe('@g:name:Login fix@r:D:/repos/web');
  });

  it("hands a changelist spanning repositories to its first repository's copy", () => {
    expect(twinRow(byList, byRepo, '@g:@default')).toBe('@r:D:/repos/api@g:@default');
    expect(twinRow(byList, byRepo, '@g:@unversioned')).toBe('@r:D:/repos/api@g:@unversioned');
  });

  it('hands a repository to its first list', () => {
    expect(twinRow(byRepo, byList, '@r:D:/repos/web')).toBe('@g:@default@r:D:/repos/web');
    expect(twinRow(byRepo, byList, '@r:D:/repos/api')).toBe('@g:@default@r:D:/repos/api');
  });

  it('finds nothing for a row that is gone', () => {
    expect(twinRow(byRepo, byList, '@r:D:/repos/gone')).toBeUndefined();
    const fewer = assembleCommitTree(
      byRepository({ groupBy: 'changelist', repos: byRepository().repos.slice(0, 1) }),
    );
    expect(twinRow(byRepo, fewer, '@r:D:/repos/web@g:@default/app.ts')).toBeUndefined();
  });

  it('keeps the empty Changes row, which both groupings draw', () => {
    const empty = (groupBy: 'changelist' | 'repository'): CommitStateDto =>
      state({
        groupBy,
        repos: [repo('D:/repos/a', 'a', [defaultList([])]), repo('D:/repos/b', 'b', [defaultList([])])],
      });
    expect(twinRow(assembleCommitTree(empty('changelist')), assembleCommitTree(empty('repository')), '@g:@default')).toBe(
      '@g:@default',
    );
  });

  it('maps a selection, each twin once and in the order given', () => {
    expect(
      twinRows(byList, byRepo, ['@g:@default@r:D:/repos/api/src/b.ts', '@g:@default', '@g:@default@r:D:/repos/api', 'nope']),
    ).toEqual(['@r:D:/repos/api@g:@default/src/b.ts', '@r:D:/repos/api@g:@default']);
  });
});

describe('Collapse all in one grouping', () => {
  const open = new Set([
    '@r:D:/repos/api',
    '@r:D:/repos/api@g:@default/src',
    '@g:@default',
    '@g:@default@r:D:/repos/api',
  ]);

  it("shuts this grouping's rows and leaves the other's as they were", () => {
    expect([...collapsedAll(assembleCommitTree(byRepository()), open)]).toEqual([
      '@g:@default',
      '@g:@default@r:D:/repos/api',
    ]);
    expect([...collapsedAll(assembleCommitTree(byRepository({ groupBy: 'changelist' })), open)]).toEqual([
      '@r:D:/repos/api',
      '@r:D:/repos/api@g:@default/src',
    ]);
  });
});

describe('the label on a repository row', () => {
  it('names the branch, and what it tracks on hover', () => {
    expect(headLabel({ branch: 'main', sha: 'a1b2c3d4e5', upstream: 'origin/main' })).toEqual({
      text: 'main',
      title: 'Branch main, tracking origin/main',
    });
    expect(headLabel({ branch: 'feature/login', sha: 'a1b2c3d4e5' })).toEqual({
      text: 'feature/login',
      title: 'Branch feature/login',
    });
  });

  it('says a branch with no commits has none yet', () => {
    expect(headLabel({ branch: 'main', unborn: true })).toEqual({ text: 'main', title: 'Branch main, no commits yet' });
  });

  it('names a detached HEAD by its commit', () => {
    expect(headLabel({ sha: 'a1b2c3d4e5f6' })).toEqual({ text: 'a1b2c3d', title: 'HEAD detached at a1b2c3d' });
  });

  it('says nothing when nothing is known', () => {
    expect(headLabel(undefined)).toBeUndefined();
    expect(headLabel({})).toBeUndefined();
  });
});

describe('the menu a changelist or repository row opens', () => {
  it('gives a repository row the actions on all of its changes', () => {
    const model = assembleCommitTree(byRepository());
    expect(groupRowContext(model, '@r:D:/repos/web')).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitRepository',
      repoRoot: 'D:/repos/web',
      repoHasTracked: true,
    });
  });

  it("gives a list under a repository the scoped list actions, as the repository row under a list has", () => {
    const byRepo = groupRowContext(assembleCommitTree(byRepository()), '@r:D:/repos/web@g:name:Login fix');
    const byList = groupRowContext(
      assembleCommitTree(byRepository({ groupBy: 'changelist' })),
      '@g:name:Login fix@r:D:/repos/web',
    );
    expect(byRepo).toEqual(byList);
    expect(byRepo).toMatchObject({
      webviewSection: 'commitRepo',
      repoRoot: 'D:/repos/web',
      listId: 'fix',
      listIsDefault: false,
      listSpansRepos: false,
    });
  });

  it('gives a changelist spanning repositories the fanned-out actions', () => {
    const ctx = groupRowContext(assembleCommitTree(byRepository({ groupBy: 'changelist' })), '@g:@default');
    expect(ctx).toMatchObject({ webviewSection: 'commitGroup', listSpansRepos: true, listIsDefault: true });
    expect(ctx?.['repoRoot']).toBeUndefined();
  });

  it('has nothing to say about a file or folder row', () => {
    const model = assembleCommitTree(byRepository());
    expect(groupRowContext(model, '@r:D:/repos/api@g:@default/src')).toBeUndefined();
    expect(groupRowContext(model, '@r:D:/repos/api@g:@default/src/a.ts')).toBeUndefined();
  });
});
