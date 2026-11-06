/**
 * FileTree (P11-T1): the IntelliJ change tree — folder rows, per-node file
 * counts, tri-state checkboxes, full-width selection bar, multi-select.
 * Windowed by reusing VirtualList so a 5 000-file status stays responsive.
 *
 * ARIA: the row *is* the `treeitem` and carries `aria-checked`; the checkbox
 * inside it is decorative (see TriCheckbox). That keeps one tab stop for the
 * whole tree, which is the tree pattern screen readers expect.
 */
import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { TriCheckbox } from './TriCheckbox';
import {
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
  icon?: (node: TreeNode) => FileTreeIcon | undefined;
  /** P11-T8: status color for the row label (IntelliJ colors names, not icons). */
  nameColor?: (node: TreeNode) => string | undefined;
  rowContext?: (node: TreeNode) => Record<string, unknown> | undefined;
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
}

const DEFAULT_ROW_HEIGHT = 22;
const INDENT_PX = 14;

export function FileTree({
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
  icon,
  nameColor,
  rowContext,
  rowHeight = DEFAULT_ROW_HEIGHT,
  onFocusPath,
  className,
  reveal,
  current,
}: FileTreeProps) {
  const listRef = useRef<VirtualListHandle>(null);
  const anchorRef = useRef<number>(0);
  const rows = useMemo<FlatRow[]>(() => flatten(nodes, expanded), [nodes, expanded]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    if (reveal === undefined) return;
    const index = rowIndexOf(rowsRef.current, reveal.path);
    if (index < 0) return;
    listRef.current?.scrollToIndex(index);
    // The row first clicked would otherwise stay the keyboard's, and lit as it
    // when the tree has focus again, long after the walk left it. Shift+click
    // goes on from here too, as after a click.
    listRef.current?.setLead(index);
    anchorRef.current = index;
  }, [reveal]);

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
      const ico = icon?.(node);
      const labelColor = nameColor?.(node);
      return (
        <span
          className={`gt-tree-row-inner${node.path === current ? ' gt-tree-current' : ''}`}
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
        </span>
      );
    },
    [applyToggle, current, description, icon, nameColor, rows, setExpanded, stateOf],
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
      return desc !== undefined && desc !== '' ? `${row.node.name}, ${desc}` : row.node.name;
    },
    [description, rows],
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
        if (row) onFocusPath?.(row.node.path);
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
}
