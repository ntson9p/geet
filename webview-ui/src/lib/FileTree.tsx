/**
 * FileTree (P11-T1): the IntelliJ change tree — folder rows, per-node file
 * counts, tri-state checkboxes, full-width selection bar, multi-select.
 * Windowed by reusing VirtualList so a 5 000-file status stays responsive.
 *
 * ARIA: the row *is* the `treeitem` and carries `aria-checked`; the checkbox
 * inside it is decorative (see TriCheckbox). That keeps one tab stop for the
 * whole tree, which is the tree pattern screen readers expect.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { TriCheckbox } from './TriCheckbox';
import {
  ancestorDirs,
  flatten,
  rollup,
  rowIndexOf,
  toggle,
  type CheckState,
  type FlatRow,
  type ToggleDelta,
  type TreeNode,
} from './treeModel';
import { VirtualList, type VirtualListHandle } from './VirtualList';

export type FileTreeIcon =
  | {
      /** Codicon name without the `codicon-` prefix. */
      readonly codicon: string;
      /** A `--vscode-*` variable reference or theme color; omit for default. */
      readonly color?: string;
    }
  | {
      /**
       * A filled square in this colour, in a glyph's slot: a colour that is data,
       * such as a repository's (IntelliJ's root icon, the log's `Roots` chip).
       * The codicons have no filled square to tint.
       */
      readonly swatch: string;
    };

/** A short tinted label after a row's description: a repository's branch, as IntelliJ draws it. */
export interface FileTreeBadge {
  readonly text: string;
  /** Its hover, which a screen reader hears in its place. */
  readonly title?: string;
}

/** Where the user is in the tree, so it can be found again once the rows are rebuilt. */
export interface FileTreeViewState {
  /** The row the keyboard goes on from. */
  readonly lead?: string;
  /**
   * A row on screen and how far below the top of the window it sits: the lead
   * when it shows, else the first row that does.
   */
  readonly anchor?: { readonly path: string; readonly offset: number };
  /** The list was scrolled to its very top. */
  readonly atTop: boolean;
}

/**
 * After the rows were rebuilt in another shape (the Commit window's grouping):
 * `anchor` goes back `offset` pixels below the top of the window, or, with
 * `top`, the list stays at its top and only scrolls if `lead` would be out of
 * sight; `lead` becomes the row the keyboard goes on from. Applied once per object.
 */
export interface FileTreeRestore {
  readonly anchor?: { readonly path: string; readonly offset: number };
  readonly top?: boolean;
  readonly lead?: string;
}

export interface FileTreeHandle {
  viewState(): FileTreeViewState;
}

/**
 * A button at the end of a row, shown while the row is hovered, selected or
 * focused — VS Code's inline tree actions (POST-QA F5: Stage and Unstage).
 */
export interface FileTreeAction {
  readonly id: string;
  readonly codicon: string;
  readonly title: string;
  readonly run: () => void;
}

export interface FileTreeProps {
  nodes: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  onToggleExpand: (path: string, next: boolean) => void;
  height: number;
  ariaLabel: string;
  /** Omit to render a tree without any checkboxes (log Changed Files). */
  checked?: ReadonlySet<string>;
  onToggleCheck?: (delta: ToggleDelta) => void;
  /** Rows that must not show a checkbox even when `checked` is supplied. */
  checkboxless?: ReadonlySet<string>;
  selection?: ReadonlySet<string>;
  onSelectionChange?: (paths: string[]) => void;
  onActivate?: (node: TreeNode) => void;
  /** Dim trailing text — `2 files` on directories, the parent dir on files. */
  description?: (node: TreeNode) => string | undefined;
  /** A tinted label after the description; it gives way first in a narrow tree. */
  badge?: (node: TreeNode) => FileTreeBadge | undefined;
  icon?: (node: TreeNode) => FileTreeIcon | undefined;
  /** P11-T8: status color for the row label (IntelliJ colors names, not icons). */
  nameColor?: (node: TreeNode) => string | undefined;
  rowContext?: (node: TreeNode) => Record<string, unknown> | undefined;
  /** Inline buttons for a row; none when absent or empty. */
  actions?: (node: TreeNode) => readonly FileTreeAction[] | undefined;
  rowHeight?: number;
  onFocusPath?: (path: string) => void;
  className?: string;
  /**
   * Scrolls this row into view whenever a new object arrives, and makes it the
   * row the keyboard goes on from; focus stays where it is.
   */
  reveal?: { readonly path: string };
  /**
   * The row of the file a diff opened from this tree is showing: its name
   * highlighted, whatever is selected. A walk over several selected rows leaves
   * them selected, so this is what says which of them is on screen.
   */
  current?: string;
  /** See `FileTreeRestore`. */
  restore?: FileTreeRestore;
}

const DEFAULT_ROW_HEIGHT = 22;
const INDENT_PX = 14;

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    nodes,
    expanded,
    onToggleExpand,
    height,
    ariaLabel,
    checked,
    onToggleCheck,
    checkboxless,
    selection,
    onSelectionChange,
    onActivate,
    description,
    badge,
    icon,
    nameColor,
    rowContext,
    actions,
    rowHeight = DEFAULT_ROW_HEIGHT,
    onFocusPath,
    className,
    reveal,
    current,
    restore,
  }: FileTreeProps,
  ref,
) {
  const listRef = useRef<VirtualListHandle>(null);
  const anchorRef = useRef<number>(0);
  const rows = useMemo<FlatRow[]>(() => flatten(nodes, expanded), [nodes, expanded]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /**
   * The row the keyboard goes on from, by path. The list keeps it by index, and
   * folding or opening a folder above it, or a file arriving above it, would
   * otherwise hand it to whatever row now has that index.
   */
  const leadPath = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (reveal === undefined) return;
    const index = rowIndexOf(rowsRef.current, reveal.path);
    if (index < 0) return;
    listRef.current?.scrollToIndex(index);
    // The row first clicked would otherwise stay the keyboard's, and lit as it
    // when the tree has focus again, long after the walk left it. Shift+click
    // goes on from here too, as after a click.
    listRef.current?.setLead(index);
    leadPath.current = reveal.path;
    anchorRef.current = index;
  }, [reveal]);

  // Before paint: the rows changed under the keyboard's row, so find it again.
  // Folded away, its nearest open folder takes over, as in VS Code's trees.
  useLayoutEffect(() => {
    const path = leadPath.current;
    const list = listRef.current;
    if (path === undefined || !list || rows[list.lead()]?.node.path === path) return;
    let index = rowIndexOf(rows, path);
    if (index < 0) {
      for (const dir of ancestorDirs(nodes, path)) {
        index = rowIndexOf(rows, dir);
        if (index >= 0) break;
      }
    }
    if (index >= 0) list.setLead(index);
  }, [nodes, rows]);

  // Read through refs: the handle is asked right before the rows are rebuilt.
  const heightRef = useRef(height);
  heightRef.current = height;
  useImperativeHandle(
    ref,
    () => ({
      viewState(): FileTreeViewState {
        const list = listRef.current;
        const now = rowsRef.current;
        if (!list || now.length === 0) return { atTop: true };
        const top = list.scrollTop();
        const leadIndex = list.lead();
        const leadRow = now[leadIndex];
        const view = heightRef.current;
        let anchor: FileTreeViewState['anchor'];
        if (leadRow !== undefined) {
          const offset = leadIndex * rowHeight - top;
          if (offset >= 0 && offset + rowHeight <= view) anchor = { path: leadRow.node.path, offset };
        }
        if (anchor === undefined) {
          const first = Math.min(now.length - 1, Math.ceil(top / rowHeight));
          const row = now[first];
          if (row !== undefined) anchor = { path: row.node.path, offset: first * rowHeight - top };
        }
        return {
          ...(leadRow !== undefined ? { lead: leadRow.node.path } : {}),
          ...(anchor !== undefined ? { anchor } : {}),
          atTop: top <= 0,
        };
      },
    }),
    [rowHeight],
  );

  // Before paint, so the rebuilt rows never show at the old scroll position.
  useLayoutEffect(() => {
    if (restore === undefined) return;
    const list = listRef.current;
    if (!list) return;
    const leadIndex = restore.lead !== undefined ? rowIndexOf(rowsRef.current, restore.lead) : -1;
    const anchorIndex = restore.anchor !== undefined ? rowIndexOf(rowsRef.current, restore.anchor.path) : -1;
    if (restore.top === true) {
      list.scrollToIndex(0, 'top');
      if (leadIndex >= 0) list.scrollToIndex(leadIndex, 'auto');
    } else if (anchorIndex >= 0 && restore.anchor !== undefined) {
      list.scrollToIndex(anchorIndex, { offset: restore.anchor.offset });
    } else if (leadIndex >= 0) {
      list.scrollToIndex(leadIndex, 'auto');
    }
    if (leadIndex >= 0 && restore.lead !== undefined) {
      list.setLead(leadIndex);
      leadPath.current = restore.lead;
      anchorRef.current = leadIndex;
    }
  }, [restore]);

  const showsCheckbox = useCallback(
    (row: FlatRow): boolean =>
      checked !== undefined && checkboxless?.has(row.node.path) !== true,
    [checked, checkboxless],
  );

  const stateOf = useCallback(
    (row: FlatRow): CheckState | undefined =>
      showsCheckbox(row) && checked !== undefined ? rollup(row.node, checked) : undefined,
    [checked, showsCheckbox],
  );

  const applyToggle = useCallback(
    (row: FlatRow): void => {
      const state = stateOf(row);
      if (state === undefined || !onToggleCheck) return;
      onToggleCheck(toggle(row.node, state));
    },
    [onToggleCheck, stateOf],
  );

  const setExpanded = useCallback(
    (row: FlatRow, next: boolean): void => {
      if (!row.expandable) return;
      onToggleExpand(row.node.path, next);
    },
    [onToggleExpand],
  );

  /** Index of the row that owns `index` one level up, or -1. */
  const parentIndex = useCallback(
    (index: number): number => {
      const depth = rows[index]?.node.depth;
      if (depth === undefined || depth === 0) return -1;
      for (let i = index - 1; i >= 0; i--) {
        const d = rows[i]?.node.depth;
        if (d !== undefined && d < depth) return i;
      }
      return -1;
    },
    [rows],
  );

  const select = useCallback(
    (index: number, mods: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }): void => {
      if (!onSelectionChange) return;
      const row = rows[index];
      if (!row) return;
      const additive = mods.ctrlKey || mods.metaKey;
      if (mods.shiftKey) {
        const from = Math.min(anchorRef.current, index);
        const to = Math.max(anchorRef.current, index);
        const range: string[] = [];
        for (let i = from; i <= to; i++) {
          const r = rows[i];
          if (r) range.push(r.node.path);
        }
        onSelectionChange(range);
        return;
      }
      anchorRef.current = index;
      if (additive) {
        const next = new Set(selection ?? []);
        if (next.has(row.node.path)) next.delete(row.node.path);
        else next.add(row.node.path);
        onSelectionChange([...next]);
        return;
      }
      onSelectionChange([row.node.path]);
    },
    [onSelectionChange, rows, selection],
  );

  /**
   * IntelliJ moves the selection to the row you right-click, and leaves a
   * multi-selection alone when the click lands inside it. Purely cosmetic:
   * the menu's payload comes from `data-vscode-context`, which VS Code reads
   * in this same event, so the payload has to be built for the selection as it
   * stood *before* the click — see `rowContext` in the commit window.
   */
  const onRowContextMenu = useCallback(
    (index: number): void => {
      if (!onSelectionChange) return;
      const row = rows[index];
      if (!row || selection?.has(row.node.path) === true) return;
      anchorRef.current = index;
      onSelectionChange([row.node.path]);
    },
    [onSelectionChange, rows, selection],
  );

  const onRowKeyDown = useCallback(
    (index: number, e: ReactKeyboardEvent<HTMLDivElement>): boolean => {
      const row = rows[index];
      if (!row) return false;
      switch (e.key) {
        case ' ':
          // Space belongs to the checkbox; without this it would reach
          // VirtualList and fire onActivate instead.
          e.preventDefault();
          if (showsCheckbox(row)) applyToggle(row);
          else select(index, { ctrlKey: false, shiftKey: false, metaKey: false });
          return true;
        case 'ArrowRight':
          e.preventDefault();
          if (row.expandable && !row.expanded) setExpanded(row, true);
          else if (row.expanded && index + 1 < rows.length) listRef.current?.focusIndex(index + 1);
          return true;
        case 'ArrowLeft': {
          e.preventDefault();
          if (row.expanded) {
            setExpanded(row, false);
            return true;
          }
          const parent = parentIndex(index);
          if (parent >= 0) listRef.current?.focusIndex(parent);
          return true;
        }
        default:
          return false;
      }
    },
    [applyToggle, parentIndex, rows, select, setExpanded, showsCheckbox],
  );

  const renderRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return null;
      const { node } = row;
      const state = stateOf(row);
      const desc = description?.(node);
      const label = badge?.(node);
      const ico = icon?.(node);
      const labelColor = nameColor?.(node);
      const acts = actions?.(node);
      return (
        <span
          className={`gt-tree-row-inner${node.path === current ? ' gt-tree-current' : ''}${
            label !== undefined ? ' gt-tree-has-badge' : ''
          }`}
          style={{ paddingLeft: node.depth * INDENT_PX }}
        >
          <span
            className={`gt-twistie${row.expandable ? '' : ' gt-twistie-empty'}`}
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(row, !row.expanded);
            }}
          >
            {row.expandable ? (
              <span
                className={`codicon codicon-chevron-${row.expanded ? 'down' : 'right'}`}
              />
            ) : null}
          </span>
          {state !== undefined ? (
            <span
              className="gt-tree-check"
              onClick={(e) => {
                // Keep a multi-selection intact: ticking is not selecting.
                e.stopPropagation();
                applyToggle(row);
              }}
            >
              <TriCheckbox state={state} />
            </span>
          ) : null}
          {ico === undefined ? null : 'swatch' in ico ? (
            <span className="gt-tree-icon gt-tree-swatch" style={{ color: ico.swatch }} aria-hidden="true" />
          ) : (
            <span
              className={`codicon codicon-${ico.codicon} gt-tree-icon`}
              style={ico.color !== undefined ? { color: ico.color } : undefined}
              aria-hidden="true"
            />
          )}
          <span
            className="gt-tree-name"
            style={labelColor !== undefined ? { color: labelColor } : undefined}
          >
            {node.name}
          </span>
          {desc !== undefined && desc !== '' ? (
            <span className="gt-tree-desc">{desc}</span>
          ) : null}
          {label !== undefined ? (
            <span className="gt-tree-badge" title={label.title}>
              {label.text}
            </span>
          ) : null}
          {acts !== undefined && acts.length > 0 ? (
            <span className="gt-tree-actions">
              {acts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`gt-tree-action codicon codicon-${a.codicon}`}
                  title={a.title}
                  aria-label={a.title}
                  data-testid={`tree-action-${a.id}`}
                  onClick={(e) => {
                    // An action is not a click on the row: keep the selection.
                    e.stopPropagation();
                    a.run();
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                />
              ))}
            </span>
          ) : null}
        </span>
      );
    },
    [actions, applyToggle, badge, current, description, icon, nameColor, rows, setExpanded, stateOf],
  );

  const rowAria = useCallback(
    (index: number): Record<string, string | number | boolean | undefined> | undefined => {
      const row = rows[index];
      if (!row) return undefined;
      const state = stateOf(row);
      return {
        'aria-level': row.node.depth + 1,
        'aria-expanded': row.expandable ? row.expanded : undefined,
        'aria-selected': selection?.has(row.node.path) ?? false,
        'aria-checked':
          state === undefined ? undefined : state === 'partial' ? 'mixed' : String(state === 'checked'),
        'aria-current': row.node.path === current ? 'true' : undefined,
      };
    },
    [current, rows, selection, stateOf],
  );

  const rowAriaLabel = useCallback(
    (index: number): string | undefined => {
      const row = rows[index];
      if (!row) return undefined;
      const desc = description?.(row.node);
      const label = badge?.(row.node);
      return [
        row.node.name,
        ...(desc !== undefined && desc !== '' ? [desc] : []),
        ...(label !== undefined ? [label.title ?? label.text] : []),
      ].join(', ');
    },
    [badge, description, rows],
  );

  return (
    <VirtualList
      ref={listRef}
      role="tree"
      rowRole="treeitem"
      rowCount={rows.length}
      rowHeight={rowHeight}
      height={height}
      ariaLabel={ariaLabel}
      className={`gt-tree${className !== undefined ? ` ${className}` : ''}`}
      renderRow={renderRow}
      rowAria={rowAria}
      rowAriaLabel={rowAriaLabel}
      onRowKeyDown={onRowKeyDown}
      rowContext={(i) => {
        const row = rows[i];
        return row ? rowContext?.(row.node) : undefined;
      }}
      onFocusIndex={(i) => {
        const row = rows[i];
        if (!row) return;
        leadPath.current = row.node.path;
        onFocusPath?.(row.node.path);
      }}
      onRowClick={(i, mods) => select(i, mods)}
      onRowContextMenu={onRowContextMenu}
      onActivate={(i) => {
        const row = rows[i];
        if (!row) return;
        if (row.expandable) setExpanded(row, !row.expanded);
        else onActivate?.(row.node);
      }}
    />
  );
});
