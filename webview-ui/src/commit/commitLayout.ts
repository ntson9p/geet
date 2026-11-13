/**
 * The Commit tab's height, shared out (POST-P14ca): the list of changes, a
 * divider, then the bottom block of the Amend row, the message box and the
 * Commit button.
 *
 * Before, the bottom block was fixed at about 225 px: more than half of the
 * view at its first size, and a view made shorter than about 360 px scrolled as
 * a whole, with the Commit button cut off. Now the divider sets the message
 * box's height, and a short view takes room back in a fixed order: from the
 * list, down to a few rows; then from the box, down to one line; then from the
 * list again, to nothing. The Commit button below them never gives way.
 *
 * Pure, so that order and the placement of the options popup are tested
 * without a page.
 */

/** Rows the list keeps while the message box still has height to give. */
export const LIST_FLOOR_ROWS = 3;

/** A row of the list, as FileTree draws it. */
export const LIST_ROW_PX = 22;

/** The list's floor in px. */
export const LIST_FLOOR_PX = LIST_FLOOR_ROWS * LIST_ROW_PX;

/** Lines the message box shows until the divider is dragged. */
export const MESSAGE_LINES = 3;

export interface MessageFit {
  /** The height the box is given (px), by the divider or at first. */
  readonly preferred: number;
  /** One line: the least the box is ever drawn at. */
  readonly min: number;
  /** The height the list and the box share. */
  readonly room: number;
  /** What the list keeps before the box gives way. */
  readonly listFloor: number;
}

/**
 * The box's height in a view of this size: what it was given, as long as the
 * list keeps its floor; less, down to one line, when the list would not.
 */
export function fitMessageHeight({ preferred, min, room, listFloor }: MessageFit): number {
  const wanted = Math.max(min, preferred);
  return Math.max(min, Math.min(wanted, room - listFloor));
}

/**
 * Where a drag or a key leaves the box: never under one line, and never so tall
 * that the list goes under its floor. Whole pixels, as they are remembered.
 */
export function clampMessageHeight(next: number, fit: Omit<MessageFit, 'preferred'>): number {
  const max = Math.max(fit.min, fit.room - fit.listFloor);
  return Math.round(Math.min(max, Math.max(fit.min, next)));
}

/** A remembered height worth using: a positive finite number, else nothing. */
export function savedMessageHeight(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
}

export interface Placement {
  readonly top?: number;
  readonly bottom?: number;
  readonly maxHeight: number;
}

/** Room a popup needs above its button before it would rather open below it. */
const POPUP_MIN_ABOVE = 160;
const POPUP_GAP = 4;
const POPUP_MARGIN = 8;

/**
 * Where the options popup opens from the gear at `anchor` (viewport px): above
 * it, clear of the button, when there is room; below it otherwise. Never past
 * the webview's edges, which it cannot leave: past them it scrolls.
 */
export function popupPlacement(
  anchor: { readonly top: number; readonly bottom: number },
  viewportHeight: number,
): Placement {
  const above = anchor.top - POPUP_GAP - POPUP_MARGIN;
  const below = viewportHeight - anchor.bottom - POPUP_GAP - POPUP_MARGIN;
  if (above >= POPUP_MIN_ABOVE || above >= below) {
    return { bottom: viewportHeight - anchor.top + POPUP_GAP, maxHeight: Math.max(0, above) };
  }
  return { top: anchor.bottom + POPUP_GAP, maxHeight: Math.max(0, below) };
}
