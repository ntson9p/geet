/**
 * What the filter row's `Branch ▾ User ▾ Date ▾ Paths ▾` dropdowns say about
 * the filter, in either look of `geet.log.filterChips` (POST-P14bh):
 *
 * - `compact` (the default, D39): each value cut short — a user's name without
 *   the e-mail, `me` for you, a date as `Since 2026/10/31` — and anything
 *   longer than IntelliJ's own 20 characters ends in `…`. The full value is
 *   the chip's tooltip.
 * - `full`: every value written out, the look the row had before.
 *
 * Pure and React-free, so every label is testable in plain Node. The bar also
 * takes its `Reset filters` from here, and the empty log its words.
 */
import type {
  LogDateFormat,
  LogFilterChips,
  LogFilterDto,
  LogRootDto,
} from '../../../src/shared/protocol';
import { pathOfPathspec } from '../../../src/core/git/pathspec';
import { formatFilterDay } from './dateFormat';
import { shortRef } from './logTabsModel';

/** IntelliJ's `MAX_FILTER_VALUE_LENGTH`: a longer value is cut, ending in `…`. */
export const MAX_CHIP_VALUE = 20;

/** What a chip shows after its label, and the whole of it for the tooltip. */
export interface ChipText {
  /** `undefined` when the dropdown filters nothing: the chip is its label alone. */
  readonly value: string | undefined;
  /** Every value, written out; `undefined` with `value`. */
  readonly full: string | undefined;
}

const NONE: ChipText = { value: undefined, full: undefined };

/**
 * IntelliJ's `displayableText`: one value as it is, several joined by `|`, and
 * cut to `max` characters with `…` when longer.
 */
export function displayableText(values: readonly string[], max = MAX_CHIP_VALUE): string {
  const text = values.join('|');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `Ben Okafor <ben@example.com>` → `Ben Okafor`; a bare e-mail stays as it is. */
export function authorName(author: string): string {
  const match = /^(.*?)\s*<([^<>]*)>$/u.exec(author.trim());
  if (!match) return author.trim();
  const name = (match[1] ?? '').trim();
  return name.length > 0 ? name : (match[2] ?? '').trim();
}

function authorEmail(author: string): string | undefined {
  return /<([^<>]*)>\s*$/u.exec(author)?.[1]?.trim();
}

/** `Branch ▾`: HEAD is no value — it is the log with no Branch filter. */
export function branchChip(f: LogFilterDto, mode: LogFilterChips): ChipText {
  if (f.range !== undefined) {
    const full = `${f.range.a}...${f.range.b}`;
    return {
      value: mode === 'compact' ? displayableText([`${shortRef(f.range.a)}...${shortRef(f.range.b)}`]) : full,
      full,
    };
  }
  if (f.refs === 'ALL') return { value: 'All', full: 'All branches' };
  if (Array.isArray(f.refs) && f.refs.length > 0) {
    const full = f.refs.join(', ');
    if (mode === 'compact') return { value: displayableText(f.refs), full };
    return { value: f.refs.length > 2 ? `${f.refs.length} refs` : full, full };
  }
  return NONE;
}

/**
 * `User ▾`. Compact names each user without the e-mail, and calls you `me`, as
 * IntelliJ's User filter does; `myAuthor` is your `user.email`, which is what
 * the dropdown's `Me` row filters by.
 */
export function userChip(f: LogFilterDto, mode: LogFilterChips, myAuthor?: string): ChipText {
  const authors = f.authors ?? [];
  if (authors.length === 0) return NONE;
  const full = authors.join(', ');
  if (mode === 'full') return { value: full, full };
  const isMe = (a: string): boolean =>
    myAuthor !== undefined && (a === myAuthor || authorEmail(a) === myAuthor);
  return { value: displayableText(authors.map((a) => (isMe(a) ? 'me' : authorName(a)))), full };
}

/**
 * `Date ▾`. Compact uses IntelliJ's words (`Since …`, `Until …`) and the
 * Date column's way of writing a day; full keeps `from → to`.
 */
export function dateChip(
  f: LogFilterDto,
  mode: LogFilterChips,
  dateFormat: LogDateFormat,
  locale?: string,
): ChipText {
  const from = f.dateRange?.from;
  const to = f.dateRange?.to;
  if (from === undefined && to === undefined) return NONE;
  const full = `${from ?? '…'} → ${to ?? '…'}`;
  if (mode === 'full') return { value: full, full };
  const day = (iso: string): string => formatFilterDay(iso, dateFormat, locale);
  const value =
    from !== undefined && to !== undefined
      ? `${day(from)}–${day(to)}`
      : from !== undefined
        ? `Since ${day(from)}`
        : `Until ${day(to!)}`;
  return { value, full };
}

/**
 * `Paths ▾`. It names the repository on show only when there is another to
 * choose, then the paths: in full as picked, compact by their last part. A
 * picked path's `:(literal)` is how git is told it is a name; it is not shown.
 */
export function pathsChip(
  f: LogFilterDto,
  mode: LogFilterChips,
  roots: readonly LogRootDto[],
  currentRoot: string,
): ChipText {
  const root = roots.length > 1 ? roots.find((r) => r.root === currentRoot)?.label : undefined;
  const paths = (f.paths ?? []).map(pathOfPathspec);
  const parts = root !== undefined ? [root, ...paths] : paths;
  if (parts.length === 0) return NONE;
  const full = parts.join(', ');
  if (mode === 'full') return { value: full, full };
  const lastPart = (p: string): string => p.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || p;
  return { value: displayableText([...(root !== undefined ? [root] : []), ...paths.map(lastPart)]), full };
}

/**
 * Whether anything filters the log — what `Reset filters` would clear. The
 * sort and First Parent are how the graph is drawn, not filters; No Merges is
 * a filter, as in IntelliJ.
 */
export function hasFilters(f: LogFilterDto): boolean {
  return (
    f.range !== undefined ||
    (f.refs !== undefined && f.refs !== 'HEAD') ||
    (f.authors ?? []).length > 0 ||
    f.dateRange !== undefined ||
    (f.paths ?? []).length > 0 ||
    (f.text?.q ?? '').length > 0 ||
    f.noMerges === true
  );
}

/** `Reset all filters`: HEAD's history, drawn the way it was drawn. */
export function resetFilters(f: LogFilterDto): LogFilterDto {
  return { sort: f.sort, refs: 'HEAD', ...(f.firstParent === true ? { firstParent: true } : {}) };
}

/** The empty log's second line: what the repository lacks, by name. */
export function missingRefsText(missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined;
  return `Not in this repository: ${missing.map(shortRef).join(', ')}`;
}
