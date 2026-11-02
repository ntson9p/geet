import { describe, expect, it } from 'vitest';
import type { CommitFileDto } from '../../../src/shared/protocol';
import { buildTree } from '../../../webview-ui/src/lib/treeModel';
import { ancestorDirs, diffChain } from '../../../webview-ui/src/log/changedFilesChain';

const file = (path: string, status = 'M'): CommitFileDto => ({ status, path });
// In the order git lists them, which is not the order the tree shows them.
const FILES = [
  file('README.md'),
  file('logo.png', 'A'),
  file('src/added.ts', 'A'),
  file('src/app.ts'),
  file('src/lib/util.ts'),
  file('zdeleted.txt', 'D'),
];
const byPath = new Map(FILES.map((f) => [f.path, f]));
const nodes = buildTree(
  FILES.map((f) => f.path),
  { root: { path: '@repo', name: 'repo' } },
);
const of = (path: string): CommitFileDto => byPath.get(path)!;
const paths = (list: readonly CommitFileDto[]): string[] => list.map((f) => f.path);
/** Folders before files, at every level, as the pane draws them. */
const TREE_ORDER = ['src/lib/util.ts', 'src/added.ts', 'src/app.ts', 'logo.png', 'README.md', 'zdeleted.txt'];

describe('the files a diff from the Changed Files pane walks through', () => {
  it('follows the tree, not the order git listed them', () => {
    expect(paths(diffChain(nodes, byPath, new Set(), of('README.md')))).toEqual(TREE_ORDER);
  });

  it('is every file with one row selected, as IntelliJ does', () => {
    expect(paths(diffChain(nodes, byPath, new Set(['src/app.ts']), of('src/app.ts')))).toEqual(TREE_ORDER);
  });

  it('keeps added and deleted files: they are stops like any other', () => {
    const walked = paths(diffChain(nodes, byPath, new Set(), of('README.md')));
    expect(walked).toContain('src/added.ts');
    expect(walked).toContain('zdeleted.txt');
  });

  it('is only the selected rows with several selected, in tree order', () => {
    const selection = new Set(['zdeleted.txt', 'src/app.ts']);
    expect(paths(diffChain(nodes, byPath, selection, of('src/app.ts')))).toEqual(['src/app.ts', 'zdeleted.txt']);
  });

  it('is every file when a row outside the selection is opened', () => {
    const selection = new Set(['zdeleted.txt', 'src/app.ts']);
    expect(paths(diffChain(nodes, byPath, selection, of('README.md')))).toEqual(TREE_ORDER);
  });

  it('does not count selected folders as files', () => {
    const selection = new Set(['src', 'src/app.ts']);
    expect(paths(diffChain(nodes, byPath, selection, of('src/app.ts')))).toEqual(TREE_ORDER);
  });

  it('follows the flat list too', () => {
    const flat = [
      {
        kind: 'dir' as const,
        path: '@repo',
        name: 'repo',
        depth: 0,
        fileCount: FILES.length,
        children: FILES.map((f) => ({ kind: 'file' as const, path: f.path, name: f.path, depth: 1 })),
      },
    ];
    expect(paths(diffChain(flat, byPath, new Set(), of('README.md')))).toEqual(FILES.map((f) => f.path));
  });
});

describe('the folders to open to show a file', () => {
  it('are every row above it', () => {
    expect(ancestorDirs(nodes, 'src/lib/util.ts').sort()).toEqual(['@repo', 'src', 'src/lib'].sort());
  });

  it('are just the repository row for a file at the top', () => {
    expect(ancestorDirs(nodes, 'README.md')).toEqual(['@repo']);
  });

  it('are none for a file that is not there', () => {
    expect(ancestorDirs(nodes, 'nope.txt')).toEqual([]);
  });
});
