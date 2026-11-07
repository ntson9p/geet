/** What a `VirtualList` reports through `onViewport`: its scroll and the rows it renders. */
export interface ListWindow {
  scrollTop: number;
  first: number;
  last: number;
}

/**
 * The rows a `VirtualList` renders when scrolled to `scrollTop`, `overscan`
 * rows past each edge, which is also what it reports through `onViewport`.
 * Its own module so a caller that scrolls the list can learn the window in
 * the same frame, rather than from the report, which comes in an effect after
 * the frame is painted.
 */
export function listWindow(
  scrollTop: number,
  height: number,
  rowHeight: number,
  rowCount: number,
  overscan = 6,
): ListWindow {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const visible = Math.ceil(height / rowHeight) + overscan * 2;
  const last = Math.min(rowCount - 1, first + visible);
  return { scrollTop, first, last };
}
