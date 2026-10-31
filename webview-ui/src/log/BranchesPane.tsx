/**
 * Branches pane (P12-T2): `HEAD (Current)` → `Local` (folder nodes from
 * treeModel, favorites first with a star) → `Remote` per remote → `Tags`,
 * with the §2A vertical icon rail on the left edge. Selecting refs filters
 * the Commits pane; `HEAD (Current)` restores the default; selection is
 * additive with Ctrl. Context menus are native (`data-vscode-context` →
 * `gittree.log.branch.*`), dispatching the same registry as the tree view.
 * The rail's gear is IntelliJ's `Branches Pane Settings`, holding `Show Tags`.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  LOG_METHODS,
  type LogBranchesDto,
  type LogFilterDto,
} from '../../../src/shared/protocol';
import { FileTree } from '../lib/FileTree';
import { Menu, type MenuItem } from '../lib/Menu';
import type { RpcClient } from '../lib/rpc';
import { ToolbarButton } from '../lib/Toolbar';
import type { TreeNode } from '../lib/treeModel';
import { useElementSize } from '../lib/useElementSize';
import { buildBranchesPaneTree, type RefEntry } from './branchesPaneModel';

export interface BranchesPaneProps {
  rpc: RpcClient;
  /** P12-T5: the refs snapshot is fetched once in App and shared with the filter row. */
  data: LogBranchesDto | null;
  repoRoot: string | undefined;
  filter: LogFilterDto;
  onFilterChange: (next: LogFilterDto) => void;
  onCollapsePane: () => void;
  /** `Branches Pane Settings · Show Tags` (`gittree.branches.showTags`). */
  showTags: boolean;
  onShowTagsChange: (next: boolean) => void;
}

export function BranchesPane({
  rpc,
  data,
  repoRoot,
  filter,
  onFilterChange,
  onCollapsePane,
  showTags,
  onShowTagsChange,
}: BranchesPaneProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(['@local', '@remotes']),
  );
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  const [favOnly, setFavOnly] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [settingsAt, setSettingsAt] = useState<{ x: number; y: number } | null>(null);
  const [paneRef, paneSize] = useElementSize<HTMLDivElement>();

  const { nodes, refs } = useMemo(
    () => buildBranchesPaneTree(data, { favOnly, search, showTags }),
    [data, favOnly, search, showTags],
  );

  // IntelliJ's menu also holds the single-click action and Group By Directory.
  // Only what GitTree does is listed: a click filters the log, and branches
  // always group by directory.
  const settingsItems: MenuItem[] = [
    { kind: 'item', id: 'showTags', label: 'Show Tags', checked: showTags },
  ];

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
        <ToolbarButton
          icon="gear"
          label="Branches Pane Settings"
          onClick={(e) => {
            // The rail is a vertical strip on the pane's left edge, so the
            // menu opens beside the button rather than under it.
            const box = e.currentTarget.getBoundingClientRect();
            setSettingsAt({ x: box.right + 2, y: box.top });
          }}
        />
        <ToolbarButton icon="chevron-left" label="Collapse pane" onClick={onCollapsePane} />
      </div>
      {settingsAt !== null ? (
        <Menu
          items={settingsItems}
          at={settingsAt}
          ariaLabel="Branches Pane Settings"
          onClose={() => setSettingsAt(null)}
          onSelect={(id) => {
            if (id === 'showTags') onShowTagsChange(!showTags);
          }}
        />
      ) : null}
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
