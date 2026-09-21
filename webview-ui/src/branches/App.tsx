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
 *
 * **Windowed.** A repository with every section open is several hundred rows,
 * and seven of them is thousands; the shared `VirtualList` renders only what
 * fits. That component owns focus and keyboard, which takes care around the
 * inline `<input>` — see `SearchRow` and `onRowKeyDown`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  BRANCHES_METHODS,
  type BranchesActionDto,
  type BranchesRowDto,
  type BranchesTreeDto,
} from '../../../src/shared/protocol';
import { Menu, type MenuItem } from '../lib/Menu';
import { RpcClient } from '../lib/rpc';
import { useElementSize } from '../lib/useElementSize';
import { VirtualList, type VirtualListHandle } from '../lib/VirtualList';

const rpc = new RpcClient();

/** One indent step, and the row height VS Code's own trees use. */
const INDENT = 12;
const ROW_HEIGHT = 22;

/**
 * Separators become rows of their own. `VirtualList` is fixed-height, and a
 * rule folded into the row beneath it would make that one row taller than
 * every other — which is exactly what fixed-height windowing cannot express.
 */
type DisplayRow =
  | { readonly kind: 'separator'; readonly id: string; readonly label: string }
  | { readonly kind: 'row'; readonly id: string; readonly row: BranchesRowDto };

function toDisplayRows(rows: readonly BranchesRowDto[]): DisplayRow[] {
  const out: DisplayRow[] = [];
  for (const row of rows) {
    if (row.separator !== undefined) {
      out.push({ kind: 'separator', id: `sep:${row.id}`, label: row.separator });
    }
    out.push({ kind: 'row', id: row.id, row });
  }
  return out;
}

function Codicon({ name }: { name: string }) {
  return <span className={`codicon codicon-${name}`} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * A repository's own search field — IntelliJ's second panel, drawn inline.
 *
 * It sits inside a `VirtualList` row, and that list owns focus and keyboard:
 * its row `onClick` calls `focusIndex`, which moves DOM focus to the row and
 * would take it straight back out of this field, and its `onKeyDown` would
 * read the arrow keys someone is using to move the caret. So every pointer and
 * key event that belongs to the field is stopped here, at the field.
 *
 * **Why typing here does not lose the caret**, given the list keys its rows by
 * index and a keystroke brings a whole new row set from the host: nothing above
 * this row can move while you type in it. The verbs, the separators and the
 * repository rows are fixed, and only *this* repository's subtree is being
 * filtered — which is entirely below. The index is therefore invariant, React
 * reconciles the same position, and the `<input>` element survives. The list
 * cannot scroll it out of view either: a shrinking result set clamps `scrollTop`
 * upwards, which moves this row towards the viewport, never away from it.
 */
function SearchRow({
  value,
  padding,
  onChange,
}: {
  value: string;
  padding: number;
  onChange: (value: string) => void;
}) {
  return (
    <div
      className="gtb-body gtb-body-search"
      style={{ paddingLeft: padding }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Codicon name="search" />
      <input
        className="gt-input gtb-repo-search"
        type="text"
        value={value}
        placeholder="Search branches in this repository"
        aria-label="Search branches in this repository"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {value.length > 0 ? (
        <button
          className="gt-toolbar-button gtb-clear"
          title="Clear"
          aria-label="Clear repository search"
          onClick={() => onChange('')}
        >
          <Codicon name="close" />
        </button>
      ) : null}
    </div>
  );
}

interface RowBodyProps {
  row: BranchesRowDto;
  open: boolean;
  onActions: (row: BranchesRowDto, at: { x: number; y: number }) => void;
  onFavorite: (row: BranchesRowDto) => void;
}

function RowBody({ row, open, onActions, onFavorite }: RowBodyProps) {
  const padding = row.depth * INDENT;
  const current = row.ref?.isHead === true;
  const favouritable = row.ref !== undefined && row.ref.type !== 'tag';
  /**
   * Which rows own a menu *here*. Not `row.actions`, which is the shared
   * model's flag and is also true of a repository row, because in the popup a
   * repository's `›` means "go into it" — a thing this view already does by
   * clicking the row, and a `›` that duplicated the twisty would be a second
   * button for the same gesture. Drawing one on a repository row was worse than
   * redundant while the menu was hover-revealed and is now plainly wrong, since
   * the button is always visible and would never do anything.
   */
  const hasMenu = row.ref !== undefined || row.common !== undefined;

  if (row.kind === 'info') {
    return (
      <div className="gtb-body gtb-body-info" style={{ paddingLeft: padding }}>
        <Codicon name={row.icon} />
        <span className="gtb-label">{row.label}</span>
      </div>
    );
  }

  return (
    <div className="gtb-body" style={{ paddingLeft: padding }}>
      <span className="gtb-twisty">
        {row.expandable ? <Codicon name={open ? 'chevron-down' : 'chevron-right'} /> : null}
      </span>
      <span className={`gtb-icon${current ? ' gtb-current' : ''}`}>
        <Codicon name={row.icon} />
      </span>
      <span className={`gtb-label${current ? ' gtb-current' : ''}`}>{row.label}</span>
      {row.description !== undefined && row.description.length > 0 ? (
        <span className="gtb-description">{row.description}</span>
      ) : null}
      <span className="gtb-row-buttons">
        {favouritable ? (
          <button
            className={`gt-toolbar-button gtb-star${row.favorite === true ? ' gtb-on' : ''}`}
            title={row.favorite === true ? 'Remove from favorites' : 'Add to favorites'}
            aria-label={row.favorite === true ? 'Remove from favorites' : 'Add to favorites'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onFavorite(row);
            }}
          >
            <Codicon name={row.favorite === true ? 'star-full' : 'star-empty'} />
          </button>
        ) : null}
        {hasMenu ? (
          <button
            className="gt-toolbar-button gtb-chevron"
            title="Branch actions"
            aria-label="Branch actions"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const [tree, setTree] = useState<BranchesTreeDto | null>(null);
  const [menu, setMenu] = useState<{
    row: BranchesRowDto;
    items: MenuItem[];
    at: { x: number; y: number };
  } | null>(null);

  /**
   * The fields are driven from here, not from the host's echo. A controlled
   * input whose value only comes back after a round trip drops characters and
   * jumps the caret when someone types faster than the trip; the host is told
   * what was typed, and its echo is read only once, to restore a reloaded view.
   */
  const [topQuery, setTopQuery] = useState('');
  const [repoQueries, setRepoQueries] = useState<Record<string, string>>({});
  const seeded = useRef(false);

  const [listRef, listSize] = useElementSize<HTMLDivElement>();
  const virtual = useRef<VirtualListHandle | null>(null);

  const apply = useCallback((next: BranchesTreeDto | null) => {
    if (next) setTree(next);
  }, []);

  useEffect(() => {
    void rpc.request<BranchesTreeDto | null>(BRANCHES_METHODS.init).then(apply);
    return rpc.onEvent(BRANCHES_METHODS.evtTree, (params) => apply(params as BranchesTreeDto));
  }, [apply]);

  useEffect(() => {
    if (!tree || seeded.current) return;
    seeded.current = true;
    setTopQuery(tree.topQuery);
    setRepoQueries(Object.fromEntries(tree.repoQueries));
  }, [tree]);

  const send = useCallback(
    (method: string, params: unknown) => {
      void rpc.request<BranchesTreeDto | null>(method, params).then(apply);
    },
    [apply],
  );

  const open = useMemo(() => new Set(tree?.open ?? []), [tree]);
  const display = useMemo(() => toDisplayRows(tree?.rows ?? []), [tree]);

  const setTop = useCallback(
    (value: string) => {
      setTopQuery(value);
      send(BRANCHES_METHODS.setTopQuery, { query: value });
    },
    [send],
  );

  const setRepo = useCallback(
    (root: string, value: string) => {
      setRepoQueries((prev) => ({ ...prev, [root]: value }));
      send(BRANCHES_METHODS.setRepoQuery, { root, query: value });
    },
    [send],
  );

  const openActions = useCallback((row: BranchesRowDto, at: { x: number; y: number }) => {
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
  }, []);

  /**
   * The `›` button, for the two kinds of row that own a menu. A ref's is drawn
   * here, over the rows; a common ref's is the host's, because its actions run
   * once per repository and are picked from a list this view does not hold.
   */
  const rowMenu = useCallback(
    (row: BranchesRowDto, at: { x: number; y: number }) => {
      if (row.ref !== undefined) {
        openActions(row, at);
        return;
      }
      if (row.common !== undefined) send(BRANCHES_METHODS.activate, { id: row.id });
    },
    [openActions, send],
  );

  /**
   * Where a row's menu opens: anchored to the row itself, read from the DOM at
   * the moment it is needed. Not the pointer position — `onRowClick` does not
   * carry one, and anchoring to the row is what a submenu should do anyway, so
   * Enter and a click put the menu in the same place.
   */
  const anchorFor = useCallback((index: number): { x: number; y: number } => {
    const el = document.querySelector<HTMLElement>(`[data-gt-row="${index}"]`);
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + 16), y: Math.round(r.bottom) };
  }, []);

  /**
   * What activating a row means, and **where a branch row differs by gesture**.
   *
   * A click on a branch does nothing: not a checkout, not a menu. Only the `›`
   * button opens the menu, because a menu is a surface arriving over the list
   * and that does not belong on the gesture people use to move around the list.
   * (IntelliJ can put it there — its submenu opens beside the row and leaves the
   * list standing. Nothing in VS Code floats a submenu beside a `QuickPick`,
   * which is D5, so the popup cannot follow IntelliJ here and this view matches
   * the popup rather than drifting from it.)
   *
   * Enter still opens it. A `QuickPick` reports one accept and cannot tell a
   * click from Enter, but this list can, and Enter is the only key that reaches
   * a row's menu — the `›` button is not in the tab order, since the list holds
   * a single roving tabstop across several hundred rows.
   *
   * Verb rows — `New Branch…`, `Checkout Tag or Revision…` — run on a click as
   * before. They are actions that say what they do; a branch is a noun.
   */
  const activate = useCallback(
    (index: number, source: 'click' | 'key') => {
      const entry = display[index];
      if (entry?.kind !== 'row') return;
      const row = entry.row;
      if (row.kind === 'search' || row.kind === 'info') return;
      if (row.expandable) {
        send(BRANCHES_METHODS.toggle, { id: row.id });
        return;
      }
      if (row.ref !== undefined) {
        if (source === 'click') return;
        openActions(row, anchorFor(index));
        return;
      }
      // A ref every root shares: its menu is the host's, since the actions run
      // once per repository and are chosen from a list this view does not hold.
      if (row.common !== undefined && source === 'click') return;
      send(BRANCHES_METHODS.activate, { id: row.id });
    },
    [anchorFor, display, openActions, send],
  );

  /**
   * Runs before `VirtualList`'s own key model. Arrows step over separators,
   * which are rows here but are not anything a user wants to land on; Right and
   * Left open and close; Space is swallowed, because activating a row is what
   * Enter is for and Space in a list should not check out a branch.
   */
  const onRowKeyDown = useCallback(
    (index: number, e: KeyboardEvent<HTMLDivElement>): boolean => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const step = e.key === 'ArrowDown' ? 1 : -1;
        let next = index + step;
        while (display[next]?.kind === 'separator') next += step;
        if (next < 0 || next >= display.length) {
          e.preventDefault();
          return true;
        }
        e.preventDefault();
        virtual.current?.focusIndex(next);
        return true;
      }
      const entry = display[index];
      const row = entry?.kind === 'row' ? entry.row : undefined;
      // Enter is handled here rather than through `onActivate`, which the
      // shared list also fires on double-click: a double-click is two clicks,
      // each of which has already activated the row, so a third would open a
      // menu that the second one just opened.
      if (e.key === 'Enter') {
        e.preventDefault();
        activate(index, 'key');
        return true;
      }
      if (e.key === ' ') {
        e.preventDefault();
        return true;
      }
      if (row?.expandable === true && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const wantOpen = e.key === 'ArrowRight';
        if (open.has(row.id) !== wantOpen) {
          e.preventDefault();
          send(BRANCHES_METHODS.toggle, { id: row.id });
          return true;
        }
      }
      return false;
    },
    [activate, display, open, send],
  );

  if (!tree) return <div className="gtb-empty">Loading…</div>;

  return (
    <div className="gtb-root">
      <Header
        query={topQuery}
        repoCount={tree.repoCount}
        showInOut={tree.showInOut}
        onQuery={setTop}
        onHeader={(id) => send(BRANCHES_METHODS.header, { id })}
      />
      <div className="gtb-list-host" ref={listRef}>
        {listSize.height > 0 ? (
          <VirtualList
            ref={virtual}
            className="gtb-list"
            rowCount={display.length}
            rowHeight={ROW_HEIGHT}
            height={listSize.height}
            ariaLabel="Branches"
            role="tree"
            rowRole="treeitem"
            overscan={8}
            rowAria={(i) => {
              const entry = display[i];
              if (entry?.kind !== 'row') return { 'aria-level': 1 };
              return {
                'aria-level': entry.row.depth + 1,
                ...(entry.row.expandable ? { 'aria-expanded': open.has(entry.row.id) } : {}),
              };
            }}
            rowAriaLabel={(i) => {
              const entry = display[i];
              return entry?.kind === 'row' ? entry.row.label : entry?.label;
            }}
            onRowKeyDown={onRowKeyDown}
            onRowClick={(i) => activate(i, 'click')}
            renderRow={(i) => {
              const entry = display[i];
              if (entry === undefined) return null;
              if (entry.kind === 'separator') {
                return entry.label.length > 0 ? (
                  <div className="gtb-separator-label">{entry.label}</div>
                ) : (
                  <div className="gtb-separator-rule" />
                );
              }
              const row = entry.row;
              if (row.kind === 'search') {
                return (
                  <SearchRow
                    value={repoQueries[row.repoRoot ?? ''] ?? ''}
                    padding={row.depth * INDENT}
                    onChange={(value) => setRepo(row.repoRoot ?? '', value)}
                  />
                );
              }
              return (
                <RowBody
                  row={row}
                  open={open.has(row.id)}
                  onActions={rowMenu}
                  onFavorite={(r) => send(BRANCHES_METHODS.toggleFavorite, { id: r.id })}
                />
              );
            }}
          />
        ) : null}
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
