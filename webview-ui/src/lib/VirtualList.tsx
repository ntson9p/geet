/**
 * VirtualList (master §9): fixed row height, windowed rendering, ARIA row
 * semantics, roving tabindex keyboard navigation, imperative scrollToIndex.
 * The workhorse behind the 100k-commit log (P4) and other long lists.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { listWindow } from './listWindow';

export interface VirtualListHandle {
  /**
   * `auto` scrolls the minimum needed to bring the row into view, `center`
   * puts it in the middle, `top` pins it to the first visible line — which is
   * what restoring a scroll anchor after a reload needs, since `auto` from a
   * reset list (scrollTop 0) would leave the row at the BOTTOM of the window.
   * `{ offset }` puts the row that many pixels below the top of the window: a
   * row brought back where it was after the list was rebuilt around it.
   */
  scrollToIndex(index: number, align?: 'auto' | 'center' | 'top' | { readonly offset: number }): void;
  /**
   * Moves keyboard focus to a row. `silent` leaves `onFocusIndex` unfired: a
   * list with a selection of its own moves its lead on Ctrl+ and Shift+ clicks
   * and keys without that becoming a plain one-row selection.
   */
  focusIndex(index: number, opts?: { silent?: boolean }): void;
  /**
   * Makes a row the one the keyboard goes on from, without taking focus or
   * scrolling: the list follows something done outside it, a diff walking it.
   */
  setLead(index: number): void;
  /** The row the keyboard goes on from. */
  lead(): number;
  /** How far the list is scrolled, in pixels. */
  scrollTop(): number;
}

export interface VirtualListProps {
  rowCount: number;
  rowHeight: number;
  height: number;
  renderRow: (index: number) => ReactNode;
  ariaLabel: string;
  overscan?: number;
  /** Fired when the focused row changes via keyboard or click. */
  onFocusIndex?: (index: number) => void;
  /** Enter/Space on a focused row. */
  onActivate?: (index: number) => void;
  /** Row context data for data-vscode-context (native menus). */
  rowContext?: (index: number) => Record<string, unknown> | undefined;
  /** P10-T2: screen-reader label per row (falls back to text content). */
  rowAriaLabel?: (index: number) => string | undefined;
  /** Click with modifier info (multi-selection models live above the list). */
  onRowClick?: (index: number, e: { ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }) => void;
  /**
   * Right-click on a row, before the native menu opens. Consumers use it to
   * move the selection onto the row under the cursor — never to *build* the
   * menu payload, which VS Code reads straight off `data-vscode-context` and
   * so has to be right for the selection as it stood before the click. A list
   * that draws its own menu instead (the Branches section) takes the event to
   * place it and to keep VS Code's out of the way.
   */
  onRowContextMenu?: (index: number, e: ReactMouseEvent<HTMLDivElement>) => void;
  /**
   * Pointer entered a row. On the row element, not on whatever `renderRow`
   * draws inside it: a row's content is usually narrower than the row, and a
   * hover handler on the content would miss the empty half the pointer
   * spends most of its time over.
   */
  onRowMouseEnter?: (index: number, row: HTMLElement) => void;
  /** Viewport tracker for overlay layers (log graph canvas) + infinite scroll. */
  onViewport?: (view: { scrollTop: number; first: number; last: number }) => void;
  className?: string;
  /**
   * P11-T1: container role. Defaults to `listbox`; `tree` lets FileTree reuse
   * this windowing without inheriting listbox semantics.
   */
  role?: 'listbox' | 'tree';
  /** Row role, paired with `role`. Defaults to `option`. */
  rowRole?: 'option' | 'treeitem';
  /**
   * P11-T1: extra ARIA per row (`aria-level`, `aria-expanded`, `aria-checked`),
   * spread last so a tree can override the listbox defaults.
   */
  rowAria?: (index: number) => Record<string, string | number | boolean | undefined> | undefined;
  /**
   * P11-T1: consumer key handling, run before the built-in model. Return true
   * to claim the event — a tree needs Space for check-toggling, which would
   * otherwise fire `onActivate`.
   */
  onRowKeyDown?: (index: number, e: KeyboardEvent<HTMLDivElement>) => boolean;
  /**
   * A selection that is not just the focused row (the log's Ctrl/Shift
   * selection). When given, it decides `aria-selected` and the `gt-selected`
   * class; without it the focused row is the selected one, as before.
   */
  isRowSelected?: (index: number) => boolean;
  /** `aria-multiselectable` on the list, for one whose rows select together. */
  multiselectable?: boolean;
}

export const VirtualList = forwardRef<VirtualListHandle, VirtualListProps>(function VirtualList(
  {
    rowCount,
    rowHeight,
    height,
    renderRow,
    ariaLabel,
    overscan = 6,
    onFocusIndex,
    onActivate,
    rowContext,
    rowAriaLabel,
    onRowClick,
    onRowContextMenu,
    onRowMouseEnter,
    onViewport,
    className,
    role = 'listbox',
    rowRole = 'option',
    rowAria,
    onRowKeyDown,
    isRowSelected,
    multiselectable,
  }: VirtualListProps,
  ref,
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const pendingFocus = useRef<number | undefined>(undefined);

  const clamp = useCallback(
    (i: number) => Math.max(0, Math.min(rowCount - 1, i)),
    [rowCount],
  );

  const scrollToIndex = useCallback(
    (index: number, align: 'auto' | 'center' | 'top' | { readonly offset: number } = 'auto') => {
      const el = containerRef.current;
      if (!el) return;
      const i = clamp(index);
      const top = i * rowHeight;
      if (typeof align === 'object') {
        // The browser clamps it to what the list can scroll.
        el.scrollTop = top - align.offset;
      } else if (align === 'center') {
        el.scrollTop = top - Math.max(0, (height - rowHeight) / 2);
      } else if (align === 'top') {
        el.scrollTop = top;
      } else if (top < el.scrollTop) {
        el.scrollTop = top;
      } else if (top + rowHeight > el.scrollTop + height) {
        el.scrollTop = top + rowHeight - height;
      }
      // Windowed now rather than on the scroll event: a caller putting a place
      // back before paint must not paint the old place's rows first. The event
      // then sets the same value, which renders nothing.
      setScrollTop(el.scrollTop);
    },
    [clamp, height, rowHeight],
  );

  const focusIndex = useCallback(
    (index: number, opts?: { silent?: boolean }) => {
      const i = clamp(index);
      setFocusedIndex(i);
      if (opts?.silent !== true) onFocusIndex?.(i);
      scrollToIndex(i);
      pendingFocus.current = i;
      // A jump outside the rendered window unmounts the row that currently
      // holds focus, and focus falls to <body> for the frames it takes the
      // list to re-window — every keystroke in that gap is swallowed. Park
      // focus on the container synchronously, before that re-render happens.
      const host = containerRef.current;
      if (host && !host.querySelector(`[data-gt-row="${i}"]`)) host.focus();
      // After a long jump the target row renders only once the scroll event
      // has re-windowed the list — retry across a few frames, and never let
      // focus escape to <body> (that would kill keyboard navigation).
      const tryFocus = (attempt: number): void => {
        if (pendingFocus.current !== i) return; // superseded by a newer call
        const el = containerRef.current;
        const row = el?.querySelector<HTMLElement>(`[data-gt-row="${i}"]`);
        if (row) {
          pendingFocus.current = undefined;
          row.focus();
          return;
        }
        // Still windowing in. Focus was parked on the container synchronously
        // above; re-park only if something knocked it out to <body>.
        if (el && document.activeElement === document.body) el.focus();
        if (attempt < 20) {
          requestAnimationFrame(() => tryFocus(attempt + 1));
        } else {
          pendingFocus.current = undefined;
          el?.focus();
        }
      };
      requestAnimationFrame(() => tryFocus(0));
    },
    [clamp, onFocusIndex, scrollToIndex],
  );

  const setLead = useCallback((index: number) => setFocusedIndex(clamp(index)), [clamp]);
  // Read through a ref: a caller asking right before a rebuild must get the
  // row as it stands, not as of the last render it happened to close over.
  const focusedRef = useRef(focusedIndex);
  focusedRef.current = focusedIndex;
  const lead = useCallback(() => focusedRef.current, []);
  const currentScrollTop = useCallback(() => containerRef.current?.scrollTop ?? 0, []);

  useImperativeHandle(
    ref,
    () => ({ scrollToIndex, focusIndex, setLead, lead, scrollTop: currentScrollTop }),
    [scrollToIndex, focusIndex, setLead, lead, currentScrollTop],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (onRowKeyDown?.(focusedIndex, e) === true) return;
    const page = Math.max(1, Math.floor(height / rowHeight) - 1);
    let next: number | undefined;
    switch (e.key) {
      case 'ArrowDown':
        next = focusedIndex + 1;
        break;
      case 'ArrowUp':
        next = focusedIndex - 1;
        break;
      case 'PageDown':
        next = focusedIndex + page;
        break;
      case 'PageUp':
        next = focusedIndex - page;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = rowCount - 1;
        break;
      case 'Enter':
      case ' ':
        onActivate?.(focusedIndex);
        e.preventDefault();
        return;
      default:
        return;
    }
    e.preventDefault();
    focusIndex(next);
  };

  const { first, last } = listWindow(scrollTop, height, rowHeight, rowCount, overscan);
  useEffect(() => {
    onViewport?.({ scrollTop, first, last });
  }, [scrollTop, first, last, onViewport]);

  const rows: ReactNode[] = [];
  for (let i = first; i <= last; i++) {
    const style: CSSProperties = {
      position: 'absolute',
      top: i * rowHeight,
      height: rowHeight,
      left: 0,
      right: 0,
    };
    const ctx = rowContext?.(i);
    rows.push(
      <div
        key={i}
        role={rowRole}
        aria-posinset={i + 1}
        aria-setsize={rowCount}
        aria-selected={isRowSelected !== undefined ? isRowSelected(i) : i === focusedIndex}
        aria-label={rowAriaLabel?.(i)}
        {...rowAria?.(i)}
        data-gt-row={i}
        data-vscode-context={ctx ? JSON.stringify(ctx) : undefined}
        tabIndex={i === focusedIndex ? 0 : -1}
        className={`gt-virtual-row${i === focusedIndex ? ' gt-focused' : ''}${
          isRowSelected?.(i) === true ? ' gt-selected' : ''
        }`}
        style={style}
        onClick={(e) => {
          // Modifier clicks are selection gestures owned by the consumer —
          // moving focus would fire onFocusIndex and reset multi-selection.
          if (!e.ctrlKey && !e.metaKey && !e.shiftKey) focusIndex(i);
          onRowClick?.(i, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey });
        }}
        onContextMenu={(e) => onRowContextMenu?.(i, e)}
        onMouseEnter={(e) => onRowMouseEnter?.(i, e.currentTarget)}
        onDoubleClick={() => onActivate?.(i)}
      >
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={containerRef}
      role={role}
      aria-label={ariaLabel}
      aria-multiselectable={multiselectable === true ? true : undefined}
      tabIndex={-1}
      className={`gt-virtual-list${className ? ` ${className}` : ''}`}
      style={{ height, overflowY: 'auto', position: 'relative', outline: 'none' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div style={{ height: rowCount * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
});
