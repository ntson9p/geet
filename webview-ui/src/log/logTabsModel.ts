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
const short = (ref: string): string => (SHA_RE.test(ref) ? ref.slice(0, 7) : ref);

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/**
 * A Log tab's title, made from what it shows, as IntelliJ titles its tabs
 * (`Log: 2026.1`). Unfiltered it is plain `Log`; a file's history reads
 * `History: <file>`, IntelliJ's name for that tab. The branch part comes
 * unlabelled and first, the others name their filter.
 */
export function tabTitle(filter: LogFilterDto): string {
  if (filter.follow === true && filter.paths?.length === 1) {
    return `History: ${basename(filter.paths[0]!)}`;
  }
  const parts: string[] = [];
  if (filter.range !== undefined) {
    parts.push(`${short(filter.range.a)}...${short(filter.range.b)}`);
  } else if (filter.refs === 'ALL') {
    parts.push('All');
  } else if (Array.isArray(filter.refs) && filter.refs.length > 0) {
    parts.push(filter.refs.map(short).join(', '));
  }
  if (filter.authors !== undefined && filter.authors.length > 0) {
    parts.push(`User: ${filter.authors.join(', ')}`);
  }
  const from = filter.dateRange?.from;
  const to = filter.dateRange?.to;
  if (from !== undefined || to !== undefined) parts.push(`Date: ${from ?? '…'} → ${to ?? '…'}`);
  if (filter.paths !== undefined && filter.paths.length > 0) {
    parts.push(`Paths: ${filter.paths.join(', ')}`);
  }
  if (filter.text !== undefined && filter.text.q.length > 0) parts.push(`Text: ${filter.text.q}`);
  return parts.length === 0 ? 'Log' : `Log: ${parts.join(', ')}`;
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
