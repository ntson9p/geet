/**
 * The commit list's selection, as IntelliJ's log table keeps it (a Swing
 * `JTable` in multiple-interval mode):
 *
 * - **click** selects that commit alone;
 * - **Ctrl+click** (⌘ on macOS) adds or removes one commit;
 * - **Shift+click** selects the run from the anchor to it, and nothing else;
 * - **Ctrl+Shift+click** adds that run to what is selected;
 * - **Shift+↑/↓/PageUp/PageDown/Home/End** grow or shrink the run from the
 *   anchor; **Ctrl+A** selects every loaded commit;
 * - **right-click** outside the selection selects that commit; inside it, the
 *   selection stays, so the menu acts on all of it.
 *
 * The anchor is the commit the last plain or Ctrl click landed on. The
 * selection is always kept in graph order (newest first), whatever order it
 * was clicked in, because that is the order the panes and the commands read.
 * Pure: `order` maps each loaded sha to its row.
 */

export interface LogSelection {
  readonly shas: readonly string[];
  /** Where a Shift range starts. */
  readonly anchor?: string;
}

export const EMPTY_SELECTION: LogSelection = { shas: [] };

export interface ClickMods {
  /** Ctrl, or ⌘ on macOS. */
  readonly toggle: boolean;
  readonly range: boolean;
}

/** Row index for each loaded sha. */
export type RowOrder = ReadonlyMap<string, number>;

export function rowOrder(shas: readonly string[]): Map<string, number> {
  return new Map(shas.map((sha, i) => [sha, i]));
}

/** `shas` in graph order, without duplicates or commits that are not loaded. */
export function inGraphOrder(shas: Iterable<string>, order: RowOrder): string[] {
  return [...new Set(shas)]
    .filter((sha) => order.has(sha))
    .sort((a, b) => order.get(a)! - order.get(b)!);
}

function between(rows: readonly string[], from: number, to: number): string[] {
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return rows.slice(lo, hi + 1);
}

/** The anchor's row, or `fallback` when it is gone (a refresh moved it out). */
function anchorIndex(selection: LogSelection, order: RowOrder, fallback: number): number {
  return selection.anchor !== undefined ? (order.get(selection.anchor) ?? fallback) : fallback;
}

/** A click on row `index`, with or without modifiers. */
export function clickSelection(
  rows: readonly string[],
  order: RowOrder,
  current: LogSelection,
  index: number,
  mods: ClickMods,
): LogSelection {
  const sha = rows[index];
  if (sha === undefined) return current;
  if (mods.range) {
    const run = between(rows, anchorIndex(current, order, index), index);
    const shas = mods.toggle ? inGraphOrder([...current.shas, ...run], order) : run;
    return { shas, anchor: current.anchor ?? sha };
  }
  if (mods.toggle) {
    const has = current.shas.includes(sha);
    const shas = has ? current.shas.filter((s) => s !== sha) : inGraphOrder([...current.shas, sha], order);
    return { shas, anchor: sha };
  }
  return { shas: [sha], anchor: sha };
}

/**
 * Shift with a navigation key: the run from the anchor to row `index`. With
 * no anchor yet, the run starts at `from`, the row the key was pressed on.
 */
export function extendSelection(
  rows: readonly string[],
  order: RowOrder,
  current: LogSelection,
  index: number,
  from: number = index,
): LogSelection {
  if (rows[index] === undefined) return current;
  const start = anchorIndex(current, order, from);
  return { shas: between(rows, start, index), anchor: rows[start] };
}

/** Ctrl+A: every loaded commit, the anchor kept. */
export function selectAll(rows: readonly string[], current: LogSelection): LogSelection {
  return { shas: [...rows], ...(current.anchor !== undefined ? { anchor: current.anchor } : { anchor: rows[0] }) };
}

/** Right-click on row `index`: the selection the menu acts on. */
export function contextSelection(rows: readonly string[], current: LogSelection, index: number): LogSelection {
  const sha = rows[index];
  if (sha === undefined || current.shas.includes(sha)) return current;
  return { shas: [sha], anchor: sha };
}

/** Where a Shift+key moves the lead to, or `undefined` for a key that does not. */
export function shiftTarget(key: string, lead: number, page: number, count: number): number | undefined {
  let next: number;
  switch (key) {
    case 'ArrowDown':
      next = lead + 1;
      break;
    case 'ArrowUp':
      next = lead - 1;
      break;
    case 'PageDown':
      next = lead + page;
      break;
    case 'PageUp':
      next = lead - page;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return undefined;
  }
  return Math.max(0, Math.min(count - 1, next));
}
