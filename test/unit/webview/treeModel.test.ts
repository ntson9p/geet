import { describe, expect, it } from 'vitest';
import {
  allDirPaths,
  allFiles,
  ancestorDirs,
  buildTree,
  collectFiles,
  countFiles,
  diffWalk,
  findNode,
  flatten,
  rollup,
  rowIndexOf,
  selectedFiles,
  selectionFollowing,
  toggle,
  type TreeDirNode,
  type TreeNode,
} from '../../../webview-ui/src/lib/treeModel';

/** Compact `depth:name` rendering of the visible rows, for readable assertions. */
function render(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): string[] {
  return flatten(nodes, expanded).map(
    (r) => `${'  '.repeat(r.node.depth)}${r.node.name}${r.node.kind === 'dir' ? '/' : ''}`,
  );
}

function dirs(nodes: readonly TreeNode[]): Set<string> {
  return new Set(allDirPaths(nodes));
}

describe('walking the files of a tree', () => {
  // Folders before files at every level, whatever order the paths came in.
  const nodes = buildTree(['README.md', 'logo.png', 'src/added.ts', 'src/app.ts', 'src/lib/util.ts', 'zed.txt'], {
    root: { path: '@repo', name: 'repo' },
  });
  const ALL = ['src/lib/util.ts', 'src/added.ts', 'src/app.ts', 'logo.png', 'README.md', 'zed.txt'];
  const selecting = (...paths: string[]): Set<string> => new Set(paths);

  it('lists every file in the order the tree shows them', () => {
    expect(allFiles(nodes)).toEqual(ALL);
    expect(allFiles([])).toEqual([]);
  });

  describe('what a selection stands for', () => {
    it('is its files, in tree order, not the order they were picked', () => {
      expect(selectedFiles(nodes, selecting('zed.txt', 'src/app.ts'))).toEqual(['src/app.ts', 'zed.txt']);
    });

    it('is all the files of a selected folder', () => {
      expect(selectedFiles(nodes, selecting('src'))).toEqual(['src/lib/util.ts', 'src/added.ts', 'src/app.ts']);
      expect(selectedFiles(nodes, selecting('src/lib'))).toEqual(['src/lib/util.ts']);
    });

    it('does not count a file twice when its folder is selected too', () => {
      expect(selectedFiles(nodes, selecting('src/lib', 'src/lib/util.ts'))).toEqual(['src/lib/util.ts']);
    });

    it('is nothing for nothing, or for a row that is gone', () => {
      expect(selectedFiles(nodes, selecting())).toEqual([]);
      expect(selectedFiles(nodes, selecting('gone.txt'))).toEqual([]);
    });
  });

  describe('what a diff walks (IntelliJ\'s getListSelectionOrAll)', () => {
    it('is every file with one file selected or none', () => {
      expect(diffWalk(nodes, selecting('src/app.ts'), 'src/app.ts')).toEqual({ files: ALL, explicit: false });
      expect(diffWalk(nodes, selecting(), 'src/app.ts')).toEqual({ files: ALL, explicit: false });
    });

    it('is only those with several selected', () => {
      expect(diffWalk(nodes, selecting('zed.txt', 'src/app.ts'), 'zed.txt')).toEqual({
        files: ['src/app.ts', 'zed.txt'],
        explicit: true,
      });
    });

    it('takes a folder as the several files it stands for', () => {
      expect(diffWalk(nodes, selecting('src'), 'src/app.ts').files).toEqual([
        'src/lib/util.ts',
        'src/added.ts',
        'src/app.ts',
      ]);
    });

    it('takes a folder of one file as one file: every file, as with a file row', () => {
      expect(diffWalk(nodes, selecting('src/lib'), 'src/lib/util.ts')).toEqual({ files: ALL, explicit: false });
    });

    it('is every file when the row opened is outside the selection', () => {
      expect(diffWalk(nodes, selecting('zed.txt', 'src/app.ts'), 'README.md')).toEqual({
        files: ALL,
        explicit: false,
      });
    });
  });

  describe('bringing a file into view', () => {
    it('opens every row above it', () => {
      expect(new Set(ancestorDirs(nodes, 'src/lib/util.ts'))).toEqual(new Set(['@repo', 'src', 'src/lib']));
      expect(ancestorDirs(nodes, 'README.md')).toEqual(['@repo']);
    });

    it('opens nothing for a file that is not there', () => {
      expect(ancestorDirs(nodes, 'gone.txt')).toEqual([]);
    });

    it('opens the rows above a folder too, and not the folder itself', () => {
      // A grouping change puts the user back on a folder or a changelist row as
      // well as on a file.
      expect(ancestorDirs(nodes, 'src/lib')).toEqual(['src', '@repo']);
      expect(ancestorDirs(nodes, '@repo')).toEqual([]);
    });
  });

  describe('the selection once a walk moves on', () => {
    it('moves with it', () => {
      expect(selectionFollowing(nodes, selecting('src/app.ts'), 'logo.png')).toEqual(selecting('logo.png'));
      expect(selectionFollowing(nodes, selecting(), 'logo.png')).toEqual(selecting('logo.png'));
    });

    it('stays put when the walk is over several selected rows', () => {
      // Moving it would leave the next diff opened walking something else.
      const several = selecting('zed.txt', 'src/app.ts');
      expect(selectionFollowing(nodes, several, 'zed.txt')).toBe(several);
      const folder = selecting('src');
      expect(selectionFollowing(nodes, folder, 'src/app.ts')).toBe(folder);
    });

    it('moves when the file is not among them', () => {
      const several = selecting('zed.txt', 'src/app.ts');
      expect(selectionFollowing(nodes, several, 'logo.png')).toEqual(selecting('logo.png'));
    });
  });
});

describe('buildTree', () => {
  it('returns nothing for an empty or blank input', () => {
    expect(buildTree([])).toEqual([]);
    expect(buildTree(['', '.', '/', './'])).toEqual([]);
  });

  it('puts root-level files at the top level', () => {
    const tree = buildTree(['1.txt', '2.txt']);
    expect(tree.map((n) => n.name)).toEqual(['1.txt', '2.txt']);
    expect(tree.every((n) => n.kind === 'file')).toBe(true);
  });

  it('collapses single-child directory chains into one row', () => {
    const tree = buildTree(['src/main/java/Foo.java', 'src/main/java/Bar.java']);
    expect(render(tree, dirs(tree))).toEqual(['src/main/java/', '  Bar.java', '  Foo.java']);
    const only = tree[0] as TreeDirNode;
    expect(only.path).toBe('src/main/java');
    expect(only.depth).toBe(0);
    expect((only.children[0] as TreeNode).depth).toBe(1);
  });

  it('stops collapsing where a directory branches', () => {
    const tree = buildTree(['src/main/java/Foo.java', 'src/test/Bar.java']);
    expect(render(tree, dirs(tree))).toEqual([
      'src/',
      '  main/java/',
      '    Foo.java',
      '  test/',
      '    Bar.java',
    ]);
  });

  it('does not collapse past a directory that holds files of its own', () => {
    const tree = buildTree(['a/keep.txt', 'a/b/deep.txt']);
    expect(render(tree, dirs(tree))).toEqual(['a/', '  b/', '    deep.txt', '  keep.txt']);
  });

  it('honours collapseChains: false', () => {
    const tree = buildTree(['src/main/java/Foo.java'], { collapseChains: false });
    expect(render(tree, dirs(tree))).toEqual(['src/', '  main/', '    java/', '      Foo.java']);
  });

  it('sorts directories before files, case-insensitively and deterministically', () => {
    const tree = buildTree(['zeta.txt', 'Alpha.txt', 'beta/x.txt', 'Beta2/y.txt']);
    expect(tree.map((n) => n.name)).toEqual(['beta', 'Beta2', 'Alpha.txt', 'zeta.txt']);
  });

  it('normalizes Windows separators and de-duplicates', () => {
    const tree = buildTree(['a\\b\\c.txt', 'a/b/c.txt', './a/b/c.txt']);
    expect(collectFiles(tree[0] as TreeNode)).toEqual(['a/b/c.txt']);
  });

  it('is insensitive to input order', () => {
    const a = buildTree(['b/2.txt', 'a/1.txt', 'a/0.txt']);
    const b = buildTree(['a/0.txt', 'b/2.txt', 'a/1.txt']);
    expect(render(a, dirs(a))).toEqual(render(b, dirs(b)));
  });

  it('wraps everything in a synthetic root and shifts depth', () => {
    const tree = buildTree(['api/A.java', 'api/B.java'], {
      root: { path: '@changes', name: 'Changes' },
    });
    expect(tree).toHaveLength(1);
    const root = tree[0] as TreeDirNode;
    expect(root.name).toBe('Changes');
    expect(root.depth).toBe(0);
    expect(root.fileCount).toBe(2);
    expect((root.children[0] as TreeNode).depth).toBe(1);
  });
});

describe('countFiles', () => {
  it('counts the whole subtree on directories and 1 on files', () => {
    const tree = buildTree(['api/a.ts', 'api/nested/b.ts', 'api/nested/c.ts', 'top.ts']);
    const api = findNode(tree, 'api') as TreeDirNode;
    expect(countFiles(api)).toBe(3);
    expect(countFiles(findNode(tree, 'api/nested') as TreeNode)).toBe(2);
    expect(countFiles(findNode(tree, 'top.ts') as TreeNode)).toBe(1);
  });
});

describe('rollup', () => {
  const tree = buildTree(['api/a.ts', 'api/b.ts', 'api/c.ts']);
  const api = () => findNode(tree, 'api') as TreeNode;

  it('reports unchecked when nothing is ticked', () => {
    expect(rollup(api(), new Set())).toBe('unchecked');
  });

  it('reports partial for a directory with one of three ticked', () => {
    expect(rollup(api(), new Set(['api/b.ts']))).toBe('partial');
  });

  it('reports checked only when every descendant is ticked', () => {
    expect(rollup(api(), new Set(['api/a.ts', 'api/b.ts']))).toBe('partial');
    expect(rollup(api(), new Set(['api/a.ts', 'api/b.ts', 'api/c.ts']))).toBe('checked');
  });

  it('rolls partial all the way up every ancestor', () => {
    const deep = buildTree(['x/y/z/1.ts', 'x/y/z/2.ts'], {
      root: { path: '@root', name: 'Changes' },
    });
    const checked = new Set(['x/y/z/1.ts']);
    expect(rollup(deep[0] as TreeNode, checked)).toBe('partial');
    expect(rollup(findNode(deep, 'x/y/z') as TreeNode, checked)).toBe('partial');
    expect(rollup(findNode(deep, 'x/y/z/1.ts') as TreeNode, checked)).toBe('checked');
    expect(rollup(findNode(deep, 'x/y/z/2.ts') as TreeNode, checked)).toBe('unchecked');
  });

  it('treats a childless directory as unchecked, never as checked', () => {
    const empty: TreeDirNode = {
      kind: 'dir',
      path: '@empty',
      name: 'Unversioned Files',
      depth: 0,
      children: [],
      fileCount: 0,
    };
    expect(rollup(empty, new Set())).toBe('unchecked');
  });
});

describe('toggle', () => {
  const tree = buildTree(['api/a.ts', 'api/nested/b.ts']);

  it('ticks the whole subtree from unchecked', () => {
    const api = findNode(tree, 'api') as TreeNode;
    expect(toggle(api, 'unchecked')).toEqual({
      paths: ['api/nested/b.ts', 'api/a.ts'],
      next: true,
    });
  });

  it('ticks the whole subtree from partial — never the reverse', () => {
    const api = findNode(tree, 'api') as TreeNode;
    expect(toggle(api, 'partial').next).toBe(true);
  });

  it('unticks only when fully checked', () => {
    const api = findNode(tree, 'api') as TreeNode;
    expect(toggle(api, 'checked').next).toBe(false);
  });

  it('applies to exactly one path for a file row', () => {
    expect(toggle(findNode(tree, 'api/a.ts') as TreeNode, 'unchecked')).toEqual({
      paths: ['api/a.ts'],
      next: true,
    });
  });
});

describe('flatten', () => {
  const tree = buildTree(['api/a.ts', 'api/nested/b.ts', 'top.ts']);

  it('hides children of collapsed directories', () => {
    expect(render(tree, new Set())).toEqual(['api/', 'top.ts']);
  });

  it('reveals one level at a time', () => {
    expect(render(tree, new Set(['api']))).toEqual(['api/', '  nested/', '  a.ts', 'top.ts']);
  });

  it('marks expandable rows and their open state', () => {
    const rows = flatten(tree, new Set(['api']));
    expect(rows[0]).toMatchObject({ expandable: true, expanded: true });
    expect(rows[1]).toMatchObject({ expandable: true, expanded: false });
    expect(rows[2]).toMatchObject({ expandable: false, expanded: false });
  });

  it('locates a row by path for focus restoration', () => {
    const rows = flatten(tree, new Set(['api']));
    expect(rowIndexOf(rows, 'api/nested')).toBe(1);
    expect(rowIndexOf(rows, 'nope')).toBe(-1);
  });
});

describe('allDirPaths', () => {
  it('lists every directory, including collapsed chains, for expand-all', () => {
    const tree = buildTree(['src/main/java/Foo.java', 'src/test/Bar.java']);
    expect(allDirPaths(tree).sort()).toEqual(['src', 'src/main/java', 'src/test']);
  });
});
