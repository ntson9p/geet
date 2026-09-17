/**
 * Branches sidebar (new-way-2).
 *
 * The reason this is a webview and not a tree: **two search fields are live at
 * once** — one for the project, one inside the repository you opened — which is
 * what IntelliJ shows in its two panels, and which neither a `QuickPick` nor a
 * `TreeView` can hold. The other thing only a webview can do is draw a real
 * cascading `›` menu over its own rows.
 *
 * It renders and reports gestures; it decides nothing. Every row, and which
 * rows are open, comes from the host's `popupTree` — the same functions the
 * popup flattens — so the two surfaces cannot come to disagree.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BRANCHES_METHODS,
  type BranchesActionDto,
  type BranchesRowDto,
  type BranchesTreeDto,
} from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { RpcClient } from '../lib/rpc';

const rpc = new RpcClient();

/** One indent step, matching the tree indent VS Code uses in its own views. */
const INDENT = 12;

function Codicon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

interface HeaderProps {
  query: string;
  repoCount: number;
  showInOut: boolean;
  onQuery: (value: string) => void;
  onHeader: (id: string) => void;
}

function Header({ query, repoCount, showInOut, onQuery, onHeader }: HeaderProps) {
  return (
    <div className="gtb-header">
      <div className="gtb-search">
        <Codicon name="search" />
        <input
          className="gt-input gtb-search-input"
          type="text"
          value={query}
          placeholder={
            repoCount > 1
              ? 'Search for branches, actions, repositories'
              : 'Search for branches and actions'
          }
          aria-label="Search branches, actions and repositories"
          onChange={(e) => onQuery(e.currentTarget.value)}
        />
        {query.length > 0 ? (
          <button
            className="gt-toolbar-button gtb-clear"
            title="Clear"
            aria-label="Clear search"
            onClick={() => onQuery('')}
          >
            <Codicon name="close" />
          </button>
        ) : null}
      </div>
      <div className="gt-toolbar gtb-actions">
        <button
          className="gt-toolbar-button"
          title={repoCount > 1 ? 'Fetch all repositories' : 'Fetch'}
          aria-label="Fetch"
          onClick={() => onHeader('fetch')}
        >
          <Codicon name="sync" />
        </button>
        <button
          className={`gt-toolbar-button${showInOut ? ' gt-toggled' : ''}`}
          title="Show incoming/outgoing counts"
          aria-label="Show incoming/outgoing counts"
          aria-pressed={showInOut}
          onClick={() => onHeader('inout')}
        >
          <Codicon name="arrow-swap" />
        </button>
        <button
          className="gt-toolbar-button"
          title="Collapse all"
          aria-label="Collapse all"
          onClick={() => onHeader('collapse')}
        >
          <Codicon name="collapse-all" />
        </button>
        <button
          className="gt-toolbar-button"
          title="Branch settings"
          aria-label="Branch settings"
          onClick={() => onHeader('settings')}
        >
          <Codicon name="gear" />
        </button>
      </div>
    </div>
  );
}

interface RowProps {
  row: BranchesRowDto;
  open: boolean;
  focused: boolean;
  repoQuery: string;
  onToggle: (row: BranchesRowDto) => void;
  onActivate: (row: BranchesRowDto) => void;
  onActions: (row: BranchesRowDto, at: { x: number; y: number }) => void;
  onFavorite: (row: BranchesRowDto) => void;
  onRepoQuery: (root: string, value: string) => void;
  onFocus: (id: string) => void;
}

function Row({
  row,
  open,
  focused,
  repoQuery,
  onToggle,
  onActivate,
  onActions,
  onFavorite,
  onRepoQuery,
  onFocus,
}: RowProps) {
  const pad = 4 + row.depth * INDENT;

  if (row.kind === 'search') {
    // IntelliJ's second panel has its own field; in one narrow column it sits
    // directly under the repository it belongs to.
    return (
      <div className="gtb-row gtb-row-search" style={{ paddingLeft: pad }}>
        <Codicon name="search" />
        <input
          className="gt-input gtb-repo-search"
          type="text"
          value={repoQuery}
          placeholder="Search branches in this repository"
          aria-label="Search branches in this repository"
          onChange={(e) => onRepoQuery(row.repoRoot ?? '', e.currentTarget.value)}
        />
        {repoQuery.length > 0 ? (
          <button
            className="gt-toolbar-button gtb-clear"
            title="Clear"
            aria-label="Clear repository search"
            onClick={() => onRepoQuery(row.repoRoot ?? '', '')}
          >
            <Codicon name="close" />
          </button>
        ) : null}
      </div>
    );
  }

  if (row.kind === 'info') {
    return (
      <div className="gtb-row gtb-row-info" style={{ paddingLeft: pad }}>
        <Codicon name={row.icon} />
        <span className="gtb-label">{row.label}</span>
      </div>
    );
  }

  const isRef = row.ref !== undefined;
  const favouritable = isRef && row.ref?.type !== 'tag';
  const activate = (): void => {
    if (row.expandable) onToggle(row);
    else onActivate(row);
  };

  return (
    <div
      className={`gtb-row gtb-row-${row.kind}${focused ? ' gtb-focused' : ''}`}
      style={{ paddingLeft: pad }}
      role="treeitem"
      tabIndex={focused ? 0 : -1}
      aria-expanded={row.expandable ? open : undefined}
      aria-level={row.depth + 1}
      onClick={() => {
        onFocus(row.id);
        activate();
      }}
      onContextMenu={(e) => {
        if (!row.actions) return;
        e.preventDefault();
        onFocus(row.id);
        onActions(row, { x: e.clientX, y: e.clientY });
      }}
    >
      <span className="gtb-twisty">
        {row.expandable ? <Codicon name={open ? 'chevron-down' : 'chevron-right'} /> : null}
      </span>
      <span className={`gtb-icon${row.ref?.isHead === true ? ' gtb-current' : ''}`}>
        <Codicon name={row.icon} />
      </span>
      <span className={`gtb-label${row.ref?.isHead === true ? ' gtb-current' : ''}`}>
        {row.label}
      </span>
      {row.description !== undefined && row.description.length > 0 ? (
        <span className="gtb-description">{row.description}</span>
      ) : null}
      <span className="gtb-row-buttons">
        {favouritable ? (
          <button
            className="gt-toolbar-button gtb-star"
            title={row.favorite === true ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={row.favorite === true ? 'Remove from favorites' : 'Add to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(row);
            }}
          >
            <Codicon name={row.favorite === true ? 'star-full' : 'star-empty'} />
          </button>
        ) : null}
        {row.actions ? (
          <button
            className="gt-toolbar-button gtb-chevron"
            title="Branch actions"
            aria-label="Branch actions"
            onClick={(e) => {
              e.stopPropagation();
              onFocus(row.id);
              const r = e.currentTarget.getBoundingClientRect();
              onActions(row, { x: r.right, y: r.bottom });
            }}
          >
            <Codicon name="chevron-right" />
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function App() {
  const [tree, setTree] = useState<BranchesTreeDto | null>(null);
  const [focus, setFocus] = useState<string>('');
  const [menu, setMenu] = useState<{
    row: BranchesRowDto;
    items: MenuItem[];
    at: { x: number; y: number };
  } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback((next: BranchesTreeDto | null) => {
    if (next) setTree(next);
  }, []);

  useEffect(() => {
    void rpc.request<BranchesTreeDto | null>(BRANCHES_METHODS.init).then(apply);
    return rpc.onEvent(BRANCHES_METHODS.evtTree, (params) => apply(params as BranchesTreeDto));
  }, [apply]);

  const open = useMemo(() => new Set(tree?.open ?? []), [tree]);
  const repoQueries = useMemo(() => new Map(tree?.repoQueries ?? []), [tree]);

  const send = useCallback(
    (method: string, params: unknown) => {
      void rpc.request<BranchesTreeDto | null>(method, params).then(apply);
    },
    [apply],
  );

  const onActions = useCallback(
    (row: BranchesRowDto, at: { x: number; y: number }) => {
      void rpc.request<BranchesActionDto[]>(BRANCHES_METHODS.actions, { id: row.id }).then((list) => {
        if (!Array.isArray(list) || list.length === 0) return;
        const items: MenuItem[] = [];
        for (const action of list) {
          if (action.separator === true && items.length > 0) {
            items.push({ kind: 'separator', id: `sep-${action.id}` });
          }
          items.push({
            kind: 'item',
            id: action.id,
            label: action.label,
            ...(action.accelerator !== undefined ? { accelerator: action.accelerator } : {}),
          });
        }
        setMenu({ row, items, at });
      });
    },
    [],
  );

  const rows = tree?.rows ?? [];

  /** Arrow keys over the rows; Right opens a node, Left closes it. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const selectable = rows.filter((r) => r.kind !== 'search');
      if (selectable.length === 0) return;
      const index = selectable.findIndex((r) => r.id === focus);
      const row = index >= 0 ? selectable[index] : undefined;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus((selectable[Math.min(index + 1, selectable.length - 1)] ?? selectable[0])!.id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus((selectable[Math.max(index - 1, 0)] ?? selectable[0])!.id);
      } else if (e.key === 'ArrowRight' && row?.expandable && !open.has(row.id)) {
        e.preventDefault();
        send(BRANCHES_METHODS.toggle, { id: row.id });
      } else if (e.key === 'ArrowLeft' && row?.expandable && open.has(row.id)) {
        e.preventDefault();
        send(BRANCHES_METHODS.toggle, { id: row.id });
      } else if (e.key === 'Enter' && row) {
        e.preventDefault();
        if (row.expandable) send(BRANCHES_METHODS.toggle, { id: row.id });
        else send(BRANCHES_METHODS.activate, { id: row.id });
      }
    },
    [rows, focus, open, send],
  );

  if (!tree) return <div className="gtb-empty">Loading…</div>;

  return (
    <div className="gtb-root">
      <Header
        query={tree.topQuery}
        repoCount={tree.repoCount}
        showInOut={tree.showInOut}
        onQuery={(value) => send(BRANCHES_METHODS.setTopQuery, { query: value })}
        onHeader={(id) => send(BRANCHES_METHODS.header, { id })}
      />
      <div
        className="gtb-list"
        role="tree"
        aria-label="Branches"
        ref={listRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => (
          <div key={row.id}>
            {row.separator !== undefined ? (
              <div className="gtb-separator">{row.separator}</div>
            ) : null}
            <Row
              row={row}
              open={open.has(row.id)}
              focused={focus === row.id}
              repoQuery={repoQueries.get(row.repoRoot ?? '') ?? ''}
              onToggle={(r) => send(BRANCHES_METHODS.toggle, { id: r.id })}
              onActivate={(r) => send(BRANCHES_METHODS.activate, { id: r.id })}
              onActions={onActions}
              onFavorite={(r) => send(BRANCHES_METHODS.toggleFavorite, { id: r.id })}
              onRepoQuery={(root, value) =>
                send(BRANCHES_METHODS.setRepoQuery, { root, query: value })
              }
              onFocus={setFocus}
            />
          </div>
        ))}
      </div>
      {menu ? (
        <Menu
          items={menu.items}
          at={menu.at}
          ariaLabel={`Actions for ${menu.row.label}`}
          onSelect={(id) => {
            setMenu(null);
            void rpc.request(BRANCHES_METHODS.runAction, { id: menu.row.id, action: id });
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
