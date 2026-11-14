/**
 * The commit list's columns, as IntelliJ lays them out (`VcsLogDefaultColumn`,
 * `VcsLogColumnManager`): the message (Subject) column with the graph inside
 * it takes what is left; after it come Author, Date and — hidden by default —
 * Hash, each switched on and off under `Presentation Settings ▸ Columns`.
 * There is no header row. A column's left border can be dragged, and a
 * double-click on it gives the column back its own width. Pure: text widths
 * come from the caller.
 */

export type ColumnId = 'author' | 'date' | 'hash';

/** IntelliJ's order after the message column. */
export const COLUMN_ORDER: readonly ColumnId[] = ['author', 'date', 'hash'];

/** Widths the user dragged a column to; a column without one fits its content. */
export type ColumnWidths = Partial<Record<ColumnId, number>>;

/** A cell's own horizontal padding, both sides together. */
export const CELL_PADDING = 16;
/** IntelliJ's cap on a width taken from the rows (`MAX_DEFAULT_DYNAMIC_COLUMN_WIDTH`). */
export const MAX_AUTO_WIDTH = 300;
/** How many rows IntelliJ reads to size a column (`MAX_ROWS_TO_CALC_WIDTH`). */
export const MAX_ROWS_TO_MEASURE = 1000;
export const MIN_COLUMN_WIDTH = 40;
/** IntelliJ's Hash column shows the first eight characters (`SHORT_HASH_LENGTH`). */
export const SHORT_HASH_LENGTH = 8;
/**
 * What the Hash column is sized by. IntelliJ measures eight `e`s, which fits
 * its own font; in a proportional one the digits run wider, so the widest
 * hex characters are measured too.
 */
export const HASH_SAMPLES: readonly string[] = ['e', '0', '8', 'd'].map((ch) => ch.repeat(SHORT_HASH_LENGTH));

export function visibleColumns(p: {
  readonly showAuthorColumn: boolean;
  readonly showDateColumn: boolean;
  readonly showHashColumn: boolean;
}): ColumnId[] {
  const on: Record<ColumnId, boolean> = {
    author: p.showAuthorColumn,
    date: p.showDateColumn,
    hash: p.showHashColumn,
  };
  return COLUMN_ORDER.filter((id) => on[id]);
}

/**
 * IntelliJ's author text (`CommitPresentationUtil.getAuthorPresentation`): the
 * name, and a `*` when someone else committed the change.
 */
export function authorText(name: string, committedByOther: boolean | undefined): string {
  return committedByOther === true ? `${name}*` : name;
}

/**
 * The Author column's own width: its widest name, measured as IntelliJ does
 * with room for the `*`, over the first thousand rows, capped at 300 pixels.
 */
export function autoAuthorWidth(names: Iterable<string>, measure: (text: string) => number): number {
  let widest = 0;
  let seen = 0;
  for (const name of names) {
    if (seen++ >= MAX_ROWS_TO_MEASURE) break;
    widest = Math.max(widest, measure(name.endsWith('*') ? name : `${name}*`));
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.min(Math.ceil(widest) + CELL_PADDING, MAX_AUTO_WIDTH));
}

/**
 * A column sized by its rows' text, as IntelliJ's `PreferredWidth.FromData`
 * sizes one (`"$value*"`): the widest of the first thousand, with room for a
 * `*`, capped at 300 pixels. The Date column with IntelliJ's dates (POST-P14cg),
 * whose `Moments ago` and full dates no one sample can stand for.
 */
export function autoTextWidth(texts: Iterable<string>, measure: (text: string) => number): number {
  let widest = 0;
  let seen = 0;
  for (const text of texts) {
    if (seen++ >= MAX_ROWS_TO_MEASURE) break;
    if (text === '') continue;
    widest = Math.max(widest, measure(`${text}*`));
  }
  return Math.max(MIN_COLUMN_WIDTH, Math.min(Math.ceil(widest) + CELL_PADDING, MAX_AUTO_WIDTH));
}

/** A column sized by samples rather than by the rows (Date, Hash): the widest, in bold for slack. */
export function sampleWidth(samples: string | readonly string[], measureBold: (text: string) => number): number {
  const list = typeof samples === 'string' ? [samples] : samples;
  const widest = list.reduce((w, sample) => Math.max(w, measureBold(sample)), 0);
  return Math.max(MIN_COLUMN_WIDTH, Math.ceil(widest) + CELL_PADDING);
}

/**
 * Each visible column's width in a row `rowWidth` pixels wide. A dragged width
 * is kept while it fits the row, as IntelliJ keeps a saved one; otherwise the
 * column fits its content. When the columns would squeeze the message under
 * `minSubject`, they give way together, none below its minimum.
 */
export function fitColumns(
  visible: readonly ColumnId[],
  auto: Readonly<Record<ColumnId, number>>,
  dragged: ColumnWidths,
  rowWidth: number,
  minSubject: number,
): Record<ColumnId, number> {
  const widths = { author: 0, date: 0, hash: 0 };
  for (const id of visible) {
    const own = dragged[id];
    widths[id] = own !== undefined && own > 0 && own <= rowWidth ? Math.max(MIN_COLUMN_WIDTH, own) : auto[id];
  }
  const total = visible.reduce((sum, id) => sum + widths[id], 0);
  const room = rowWidth - minSubject;
  if (total > room && total > 0) {
    const slack = visible.reduce((sum, id) => sum + (widths[id] - MIN_COLUMN_WIDTH), 0);
    const cut = Math.min(total - room, slack);
    if (slack > 0) {
      for (const id of visible) {
        widths[id] = Math.floor(widths[id] - (cut * (widths[id] - MIN_COLUMN_WIDTH)) / slack);
      }
    }
  }
  return widths;
}

/**
 * A column's width while its left border is dragged `dx` pixels (negative is
 * leftwards, which widens it): never under its minimum, and never so wide the
 * message column drops below `minSubject`.
 */
export function draggedWidth(
  start: number,
  dx: number,
  othersWidth: number,
  rowWidth: number,
  minSubject: number,
): number {
  const max = Math.max(MIN_COLUMN_WIDTH, rowWidth - minSubject - othersWidth);
  return Math.round(Math.min(max, Math.max(MIN_COLUMN_WIDTH, start - dx)));
}

/** Reads stored widths back, dropping anything that is not a positive number for a known column. */
export function readColumnWidths(raw: unknown): ColumnWidths {
  if (raw === null || typeof raw !== 'object') return {};
  const out: ColumnWidths = {};
  for (const id of COLUMN_ORDER) {
    const value = (raw as Record<string, unknown>)[id];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
  }
  return out;
}
