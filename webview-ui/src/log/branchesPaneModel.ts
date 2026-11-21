/**
 * The Branches pane's tree, built from the host's ref snapshot (P12-T2):
 * `HEAD (Current)` → `Local` (favorites first) → `Remote` per remote → `Tags`.
 * Pure, so what each toggle shows or hides is testable without a page:
 * favorites-only and the search box narrow it; `Branches Pane Settings · Show
 * Tags` (`geet.branches.showTags`) drops the `Tags` node altogether.
 */
import type { LogBranchesDto } from '../../../src/shared/protocol';
import { buildTree, type TreeDirNode, type TreeNode } from '../lib/treeModel';

export type RefType = 'local' | 'remote' | 'tag';

export interface RefEntry {
  name: string;
  type: RefType;
  favorite?: boolean;
  isCurrent?: boolean;
  /** A local branch with an upstream: `Stop Tracking` joins its menu. */
  tracked?: boolean;
}

export interface BranchesPaneOptions {
  /** The rail's star toggle: local branches narrow to favorites. */
  readonly favOnly: boolean;
  /** The rail's search box, as typed. */
  readonly search: string;
  /** IntelliJ's Show Tags: whether the `Tags` node exists at all. */
  readonly showTags: boolean;
}

export interface BranchesPaneTree {
  readonly nodes: TreeNode[];
  /** Row path → the ref it stands for; folder and section rows have none. */
  readonly refs: Map<string, RefEntry>;
}

function shiftDepth(node: TreeNode, delta: number): TreeNode {
  if (node.kind === 'file') return { ...node, depth: node.depth + delta };
  return {
    ...node,
    depth: node.depth + delta,
    children: node.children.map((c) => shiftDepth(c, delta)),
  };
}

function section(path: string, name: string, children: TreeNode[], fileCount: number): TreeDirNode {
  return { kind: 'dir', path, name, depth: 0, children, fileCount };
}

export function buildBranchesPaneTree(
  data: LogBranchesDto | null,
  { favOnly, search, showTags }: BranchesPaneOptions,
): BranchesPaneTree {
  const lookup = new Map<string, RefEntry>();
  const out: TreeNode[] = [];
  if (!data) return { nodes: out, refs: lookup };
  const query = search.trim().toLowerCase();

  // HEAD row restores the default filter.
  out.push({ kind: 'file', path: '@head', name: 'HEAD (Current)', depth: 0 });

  const locals = data.locals
    .filter((b) => !favOnly || b.favorite)
    .filter((b) => query.length === 0 || b.name.toLowerCase().includes(query));
  const favorites = locals.filter((b) => b.favorite);
  const rest = locals.filter((b) => !b.favorite);
  const localChildren: TreeNode[] = [];
  for (const [names, prefix] of [
    [favorites.map((b) => b.name), '@localfav'],
    [rest.map((b) => b.name), '@local'],
  ] as const) {
    for (const node of buildTree(names, { pathPrefix: prefix })) {
      localChildren.push(shiftDepth(node, 1));
    }
    for (const name of names) {
      const local = data.locals.find((b) => b.name === name);
      lookup.set(`${prefix}/${name}`, {
        name,
        type: 'local',
        favorite: local?.favorite === true,
        isCurrent: data.current === name,
        ...(local?.upstream !== undefined ? { tracked: true } : {}),
      });
    }
  }
  if (localChildren.length > 0 || query.length === 0) {
    out.push(section('@local', 'Local', localChildren, locals.length));
  }

  const remoteChildren: TreeNode[] = [];
  let remoteCount = 0;
  for (const group of data.remotes) {
    const shortNames = group.branches
      .map((b) => (b.startsWith(`${group.remote}/`) ? b.slice(group.remote.length + 1) : b))
      .filter((b) => query.length === 0 || b.toLowerCase().includes(query));
    if (shortNames.length === 0) continue;
    remoteCount += shortNames.length;
    const prefix = `@remote:${group.remote}`;
    const children = buildTree(shortNames, { pathPrefix: prefix }).map((n) => shiftDepth(n, 2));
    remoteChildren.push({
      kind: 'dir',
      path: prefix,
      name: group.remote,
      depth: 1,
      children,
      fileCount: shortNames.length,
    });
    for (const short of shortNames) {
      lookup.set(`${prefix}/${short}`, { name: `${group.remote}/${short}`, type: 'remote' });
    }
  }
  if (remoteChildren.length > 0) {
    out.push(section('@remotes', 'Remote', remoteChildren, remoteCount));
  }

  if (showTags) {
    const tags = data.tags.filter((t) => query.length === 0 || t.toLowerCase().includes(query));
    if (tags.length > 0) {
      const children = buildTree(tags, { pathPrefix: '@tags' }).map((n) => shiftDepth(n, 1));
      out.push(section('@tags', 'Tags', children, tags.length));
      for (const t of tags) lookup.set(`@tags/${t}`, { name: t, type: 'tag' });
    }
  }
  return { nodes: out, refs: lookup };
}
