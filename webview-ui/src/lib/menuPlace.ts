/**
 * Where a `Menu` stands (P11-T1): kept inside its webview, `MENU_MARGIN` from
 * the edges, since a menu drawn in a webview cannot leave it.
 *
 * A submenu opens to the right of its menu. With no room there it opens
 * leftwards from its parent's left edge (`flipX`), as VS Code's own submenus
 * do (POST-P14cg): pushed back inside instead, the eye's Columns and Date
 * Format, at the right end of the log's toolbar, covered the row that opened
 * them. Only when neither side has room is it pushed back inside. Pure, for
 * the tests.
 */

export const MENU_MARGIN = 4;

export interface MenuAt {
  readonly x: number;
  readonly y: number;
  /** A submenu's: its parent menu's left edge, where it ends when it opens leftwards. */
  readonly flipX?: number;
}

export function placeMenu(
  at: MenuAt,
  size: { readonly width: number; readonly height: number },
  view: { readonly width: number; readonly height: number },
): { x: number; y: number } {
  const maxX = view.width - size.width - MENU_MARGIN;
  const maxY = view.height - size.height - MENU_MARGIN;
  const y = Math.max(MENU_MARGIN, Math.min(at.y, Math.max(MENU_MARGIN, maxY)));
  if (at.flipX !== undefined && at.x > maxX && at.flipX - size.width >= MENU_MARGIN) {
    return { x: at.flipX - size.width, y };
  }
  return { x: Math.max(MENU_MARGIN, Math.min(at.x, Math.max(MENU_MARGIN, maxX))), y };
}
