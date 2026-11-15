import { describe, expect, it } from 'vitest';
import { buildPathTree, mergeTreeSelection, type PathTreeItem } from '../../../src/log/pathTree';

/** `path@depth` — the two things a flattened tree has to get right. */
function shape(items: readonly PathTreeItem[]): string[] {
  return items.map((i) => `${i.kind === 'dir' ? 'D' : 'F'} ${i.path}@${i.depth}`);
}

describe('buildPathTree', () => {
  it('orders as a tree: a directory is followed by its own contents', () => {
    const tree = buildPathTree(['src/a.ts', 'src/nested/b.ts', 'README.md']);
    expect(shape(tree.items)).toEqual([
      'D src@0',
      'D src/nested@1',
      'F src/nested/b.ts@2',
      'F src/a.ts@1',
      'F README.md@0',
    ]);
    expect(tree.mode).toBe('full');
  });

  it('sorts directories before files, each alphabetically, at every level', () => {
    const tree = buildPathTree(['z.txt', 'a.txt', 'beta/one.txt', 'alpha/two.txt']);
    expect(shape(tree.items)).toEqual([
      'D alpha@0',
      'F alpha/two.txt@1',
      'D beta@0',
      'F beta/one.txt@1',
      'F a.txt@0',
      'F z.txt@0',
    ]);
  });

  it('counts directories and files, and names the leaf segment', () => {
    const tree = buildPathTree(['src/a.ts', 'src/b.ts']);
    // one directory + two files
    expect(tree.total).toBe(3);
    expect(tree.items.map((i) => i.name)).toEqual(['src', 'a.ts', 'b.ts']);
  });

  it('a repository with no tracked files yields nothing rather than a root row', () => {
    expect(buildPathTree([])).toEqual({ items: [], total: 0, mode: 'full' });
  });

  it('ignores empty and trailing-slash segments instead of inventing rows', () => {
    const tree = buildPathTree(['', 'src//a.ts', '/b.ts']);
    expect(shape(tree.items)).toEqual(['D src@0', 'F src/a.ts@1', 'F b.ts@0']);
  });

  it('a path appearing under two parents does not collapse them', () => {
    const tree = buildPathTree(['web/api/x.ts', 'mobile/api/x.ts']);
    expect(shape(tree.items)).toEqual([
      'D mobile@0',
      'D mobile/api@1',
      'F mobile/api/x.ts@2',
      'D web@0',
      'D web/api@1',
      'F web/api/x.ts@2',
    ]);
  });

  it('over the limit it drops files wholesale, not the alphabetical tail', () => {
    // 3 dirs + 6 files = 9 entries, limited to 4.
    const paths = ['a/1.ts', 'a/2.ts', 'b/3.ts', 'b/4.ts', 'c/5.ts', 'c/6.ts'];
    const tree = buildPathTree(paths, 4);
    expect(tree.mode).toBe('dirsOnly');
    expect(tree.total).toBe(9);
    // Every directory survives — a cap applied mid-walk would have left `c`
    // unreachable by search, which reads as "this repository has no c".
    expect(shape(tree.items)).toEqual(['D a@0', 'D b@0', 'D c@0']);
  });

  it('when the directories alone overflow it truncates and says so', () => {
    const paths = ['a/x.ts', 'b/x.ts', 'c/x.ts'];
    const tree = buildPathTree(paths, 2);
    expect(tree.mode).toBe('truncated');
    expect(tree.items).toHaveLength(2);
    expect(tree.items.every((i) => i.kind === 'dir')).toBe(true);
    expect(tree.total).toBe(6);
  });

  it('exactly at the limit is still the full tree', () => {
    const tree = buildPathTree(['a/x.ts'], 2);
    expect(tree.mode).toBe('full');
    expect(shape(tree.items)).toEqual(['D a@0', 'F a/x.ts@1']);
  });

  it('every emitted path is a real pathspec — no leading or doubled slashes', () => {
    const tree = buildPathTree(['src/nested/deep/file.ts', 'top.ts']);
    for (const item of tree.items) {
      expect(item.path.startsWith('/')).toBe(false);
      expect(item.path).not.toContain('//');
      expect(item.path.endsWith('/')).toBe(false);
      expect(item.path.split('/').length - 1).toBe(item.depth);
    }
  });
});

describe('mergeTreeSelection', () => {
  it('replaces what the tree offered with what came back', () => {
    expect(mergeTreeSelection(['src', 'docs'], ['src', 'docs', 'test'], ['docs', 'test'])).toEqual([
      'docs',
      'test',
    ]);
  });

  it('keeps a glob the tree could never have shown', () => {
    // The glob has no row, so accepting the pick must not read as un-ticking it.
    expect(mergeTreeSelection(['src/**/*.ts', 'docs'], ['src', 'docs'], ['src'])).toEqual([
      'src/**/*.ts',
      'src',
    ]);
  });

  it('keeps a path the folders-only mode withheld', () => {
    expect(mergeTreeSelection(['src/a.ts'], ['src', 'docs'], ['docs'])).toEqual(['src/a.ts', 'docs']);
  });

  it('un-ticking everything the tree offered clears exactly those', () => {
    expect(mergeTreeSelection(['src', 'docs'], ['src', 'docs'], [])).toEqual([]);
    expect(mergeTreeSelection(['src', 'x*.ts'], ['src'], [])).toEqual(['x*.ts']);
  });

  it('never emits a duplicate', () => {
    expect(mergeTreeSelection(['src'], ['src'], ['src', 'src'])).toEqual(['src']);
  });

  it("POST-P14ck: with both spellings of each row offered, a pick's older bare spelling gives way", () => {
    // Select in Tree offers each row as itself and as its literal pathspec, and
    // hands picks back literal: `app/[id]` picked before the fix, kept ticked,
    // comes back as `:(literal)app/[id]`; a typed glob with no row stays.
    expect(
      mergeTreeSelection(
        ['app/[id]', 'src/*.ts', 'docs'],
        ['app/[id]', ':(literal)app/[id]', 'docs'],
        [':(literal)app/[id]'],
      ),
    ).toEqual(['src/*.ts', ':(literal)app/[id]']);
  });
});
