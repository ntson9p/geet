/**
 * The Git tool window's tab strip, as IntelliJ draws it: `Log`, `Console`,
 * `Worktrees`, then any extra Log tabs in the order they were opened, each with
 * a `×`, and a `+` after the last (`Open Another Log Tab`). Pure, so titles and
 * the close rules are testable without a page.
 */
import type { LogFilterDto, LogTabDto } from '../../../src/shared/protocol';

/** The main Log tab's id, which is also what the strip has always called the log. */
export const MAIN_LOG_TAB = 'log';

/** The strip items that are not Log tabs, in IntelliJ's place: right after the main tab. */
export const FIXED_TABS = ['console', 'worktrees'] as const;

const SHA_RE = /^[0-9a-f]{40}$/iu;
/** A ref by its own name, a commit hash by the start of it. */
export const shortRef = (ref: string): string => (SHA_RE.test(ref) ? ref.slice(0, 7) : ref);

/**
 * Two branches or tags side by side. A range of two hashes is something else: the
 * commits an update brought in, an older revision and a newer, with no two sides.
 */
export function comparedRefs(filter: LogFilterDto): { readonly a: string; readonly b: string } | undefined {
  const { range } = filter;
  return range === undefined || (SHA_RE.test(range.a) && SHA_RE.test(range.b)) ? undefined : range;
}

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** One filter's part of a title: alone it reads bare, among others prefixed. */
interface TitlePart {
  readonly value: string;
  readonly prefixed: string;
}

const part = (value: string, prefix = ''): TitlePart => ({ value, prefixed: `${prefix}${value}` });

/**
 * What each filter contributes, in IntelliJ's words (`VcsLogBundle`'s
 * `*.presentation.with.prefix` strings, and each filter's `displayText`).
 * A range and No Merges take no prefix there either.
 */
function titleParts(filter: LogFilterDto): TitlePart[] {
  const parts: TitlePart[] = [];
  if (filter.range !== undefined) {
    const { a, b } = filter.range;
    const between = comparedRefs(filter) !== undefined ? ' and ' : '...';
    parts.push(part(`${shortRef(a)}${between}${shortRef(b)}`));
  } else if (filter.refs === 'ALL') {
    parts.push(part('All', 'on '));
  } else if (Array.isArray(filter.refs) && filter.refs.length > 0) {
    parts.push(part(filter.refs.map(shortRef).join(', '), 'on '));
  }
  if (filter.authors !== undefined && filter.authors.length > 0) {
    parts.push(part(filter.authors.join(', '), 'by '));
  }
  const from = filter.dateRange?.from;
  const to = filter.dateRange?.to;
  if (from !== undefined && to !== undefined) parts.push(part(`between ${from} and ${to}`, 'made '));
  else if (from !== undefined) parts.push(part(`since ${from}`, 'made '));
  else if (to !== undefined) parts.push(part(`until ${to}`, 'made '));
  // IntelliJ names a path filter by its files' and folders' own names.
  if (filter.paths !== undefined && filter.paths.length > 0) {
    parts.push(part(filter.paths.map(basename).join(', '), 'for '));
  }
  if (filter.text !== undefined && filter.text.q.length > 0) {
    parts.push(part(`'${filter.text.q}'`, 'containing '));
  }
  if (filter.noMerges === true) parts.push(part('--no-merges'));
  return parts;
}

/** `2 commits only on` / `1 commit only on`, or just `Only on` until there is a count. */
export function sideLabel(count: number | undefined): string {
  if (count === undefined) return 'Only on';
  return `${count} ${count === 1 ? 'commit' : 'commits'} only on`;
}

/**
 * A Log tab's title, made from what it shows by IntelliJ's own rule
 * (`VcsLogFilterCollection.getPresentation`): one filter reads as its bare
 * value — `Log: 2026.1`, `Log: --no-merges` — and several each take their
 * prefix, joined by spaces — `Log: on HEAD --no-merges`. Unfiltered it is
 * plain `Log`; a file's history reads `History: <file>` and two branches side by
 * side `Compare: a and b`, IntelliJ's names for those tabs. The sort and First
 * Parent are how the graph is drawn, not filters, so they never show.
 */
export function tabTitle(filter: LogFilterDto): string {
  if (filter.follow === true && filter.paths?.length === 1) {
    return `History: ${basename(filter.paths[0]!)}`;
  }
  const parts = titleParts(filter);
  if (parts.length === 0) return 'Log';
  const name = comparedRefs(filter) !== undefined ? 'Compare' : 'Log';
  return `${name}: ${parts.length === 1 ? parts[0]!.value : parts.map((p) => p.prefixed).join(' ')}`;
}

/** Every strip item in order: the main Log tab, Console, Worktrees, then the extra Log tabs. */
export function stripOrder(tabs: readonly LogTabDto[]): string[] {
  const main = tabs.find((t) => t.id === MAIN_LOG_TAB)?.id ?? MAIN_LOG_TAB;
  return [main, ...FIXED_TABS, ...tabs.filter((t) => t.id !== MAIN_LOG_TAB).map((t) => t.id)];
}

/**
 * What the strip shows once `closing` is gone: the same item if it stays,
 * else the nearest one to its left, as closing an editor tab does.
 */
export function afterClose(order: readonly string[], current: string, closing: readonly string[]): string {
  const gone = new Set(closing);
  if (!gone.has(current)) return current;
  const at = order.indexOf(current);
  for (let i = at - 1; i >= 0; i--) {
    const id = order[i]!;
    if (!gone.has(id)) return id;
  }
  return order.find((id) => !gone.has(id)) ?? MAIN_LOG_TAB;
}

export type CloseAction = 'close' | 'others' | 'all';

/**
 * The tabs a tab-menu item closes, IntelliJ's Close Tab / Close Other Tabs /
 * Close All Tabs. Only extra Log tabs ever close: the main tab, Console and
 * Worktrees stay.
 */
export function closeTargets(tabs: readonly LogTabDto[], clicked: string, action: CloseAction): string[] {
  const closable = tabs.filter((t) => t.closable).map((t) => t.id);
  if (action === 'close') return closable.includes(clicked) ? [clicked] : [];
  if (action === 'others') return closable.filter((id) => id !== clicked);
  return closable;
}
