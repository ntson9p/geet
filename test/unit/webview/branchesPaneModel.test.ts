import { describe, expect, it } from 'vitest';
import type { LogBranchesDto } from '../../../src/shared/protocol';
import type { TreeNode } from '../../../webview-ui/src/lib/treeModel';
import { buildBranchesPaneTree } from '../../../webview-ui/src/log/branchesPaneModel';

const DATA: LogBranchesDto = {
  current: 'main',
  detached: false,
  locals: [
    { name: 'main', favorite: false },
    { name: 'release', favorite: true },
    { name: 'feature/tags', favorite: false },
  ],
  remotes: [{ remote: 'origin', branches: ['origin/main', 'origin/feature/tags'] }],
  tags: ['v1.0.0', 'v1.0.1', 'v1.1.0-beta.1'],
};

const ALL = { favOnly: false, search: '', showTags: true };
const sections = (nodes: readonly TreeNode[]): string[] => nodes.map((n) => n.path);
const tagsNode = (nodes: readonly TreeNode[]) => nodes.find((n) => n.path === '@tags');

describe('buildBranchesPaneTree', () => {
  it('lists HEAD, Local, Remote and Tags, in IntelliJ\'s order', () => {
    const { nodes } = buildBranchesPaneTree(DATA, ALL);
    expect(sections(nodes)).toEqual(['@head', '@local', '@remotes', '@tags']);
    const tags = tagsNode(nodes);
    expect(tags?.kind === 'dir' ? tags.fileCount : undefined).toBe(3);
  });

  it('maps tag rows to their refs, so a click filters the log by the tag', () => {
    const { refs } = buildBranchesPaneTree(DATA, ALL);
    expect(refs.get('@tags/v1.0.0')).toEqual({ name: 'v1.0.0', type: 'tag' });
  });

  it('marks the local branches with an upstream: what adds Stop Tracking to their menu', () => {
    const { refs } = buildBranchesPaneTree(
      {
        detached: false,
        locals: [
          { name: 'mine', favorite: false, upstream: 'origin/develop' },
          { name: 'other', favorite: false },
        ],
        remotes: [],
        tags: [],
      },
      { favOnly: false, search: '', showTags: true },
    );
    expect(refs.get('@local/mine')?.tracked).toBe(true);
    expect(refs.get('@local/other')?.tracked).toBeUndefined();
  });

  describe('Branches Pane Settings · Show Tags', () => {
    it('drops the Tags node when it is off', () => {
      const { nodes, refs } = buildBranchesPaneTree(DATA, { ...ALL, showTags: false });
      expect(sections(nodes)).toEqual(['@head', '@local', '@remotes']);
      expect([...refs.values()].some((r) => r.type === 'tag')).toBe(false);
    });

    it('keeps tags out of the search box\'s results', () => {
      const shown = buildBranchesPaneTree(DATA, { ...ALL, search: 'v1' });
      expect(tagsNode(shown.nodes)).toBeDefined();
      const hidden = buildBranchesPaneTree(DATA, { ...ALL, search: 'v1', showTags: false });
      expect(tagsNode(hidden.nodes)).toBeUndefined();
    });

    it('leaves the branches as they were', () => {
      const on = buildBranchesPaneTree(DATA, ALL);
      const off = buildBranchesPaneTree(DATA, { ...ALL, showTags: false });
      const branchRefs = (tree: typeof on) =>
        [...tree.refs.entries()].filter(([, r]) => r.type !== 'tag');
      expect(branchRefs(off)).toEqual(branchRefs(on));
    });
  });

  it('still narrows locals to favorites and to the search', () => {
    const fav = buildBranchesPaneTree(DATA, { ...ALL, favOnly: true });
    expect([...fav.refs.values()].filter((r) => r.type === 'local').map((r) => r.name)).toEqual([
      'release',
    ]);
    const searched = buildBranchesPaneTree(DATA, { ...ALL, search: 'tags' });
    expect([...searched.refs.values()].map((r) => r.name)).toEqual([
      'feature/tags',
      'origin/feature/tags',
    ]);
  });

  it('has nothing to list before the snapshot arrives', () => {
    const { nodes, refs } = buildBranchesPaneTree(null, ALL);
    expect(nodes).toEqual([]);
    expect(refs.size).toBe(0);
  });
});
