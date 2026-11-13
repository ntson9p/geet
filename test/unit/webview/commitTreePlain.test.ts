/**
 * POST-P14cb: the Commit window without changelist rows, its default (D44):
 * every changed file under its repository, as VS Code's Source Control view
 * lists them, in one list or under folder rows (Group By › Directory).
 * IntelliJ's groupings are commitTree.test.ts's; what the rows look like on a
 * page, the Playwright suite's (commit.spec.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  CONFLICTS_GROUP_ID,
  STAGED_GROUP_ID,
  UNSTAGED_GROUP_ID,
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitGroupDto,
  type CommitStateDto,
} from '../../../src/shared/protocol';
import {
  ALL_CHANGES_ID,
  assembleCommitTree,
  collapsedAll,
  fileRowContext,
  groupByOf,
  groupRowContext,
  isConflictsRow,
  layoutOf,
  listDescription,
  revealRequestOf,
  splitDelta,
  statusLook,
  twinRow,
} from '../../../webview-ui/src/commit/commitTree';
import { buildList, buildTree, collectFiles, type TreeNode } from '../../../webview-ui/src/lib/treeModel';

const API = 'D:/repos/api';
const WEB = 'D:/repos/web';

function change(path: string, kind: CommitChangeDto['kind'] = 'modified', checked = kind !== 'untracked'): CommitChangeDto {
  return { path, code: '.M', kind, checked };
}

function list(id: string, name: string, changes: CommitChangeDto[], extra: Partial<CommitGroupDto> = {}): CommitGroupDto {
  return { id, name, isActive: id === 'default', isDefault: id === 'default', checkable: true, changes, ...extra };
}

const unversioned = (changes: CommitChangeDto[]): CommitGroupDto => list(UNVERSIONED_GROUP_ID, 'Unversioned Files', changes);
const conflicts = (changes: CommitChangeDto[]): CommitGroupDto =>
  list(CONFLICTS_GROUP_ID, 'Merge Conflicts', changes, { checkable: false });

/** The design page's two repositories: every kind of change, a user list, untracked files. */
function shop(overrides: Partial<CommitStateDto> = {}): CommitStateDto {
  return {
    repos: [
      {
        root: API,
        label: 'shop-api',
        colorIdx: 0,
        groups: [
          list('default', 'Changes', [
            { ...change('docs/install.md', 'renamed'), origPath: 'docs/setup.md' },
            change('package.json'),
            change('src/legacy/cart.ts', 'deleted'),
            change('src/routes/orders.ts', 'added'),
          ]),
          list('fix', 'Server fix', [change('src/server.ts')]),
          unversioned([change('notes/todo.md', 'untracked')]),
        ],
        head: { branch: 'main' },
      },
      {
        root: WEB,
        label: 'shop-web',
        colorIdx: 1,
        groups: [
          list('default', 'Changes', [change('src/App.tsx'), change('index.html')]),
          unversioned([change('src/styles/theme.css', 'untracked')]),
        ],
      },
    ],
    activeRepo: API,
    targets: ['shop-api', 'shop-web'],
    message: '',
    amend: false,
    signing: false,
    busy: false,
    modifiedCount: 9,
    checkedCount: 7,
    paradigm: 'changelists',
    ...overrides,
  };
}

const one = (overrides: Partial<CommitStateDto> = {}): CommitStateDto => {
  const s = shop(overrides);
  return { ...s, repos: s.repos.slice(0, 1), targets: ['shop-api'] };
};

const names = (nodes: readonly TreeNode[]): string[] => nodes.map((n) => n.name);
const childrenOf = (node: TreeNode | undefined): readonly TreeNode[] =>
  node !== undefined && node.kind === 'dir' ? node.children : [];

describe('the default: no changelist rows, one list (POST-P14cb)', () => {
  it('is what a state without a grouping is drawn in', () => {
    const { groupBy: _g, groupByDirectory: _d, ...plain } = shop();
    expect(groupByOf(plain)).toBe('none');
    expect(layoutOf(plain)).toBe('list');
    const model = assembleCommitTree(plain);
    expect(model.groupBy).toBe('none');
    expect(model.layout).toBe('list');
  });

  it('puts each repository at the top and every file of it beneath, in path order, untracked ones among them', () => {
    const model = assembleCommitTree(shop());
    expect(model.nodes.map((n) => n.path)).toEqual([`@n:${API}`, `@n:${WEB}`]);
    const api = model.nodes[0];
    expect(names(childrenOf(api))).toEqual(['install.md', 'todo.md', 'package.json', 'cart.ts', 'orders.ts', 'server.ts']);
    // One depth under its repository: no folder rows.
    expect(childrenOf(api).every((n) => n.kind === 'file' && n.depth === 1)).toBe(true);
    expect(names(childrenOf(model.nodes[1]))).toEqual(['index.html', 'App.tsx', 'theme.css']);
    expect(model.groupPaths).toEqual([`@n:${API}`, `@n:${WEB}`]);
  });

  it('draws one repository without its row, its files at the top', () => {
    const model = assembleCommitTree(one());
    expect(model.groupBy).toBe('none');
    expect(names(model.nodes)).toEqual(['install.md', 'todo.md', 'package.json', 'cart.ts', 'orders.ts', 'server.ts']);
    expect(model.nodes.every((n) => n.kind === 'file' && n.depth === 0)).toBe(true);
    // Its files keep the paths they have under the row two repositories draw.
    expect(model.nodes.map((n) => n.path)).toContain(`@n:${API}/src/server.ts`);
    expect(model.groups.size).toBe(0);
  });

  it('every file is still its own change, in its own repository, ticked as the host says', () => {
    const model = assembleCommitTree(shop());
    expect(model.files.get(`@n:${API}/src/server.ts`)).toMatchObject({ repoRoot: API, relPath: 'src/server.ts' });
    expect(model.files.get(`@n:${API}/src/server.ts`)?.side).toBeUndefined();
    expect(model.checked.has(`@n:${API}/package.json`)).toBe(true);
    // An untracked file starts unticked, and can be ticked: it has its box.
    expect(model.checked.has(`@n:${API}/notes/todo.md`)).toBe(false);
    expect(model.checkboxless.has(`@n:${API}/notes/todo.md`)).toBe(false);
    expect(model.checkboxless.has(`@n:${API}`)).toBe(false);
  });

  it('a tick on a repository splits into one call for that repository', () => {
    const model = assembleCommitTree(shop());
    const api = model.nodes[0]!;
    expect(splitDelta({ paths: collectFiles(api), next: true }, model)).toEqual([
      {
        repoRoot: API,
        paths: ['docs/install.md', 'notes/todo.md', 'package.json', 'src/legacy/cart.ts', 'src/routes/orders.ts', 'src/server.ts'],
        checked: true,
      },
    ]);
  });

  it("a repository's row carries that repository's menu, every list it has behind it", () => {
    const model = assembleCommitTree(shop());
    expect(model.groups.get(`@n:${API}`)).toMatchObject({
      kind: 'repository',
      shows: 'repository',
      repoRoot: API,
      colorIdx: 0,
      head: { branch: 'main' },
      hasTracked: true,
      hasUnversioned: true,
      checkable: true,
    });
    expect(model.groups.get(`@n:${API}`)?.targets.map((t) => t.listId)).toEqual(['default', 'fix', UNVERSIONED_GROUP_ID]);
    expect(groupRowContext(model, `@n:${API}`)).toEqual({
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitRepository',
      repoRoot: API,
      repoHasTracked: true,
      repoHasUnversioned: true,
    });
  });

  it("the reveal key on a repository's row shows that repository's folder", () => {
    const model = assembleCommitTree(shop());
    expect(revealRequestOf(model, `@n:${API}`)).toEqual({ repoRoot: API, folder: '.' });
    expect(revealRequestOf(model, `@n:${API}/src/server.ts`)).toEqual({ repoRoot: API, relPath: 'src/server.ts' });
  });

  it("a file's row says it is untracked, as Add to VCS needs", () => {
    const model = assembleCommitTree(shop());
    const ctx = fileRowContext(model, `@n:${API}/notes/todo.md`, new Set());
    expect(ctx).toMatchObject({ webviewSection: 'commitFile', repoRoot: API, fileUnversioned: true });
  });

  it('Collapse All shuts these rows and leaves the other groupings as they were', () => {
    const model = assembleCommitTree(shop());
    const open = new Set([`@n:${API}`, `@n:${WEB}`, '@g:@default', `@r:${API}`]);
    expect([...collapsedAll(model, open)]).toEqual(['@g:@default', `@r:${API}`]);
  });

  it('a file selected under changelists is the same file here, and back', () => {
    const byList = assembleCommitTree(shop({ groupBy: 'changelist', groupByDirectory: true }));
    const plain = assembleCommitTree(shop());
    const fromList = [...byList.files].find(([, ref]) => ref.relPath === 'src/server.ts')![0];
    expect(twinRow(byList, plain, fromList)).toBe(`@n:${API}/src/server.ts`);
    expect(twinRow(plain, byList, `@n:${API}/src/server.ts`)).toBe(fromList);
    // A repository row is its first list's copy in the other grouping.
    expect(twinRow(plain, byList, `@n:${API}`)).toBeDefined();
  });
});

describe('Merge Conflicts, first under its repository', () => {
  const withConflict = (): CommitStateDto => {
    const s = shop();
    const [api, web] = s.repos;
    return { ...s, repos: [{ ...api!, groups: [conflicts([change('src/db.ts', 'conflicted', false)]), ...api!.groups] }, web!] };
  };

  it('is a row of its own before the files, its files with no box', () => {
    const model = assembleCommitTree(withConflict());
    const api = model.nodes[0];
    const first = childrenOf(api)[0]!;
    expect(first.path).toBe(`@n:${API}@g:@conflicts`);
    expect(first.name).toBe('Merge Conflicts');
    expect(names(childrenOf(first))).toEqual(['db.ts']);
    expect(isConflictsRow(model, first.path)).toBe(true);
    expect(groupRowContext(model, first.path)).toMatchObject({ webviewSection: 'commitConflicts', repoRoot: API });
    expect(model.checkboxless.has(`${first.path}/src/db.ts`)).toBe(true);
    // The rest of the files follow it, one list.
    expect(names(childrenOf(api)).slice(1)).toEqual(['install.md', 'todo.md', 'package.json', 'cart.ts', 'orders.ts', 'server.ts']);
  });

  it('with one repository, it is at the top, and opens with the window', () => {
    const s = withConflict();
    const model = assembleCommitTree({ ...s, repos: s.repos.slice(0, 1) });
    expect(model.nodes[0]?.path).toBe(`@n:${API}@g:@conflicts`);
    expect(model.groupPaths).toEqual([`@n:${API}@g:@conflicts`]);
  });
});

describe('Group By › Directory: folder rows', () => {
  it('puts the same files under folders, each keeping its path, its tick and its change', () => {
    const asList = assembleCommitTree(shop());
    const asTree = assembleCommitTree(shop({ groupByDirectory: true }));
    expect(asTree.layout).toBe('tree');
    expect(names(childrenOf(asTree.nodes[0]))).toEqual(['docs', 'notes', 'src', 'package.json']);
    expect([...asTree.files.keys()].sort()).toEqual([...asList.files.keys()].sort());
    expect([...asTree.checked].sort()).toEqual([...asList.checked].sort());
    // A folder is a folder of the repository's changes, every list's together.
    expect(asTree.folders.get(`@n:${API}/src`)).toEqual({ repoRoot: API, listId: ALL_CHANGES_ID, rel: 'src' });
    expect(asTree.dirKinds.get(`@n:${API}/src/legacy`)).toEqual(new Set(['deleted']));
  });

  it('applies to the changelist groupings too', () => {
    const model = assembleCommitTree(one({ groupBy: 'changelist', groupByDirectory: false }));
    const changes = model.nodes[0];
    expect(changes?.path).toBe('@g:@default');
    expect(childrenOf(changes).every((n) => n.kind === 'file')).toBe(true);
    expect(names(childrenOf(changes))).toEqual(['install.md', 'package.json', 'cart.ts', 'orders.ts']);
  });
});

describe('with staging, its halves are rows', () => {
  const staged = (paths: string[]): CommitGroupDto =>
    list(STAGED_GROUP_ID, 'Staged', paths.map((p) => change(p, 'added')), { checkable: false });
  const unstaged = (paths: string[]): CommitGroupDto =>
    list(UNSTAGED_GROUP_ID, 'Changes', paths.map((p) => change(p)), { checkable: false });
  const staging = (): CommitStateDto => {
    const s = shop({ paradigm: 'staging' });
    return {
      ...s,
      repos: [
        {
          ...s.repos[0]!,
          groups: [
            staged(['src/routes/orders.ts', 'both.ts']),
            unstaged(['both.ts', 'package.json']),
            { ...unversioned([change('notes/todo.md', 'untracked', false)]), checkable: false },
          ],
        },
        s.repos[1]!,
      ],
    };
  };

  it('under its repository: Staged, Changes, Unversioned Files, as the host orders them, with no boxes', () => {
    const model = assembleCommitTree(staging());
    const api = model.nodes[0];
    expect(names(childrenOf(api))).toEqual(['Staged', 'Changes', 'Unversioned Files']);
    expect(childrenOf(api).map((n) => n.depth)).toEqual([1, 1, 1]);
    // A file staged in part is a row in each half, each with its side.
    expect(model.files.get(`@n:${API}@g:name:Staged/both.ts`)?.side).toBe('staged');
    expect(model.files.get(`@n:${API}@g:name:Changes/both.ts`)?.side).toBe('unstaged');
    for (const path of model.files.keys()) {
      if (path.startsWith(`@n:${API}`)) expect(model.checkboxless.has(path)).toBe(true);
    }
    expect(groupRowContext(model, `@n:${API}@g:name:Staged`)).toMatchObject({
      webviewSection: 'commitRepo',
      stagingSide: 'staged',
    });
  });
});

describe('what a row shows without changelists', () => {
  it("names a file's folder, and where a renamed or moved one came from", () => {
    expect(listDescription('src/server.ts', undefined)).toBe('src');
    expect(listDescription('package.json', undefined)).toBeUndefined();
    expect(listDescription('docs/install.md', 'docs/setup.md')).toBe('docs ← setup.md');
    expect(listDescription('src/a.ts', 'lib/a.ts')).toBe('src ← lib/a.ts');
    expect(listDescription('new.md', 'old.md')).toBe('← old.md');
    expect(listDescription('src/a.ts', 'src/a.ts')).toBe('src');
  });

  it("writes each status with VS Code's letter, an untracked name in italics, a deleted one struck through", () => {
    const look = (kind: CommitChangeDto['kind']) => statusLook(change('a.ts', kind));
    expect(look('modified')).toEqual({ letter: 'M', title: 'Modified', italic: false, strike: false });
    expect(look('added')).toEqual({ letter: 'A', title: 'Added', italic: false, strike: false });
    expect(look('deleted')).toEqual({ letter: 'D', title: 'Deleted', italic: false, strike: true });
    expect(look('renamed')).toEqual({ letter: 'R', title: 'Renamed', italic: false, strike: false });
    expect(look('untracked')).toEqual({ letter: 'U', title: 'Untracked', italic: true, strike: false });
    expect(look('conflicted')).toEqual({ letter: '!', title: 'Conflicted', italic: false, strike: false });
  });
});

describe('buildList: the files buildTree makes, as one list', () => {
  it('in path order, case aside, each at one depth, with the paths buildTree gives them', () => {
    const paths = ['src/b.ts', 'README.md', 'src/A/z.ts', 'docs/x.md', 'src/b.ts'];
    const flat = buildList(paths, { root: { path: 'R', name: 'repo' }, pathPrefix: 'R' });
    const root = flat[0]!;
    expect(root).toMatchObject({ kind: 'dir', path: 'R', name: 'repo', depth: 0, fileCount: 4 });
    expect(childrenOf(root).map((n) => [n.path, n.name, n.depth])).toEqual([
      ['R/docs/x.md', 'x.md', 1],
      ['R/README.md', 'README.md', 1],
      ['R/src/A/z.ts', 'z.ts', 1],
      ['R/src/b.ts', 'b.ts', 1],
    ]);
    const tree = buildTree(paths, { root: { path: 'R', name: 'repo' }, pathPrefix: 'R' });
    expect(collectFiles(tree[0]!).sort()).toEqual(collectFiles(root).sort());
  });

  it('without a root, the files are the top', () => {
    expect(buildList(['b\\c.ts', '/a.ts', '']).map((n) => [n.path, n.depth])).toEqual([
      ['a.ts', 0],
      ['b/c.ts', 0],
    ]);
  });
});
