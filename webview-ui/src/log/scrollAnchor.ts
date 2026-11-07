/**
 * Where the commit list stands when the host re-reads the history under it
 * (a commit, a pull, a rebase, the Refresh button), and so where it goes back
 * to once the new rows are in. This is IntelliJ's `SelectionSnapshot`, which
 * `VcsLogGraphTable.updateDataPack` takes before every new data pack and
 * restores after it:
 *
 * - a list **on top** (the row under its top edge is the first one) goes back
 *   to the top, so a commit that has just been made shows as the first row.
 *   Keeping the old first row at the top instead put the new commit one row
 *   above the window: the log looked as if nothing had happened;
 * - otherwise the first **selected** row on screen, or failing that the row
 *   under the top edge, keeps its distance from the top edge, to the pixel.
 *
 * Pure: the caller passes what the list holds and how it is scrolled.
 */

export type ScrollAnchor =
  /** Back to the very top. */
  | { readonly kind: 'top' }
  /** `sha`'s row `gap` pixels below the top edge; negative when partly above it. */
  | { readonly kind: 'row'; readonly sha: string; readonly gap: number };

export interface ListView {
  /** How far the list is scrolled, in pixels. */
  readonly scrollTop: number;
  /** The height of its window, in pixels. */
  readonly height: number;
}

/**
 * @param shas the rows on show, newest first
 * @param isSelected whether a row's commit is selected
 * @returns undefined when the list has no rows: there is nothing to keep.
 */
export function scrollAnchor(
  shas: readonly string[],
  view: ListView,
  rowHeight: number,
  isSelected: (sha: string) => boolean,
): ScrollAnchor | undefined {
  if (shas.length === 0 || rowHeight <= 0) return undefined;
  const last = shas.length - 1;
  // IntelliJ's leading and trailing rows: the rows under the window's first
  // and last pixel lines (`ScrollingUtil.getVisibleRows`).
  const top = Math.min(last, Math.max(0, Math.floor(view.scrollTop / rowHeight)));
  if (top === 0) return { kind: 'top' };
  const bottom = Math.min(last, Math.max(top, Math.floor((view.scrollTop + view.height - 1) / rowHeight)));
  let row = top;
  for (let i = top; i <= bottom; i++) {
    if (isSelected(shas[i] as string)) {
      row = i;
      break;
    }
  }
  return { kind: 'row', sha: shas[row] as string, gap: row * rowHeight - view.scrollTop };
}
