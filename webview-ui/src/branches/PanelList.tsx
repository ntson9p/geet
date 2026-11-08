/**
 * A list of the Repositories panel — the REPOSITORIES or BRANCHES pane's, or
 * with one repository the panel's only one: windowed like `VirtualList`, but
 * with rows of their own heights — a branch with its card open is taller than
 * one without, a section header taller than a row — and with focus held by a row's **id**,
 * not its position. The panel's rows move under the cursor all the time (a
 * fetch adds branches, a checkout moves the tick, a card opens above); a
 * focus kept by index would land on whatever row slid into that slot.
 *
 * Roving tabindex: one row is in the tab order, the arrows move it. Keys
 * pressed inside a row's own controls (a card's buttons) are theirs, except
 * Up and Down, which leave the control and move along the list.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

export interface ListRow {
  readonly id: string;
  readonly height: number;
}

export interface PanelListHandle {
  /** Moves keyboard focus to a row, scrolling it into view. */
  focusRow(id: string): void;
  scrollToRow(id: string): void;
}

export interface PanelListProps<R extends ListRow> {
  /** The tree's element id, for a header that says it controls the list. */
  readonly id?: string;
  readonly rows: readonly R[];
  readonly height: number;
  readonly ariaLabel: string;
  readonly focusedId: string | undefined;
  readonly onFocusId: (id: string) => void;
  readonly renderRow: (row: R, index: number) => ReactNode;
  readonly rowAttributes?: (row: R) => Record<string, string | number | boolean | undefined>;
  /** Return true to claim the key. */
  readonly onRowKeyDown?: (row: R, index: number, e: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  readonly onRowClick?: (row: R, e: ReactMouseEvent<HTMLDivElement>) => void;
  readonly onRowContextMenu?: (row: R, e: ReactMouseEvent<HTMLDivElement>) => void;
  readonly rowClassName?: (row: R) => string;
  /** Extra space the window renders beyond the viewport, in pixels. */
  readonly overscan?: number;
  /**
   * A row that stays at the top once the list scrolls past it: the tabs over
   * the branch list, which are no use out of sight. The pinned copy is for the
   * pointer; the keyboard reaches the row itself, which comes back into view.
   */
  readonly stickyId?: string;
  /**
   * Up on the first row, or Down on the last: the keyboard leaving the list,
   * for what sits above or below it (a pane's header). Without it the arrows
   * stop at the ends.
   */
  readonly onEdge?: (direction: -1 | 1) => void;
}

/** First index whose row reaches below `y`, by binary search over the offsets. */
function firstBelow(offsets: readonly number[], heights: readonly number[], y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let found = offsets.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! + heights[mid]! > y) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return found;
}

function isControl(el: EventTarget | null, row: HTMLElement): boolean {
  if (!(el instanceof HTMLElement) || el === row) return false;
  return el.closest('button, input, textarea, select, a, [contenteditable="true"]') !== null;
}

function PanelListInner<R extends ListRow>(
  {
    id,
    rows,
    height,
    ariaLabel,
    focusedId,
    onFocusId,
    renderRow,
    rowAttributes,
    onRowKeyDown,
    onRowClick,
    onRowContextMenu,
    rowClassName,
    overscan = 200,
    stickyId,
    onEdge,
  }: PanelListProps<R>,
  ref: ForwardedRef<PanelListHandle>,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  /** The scrollbar's width, which the pinned row must leave uncovered. */
  const [gutter, setGutter] = useState(0);
  const pendingFocus = useRef<string | undefined>(undefined);

  const { offsets, heights, total, indexOf } = useMemo(() => {
    const offs: number[] = [];
    const hs: number[] = [];
    const index = new Map<string, number>();
    let y = 0;
    rows.forEach((row, i) => {
      offs.push(y);
      hs.push(row.height);
      index.set(row.id, i);
      y += row.height;
    });
    return { offsets: offs, heights: hs, total: y, indexOf: index };
  }, [rows]);

  const stickyIndex = stickyId !== undefined ? indexOf.get(stickyId) : undefined;

  const scrollToIndex = useCallback(
    (i: number) => {
      const el = hostRef.current;
      if (!el || i < 0 || i >= offsets.length) return;
      // A row below the pinned one must not come to rest under it.
      const reserve = stickyIndex !== undefined && i > stickyIndex ? heights[stickyIndex]! : 0;
      const top = offsets[i]!;
      const bottom = top + heights[i]!;
      if (top - reserve < el.scrollTop) el.scrollTop = Math.max(0, top - reserve);
      else if (bottom > el.scrollTop + el.clientHeight) {
        // A row taller than the window (a big card) shows its top.
        el.scrollTop = Math.min(top - reserve, bottom - el.clientHeight);
      }
    },
    [heights, offsets, stickyIndex],
  );

  useLayoutEffect(() => {
    const el = hostRef.current;
    const width = el ? el.offsetWidth - el.clientWidth : 0;
    if (width !== gutter) setGutter(width);
  });

  const focusRow = useCallback(
    (id: string) => {
      const i = indexOf.get(id);
      if (i === undefined) return;
      onFocusId(id);
      scrollToIndex(i);
      const host = hostRef.current;
      const drawn = host?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
      if (drawn) {
        // Drawn already: focus it now. Coming back to the row the list already
        // keeps (from a pane's header, or Escape in the filter) changes no
        // state, so no render would come along to do it.
        pendingFocus.current = undefined;
        drawn.focus({ preventScroll: true });
        return;
      }
      // The row is drawn once the scroll re-windows the list; hold focus on
      // the container meanwhile so keys keep arriving here.
      pendingFocus.current = id;
      host?.focus();
    },
    [indexOf, onFocusId, scrollToIndex],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusRow,
      scrollToRow: (id: string) => {
        const i = indexOf.get(id);
        if (i !== undefined) scrollToIndex(i);
      },
    }),
    [focusRow, indexOf, scrollToIndex],
  );

  // Give DOM focus to a row asked for by `focusRow`, once it is rendered.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === undefined) return;
    const el = hostRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (el) {
      pendingFocus.current = undefined;
      el.focus({ preventScroll: true });
    }
  });

  const move = useCallback(
    (from: number, by: number) => {
      const next = Math.max(0, Math.min(rows.length - 1, from + by));
      const row = rows[next];
      if (row) focusRow(row.id);
    },
    [focusRow, rows],
  );

  const onKeyDown = (row: R, index: number, e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const inControl = isControl(e.target, e.currentTarget);
    if (inControl && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!inControl && onRowKeyDown?.(row, index, e) === true) return;
    const page = Math.max(1, Math.floor(height / 22) - 1);
    switch (e.key) {
      case 'ArrowDown':
        if (index === rows.length - 1 && onEdge) onEdge(1);
        else move(index, 1);
        break;
      case 'ArrowUp':
        if (index === 0 && onEdge) onEdge(-1);
        else move(index, -1);
        break;
      case 'PageDown':
        move(index, page);
        break;
      case 'PageUp':
        move(index, -page);
        break;
      case 'Home':
        move(0, 0);
        break;
      case 'End':
        move(rows.length - 1, 0);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const top = Math.max(0, scrollTop - overscan);
  const bottom = scrollTop + height + overscan;
  const first = firstBelow(offsets, heights, top);
  const rendered: ReactNode[] = [];
  for (let i = first; i < rows.length && offsets[i]! < bottom; i++) {
    const row = rows[i]!;
    const focused = row.id === focusedId;
    rendered.push(
      <div
        key={row.id}
        role="treeitem"
        data-row-id={row.id}
        data-row-index={i}
        tabIndex={focused ? 0 : -1}
        className={`gtp-row${focused ? ' gtp-focused' : ''}${rowClassName ? ` ${rowClassName(row)}` : ''}`}
        style={{ top: offsets[i], height: row.height }}
        {...rowAttributes?.(row)}
        onKeyDown={(e) => onKeyDown(row, i, e)}
        onClick={(e) => {
          if (!isControl(e.target, e.currentTarget)) onFocusId(row.id);
          onRowClick?.(row, e);
        }}
        onContextMenu={(e) => onRowContextMenu?.(row, e)}
      >
        {renderRow(row, i)}
      </div>,
    );
  }

  // No row focused yet (first paint, or the focused one went away): the first
  // row takes the tab stop, so Tab into the list always lands somewhere.
  const tabStopMissing = focusedId === undefined || !indexOf.has(focusedId);

  const stickyRow = stickyIndex !== undefined ? rows[stickyIndex] : undefined;
  const pinned = stickyRow !== undefined && stickyIndex !== undefined && scrollTop > offsets[stickyIndex]!;

  return (
    <div className="gtp-list-frame" style={{ height }}>
      <div
        ref={hostRef}
        id={id}
        className="gtp-list"
        role="tree"
        aria-label={ariaLabel}
        tabIndex={tabStopMissing ? 0 : -1}
        style={{ height }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return;
          const firstRow = rows[0];
          if (tabStopMissing && firstRow) focusRow(firstRow.id);
        }}
      >
        <div className="gtp-list-content" style={{ height: total }}>
          {rendered}
        </div>
      </div>
      {pinned ? (
        <div
          className={`gtp-row gtp-pinned${rowClassName ? ` ${rowClassName(stickyRow)}` : ''}`}
          style={{ top: 0, height: stickyRow.height, right: gutter }}
          aria-hidden="true"
        >
          {renderRow(stickyRow, stickyIndex)}
        </div>
      ) : null}
    </div>
  );
}

export const PanelList = forwardRef(PanelListInner) as <R extends ListRow>(
  props: PanelListProps<R> & { ref?: Ref<PanelListHandle> },
) => ReturnType<typeof PanelListInner>;
