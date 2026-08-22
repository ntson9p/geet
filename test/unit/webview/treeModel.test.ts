import { describe, expect, it } from 'vitest';
import {
  allDirPaths,
  buildTree,
  collectFiles,
  countFiles,
  findNode,
  flatten,
  rollup,
  rowIndexOf,
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
