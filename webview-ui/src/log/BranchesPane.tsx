/**
 * Branches pane (P12-T2): `HEAD (Current)` → `Local` (folder nodes from
 * treeModel, favorites first with a star) → `Remote` per remote → `Tags`,
 * with the §2A vertical icon rail on the left edge. Selecting refs filters
 * the Commits pane; `HEAD (Current)` restores the default; selection is
 * additive with Ctrl. Context menus are native (`data-vscode-context` →
 * `gittree.log.branch.*`), dispatching the same registry as the tree view.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  LOG_METHODS,
  type LogBranchesDto,
  type LogFilterDto,
} from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import type { RpcClient } from '../lib/rpc';
import { ToolbarButton } from '../lib/Toolbar';
import { buildTree, type TreeDirNode, type TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';

type RefType = 'local' | 'remote' | 'tag';

interface RefEntry {
  name: string;
  type: RefType;
  favorite?: boolean;
  isCurrent?: boolean;
}

export interface BranchesPaneProps {
  rpc: RpcClient;
  /** P12-T5: the refs snapshot is fetched once in App and shared with the filter row. */
  data: LogBranchesDto | null;
  repoRoot: string | undefined;
  filter: LogFilterDto;
  onFilterChange: (next: LogFilterDto) => void;
  onCollapsePane: () => void;
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

export function BranchesPane({ rpc, data, repoRoot, filter, onFilterChange, onCollapsePane }: BranchesPaneProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(['@local', '@remotes']),
  );
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [favOnly, setFavOnly] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  const { nodes, refs } = useMemo(() => {
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

    const tags = data.tags.filter((t) => query.length === 0 || t.toLowerCase().includes(query));
    if (tags.length > 0) {
      const children = buildTree(tags, { pathPrefix: '@tags' }).map((n) => shiftDepth(n, 1));
      out.push(section('@tags', 'Tags', children, tags.length));
      for (const t of tags) lookup.set(`@tags/${t}`, { name: t, type: 'tag' });
    }
    return { nodes: out, refs: lookup };
  }, [data, favOnly, search]);

  const applyRefSelection = useCallback(
    (paths: string[]) => {
      setSelection(new Set(paths));
      const names = paths
        .map((p) => refs.get(p)?.name)
        .filter((n): n is string => n !== undefined);
      const wantsHead = paths.includes('@head') || names.length === 0;
      const nextRefs: LogFilterDto['refs'] = wantsHead ? 'HEAD' : names;
      if (JSON.stringify(filter.refs ?? 'HEAD') === JSON.stringify(nextRefs)) return;
      const next: LogFilterDto = { ...filter, refs: nextRefs };
      delete next.range;
      onFilterChange(next);
    },
    [filter, onFilterChange, refs],
  );

  const selectedRef = useMemo((): RefEntry | undefined => {
    if (selection.size !== 1) return undefined;
    const [only] = [...selection];
    return only === undefined ? undefined : refs.get(only);
  }, [refs, selection]);

  const act = useCallback(
    (action: string, ref?: RefEntry) => {
      void rpc
        .request(LOG_METHODS.branchAction, {
          action,
          ...(ref !== undefined ? { name: ref.name, type: ref.type } : {}),
        })
        .catch(() => undefined);
    },
    [rpc],
  );

  const myCommitsOn = useMemo(
    () =>
      data?.myAuthor !== undefined &&
      Array.isArray(filter.authors) &&
      filter.authors.length === 1 &&
      filter.authors[0] === data.myAuthor,
    [data, filter.authors],
  );

  const toggleMyCommits = useCallback(() => {
    if (data?.myAuthor === undefined) return;
    const next: LogFilterDto = { ...filter };
    if (myCommitsOn) delete next.authors;
    else next.authors = [data.myAuthor];
    onFilterChange(next);
  }, [data, filter, myCommitsOn, onFilterChange]);

  const description = useCallback(
    (node: TreeNode): string | undefined => {
      if (node.path === '@head') return data?.current ?? (data?.detached ? 'detached' : undefined);
      if (node.kind === 'dir' && node.path.startsWith('@')) {
        return `${node.fileCount}`;
      }
      const ref = refs.get(node.path);
      return ref?.isCurrent === true ? 'current' : undefined;
    },
    [data, refs],
  );

  const icon = useCallback(
    (node: TreeNode) => {
      if (node.path === '@head') return { codicon: 'target' };
      if (node.kind === 'dir') {
        return node.path.startsWith('@remote:') ? { codicon: 'cloud' } : { codicon: 'folder' };
      }
      const ref = refs.get(node.path);
      if (!ref) return { codicon: 'git-branch' };
      if (ref.type === 'tag') return { codicon: 'tag' };
      if (ref.favorite === true) return { codicon: 'star-full', color: 'var(--vscode-charts-yellow)' };
      return { codicon: 'git-branch' };
    },
    [refs],
  );

  const rowContext = useCallback(
    (node: TreeNode): Record<string, unknown> | undefined => {
      const ref = refs.get(node.path);
      if (!ref || repoRoot === undefined) return undefined;
      return {
        preventDefaultContextMenuItems: true,
        webviewSection: 'logBranch',
        repoRoot,
        refName: ref.name,
        refType: ref.type,
      };
    },
    [refs, repoRoot],
  );

  return (
    <div className="gt-branches-pane" data-testid="branches-pane">
      <div className="gt-branches-rail" role="toolbar" aria-label="Branch actions" aria-orientation="vertical">
        <ToolbarButton icon="add" label="New Branch" onClick={() => act('new')} />
        <ToolbarButton
          icon="remove"
          label="Delete Branch"
          disabled={selectedRef?.type !== 'local' || selectedRef.isCurrent === true}
          onClick={() => act('delete', selectedRef)}
        />
        <ToolbarButton
          icon="git-compare"
          label="Compare with Current"
          disabled={selectedRef === undefined || selectedRef.isCurrent === true}
          onClick={() => act('compareWithCurrent', selectedRef)}
        />
        <ToolbarButton
          icon="search"
          label="Filter branches"
          toggled={searchOpen}
          onClick={() => {
            setSearchOpen((v) => !v);
            setSearch('');
          }}
        />
        <ToolbarButton
          icon="star-full"
          label="Favorites only"
          toggled={favOnly}
          onClick={() => setFavOnly((v) => !v)}
        />
        <ToolbarButton
          icon="account"
          label="Show my commits"
          disabled={data?.myAuthor === undefined}
          toggled={myCommitsOn}
          onClick={toggleMyCommits}
        />
        <ToolbarButton icon="chevron-left" label="Collapse pane" onClick={onCollapsePane} />
      </div>
      <div className="gt-branches-body" ref={paneRef}>
        {searchOpen ? (
          <input
            className="gt-input gt-branches-search"
            aria-label="Filter branches"
            data-testid="branches-search"
            placeholder="Filter branches"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
          />
        ) : null}
        {!data ? (
          <div className="gt-pane-empty gt-muted">Loading branches…</div>
        ) : (
          <FileTree
            nodes={nodes}
            height={Math.max(0, paneSize.height - (searchOpen ? 28 : 0))}
            ariaLabel="Branches"
            expanded={expanded}
            onToggleExpand={(path, open) => {
              setExpanded((prev) => {
                const next = new Set(prev);
                if (open) next.add(path);
                else next.delete(path);
                return next;
              });
            }}
            selection={selection}
            onSelectionChange={applyRefSelection}
            description={description}
            icon={icon}
            rowContext={rowContext}
          />
        )}
      </div>
    </div>
  );
}
