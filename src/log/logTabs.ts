/**
 * The Git tool window's Log tabs (IntelliJ's `Open Another Log Tab`, the `+`
 * beside the tabs). The first tab, `Log`, is always there; the others are
 * opened with `+` (a copy of the current filters), by File History, by Compare
 * with Current, by a branch's Show in New Log Tab and by an update's Show in
 * Log, and closed with their `×` or the tab menu's Close Tab / Close Other
 * Tabs / Close All Tabs.
 *
 * This is only the list: which tabs exist, what each one filters, which one
 * commands act on. Nothing here imports `vscode`; `LogViewProvider` owns the
 * sessions and stores the state in workspace state so tabs come back after a
 * restart. They come back lazily: a restored tab costs nothing until it is
 * first shown.
 */
import { DEFAULT_FILTER, filterKey, type LogFilter } from './logFilter';

/** The first tab. Its id is also what the tab strip has always called the log. */
export const MAIN_LOG_TAB = 'log';

export interface LogTabRecord {
  readonly id: string;
  readonly filter: LogFilter;
  /**
   * The repository an extra tab shows. The main tab has none: it follows the
   * repository the log has always remembered (`geet.log.root`).
   */
  readonly root?: string;
}

export interface LogTabsState {
  /** The main tab first, then the extra tabs in the order they were opened. */
  readonly tabs: readonly LogTabRecord[];
  /** The tab commands act on: the one last shown. */
  readonly active: string;
  /** Feeds the next id (`log-<n>`); never reused within a workspace. */
  readonly next: number;
}

export function initialTabsState(filter: LogFilter = DEFAULT_FILTER): LogTabsState {
  return { tabs: [{ id: MAIN_LOG_TAB, filter }], active: MAIN_LOG_TAB, next: 1 };
}

export function isClosable(id: string): boolean {
  return id !== MAIN_LOG_TAB;
}

/**
 * Whether two filters show the same commits. The sort is left out: it orders
 * the list, it does not change what is in it, so a history tab re-sorted by
 * hand is still the tab to go back to. First Parent and No Merges do change
 * what is in it, so they count.
 */
export function sameView(a: LogFilter, b: LogFilter): boolean {
  return filterKey(normalized(a)) === filterKey(normalized(b));
}

function normalized(f: LogFilter): LogFilter {
  const out: LogFilter = { ...f, sort: 'date' };
  if (out.refs === undefined) out.refs = 'HEAD';
  if (out.authors?.length === 0) delete out.authors;
  if (out.paths?.length === 0) delete out.paths;
  if (out.text !== undefined && out.text.q.length === 0) delete out.text;
  if (out.follow !== true) delete out.follow;
  if (out.firstParent !== true) delete out.firstParent;
  if (out.noMerges !== true) delete out.noMerges;
  return out;
}

/**
 * The tab already showing `filter` in `root`, if any, so running File History
 * on the same file twice goes back to its tab instead of opening another.
 * `rootOf` says which repository a tab shows (the main tab's is resolved by
 * the caller); `sameRoot` compares two of them.
 */
export function findTab(
  state: LogTabsState,
  filter: LogFilter,
  root: string | undefined,
  rootOf: (tab: LogTabRecord) => string | undefined,
  sameRoot: (a: string, b: string) => boolean,
  opts: { readonly skipMain?: boolean } = {},
): string | undefined {
  return state.tabs.find((tab) => {
    // Asked for as a new tab: the main tab is the log itself, whose view
    // moves with whatever is done there, so it is never the one reused.
    if (opts.skipMain === true && tab.id === MAIN_LOG_TAB) return false;
    if (!sameView(tab.filter, filter)) return false;
    const here = rootOf(tab);
    if (root === undefined || here === undefined) return root === here;
    return sameRoot(here, root);
  })?.id;
}

/** A new tab at the end of the strip, made the active one. */
export function openTab(
  state: LogTabsState,
  filter: LogFilter,
  root: string | undefined,
): { state: LogTabsState; id: string } {
  const id = `${MAIN_LOG_TAB}-${state.next}`;
  const tab: LogTabRecord = root !== undefined ? { id, filter, root } : { id, filter };
  return { state: { tabs: [...state.tabs, tab], active: id, next: state.next + 1 }, id };
}

/**
 * Closes `ids`, apart from the main tab, which cannot be closed. If the active
 * tab goes, the main tab becomes active; the strip says which tab is shown.
 */
export function closeTabs(state: LogTabsState, ids: readonly string[]): LogTabsState {
  const closing = new Set(ids.filter(isClosable));
  if (closing.size === 0) return state;
  const tabs = state.tabs.filter((tab) => !closing.has(tab.id));
  return { ...state, tabs, active: closing.has(state.active) ? MAIN_LOG_TAB : state.active };
}

export function activateTab(state: LogTabsState, id: string): LogTabsState {
  if (state.active === id || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, active: id };
}

/** A tab's filter, and for an extra tab its repository, after it changed. */
export function updateTab(
  state: LogTabsState,
  id: string,
  filter: LogFilter,
  root: string | undefined,
): LogTabsState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      if (tab.id !== id) return tab;
      // The main tab's repository is remembered elsewhere; an extra tab keeps
      // its own unless this change moved it.
      const kept = id === MAIN_LOG_TAB ? undefined : (root ?? tab.root);
      return kept !== undefined ? { id, filter, root: kept } : { id, filter };
    }),
  };
}

/**
 * The state as stored, checked field by field: workspace state outlives the
 * code that wrote it, and a malformed entry must cost that tab, not the log.
 * `legacyMainFilter` is the filter the single log used to keep in the webview,
 * used only when nothing has been stored yet.
 */
export function restoreTabsState(raw: unknown, legacyMainFilter?: LogFilter): LogTabsState {
  const fresh = initialTabsState(legacyMainFilter ?? DEFAULT_FILTER);
  if (raw === null || typeof raw !== 'object') return fresh;
  const r = raw as { tabs?: unknown; active?: unknown; next?: unknown };
  if (!Array.isArray(r.tabs)) return fresh;

  const tabs: LogTabRecord[] = [];
  const seen = new Set<string>();
  let highest = 0;
  for (const entry of r.tabs) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; filter?: unknown; root?: unknown };
    if (typeof e.id !== 'string' || seen.has(e.id) || !isFilter(e.filter)) continue;
    if (e.id !== MAIN_LOG_TAB && !/^log-\d+$/u.test(e.id)) continue;
    seen.add(e.id);
    highest = Math.max(highest, Number(e.id.slice(MAIN_LOG_TAB.length + 1)) || 0);
    const root = e.id !== MAIN_LOG_TAB && typeof e.root === 'string' ? e.root : undefined;
    tabs.push(root !== undefined ? { id: e.id, filter: e.filter, root } : { id: e.id, filter: e.filter });
  }
  // The main tab leads, whatever was stored.
  const main = tabs.find((tab) => tab.id === MAIN_LOG_TAB) ?? fresh.tabs[0]!;
  const ordered = [main, ...tabs.filter((tab) => tab.id !== MAIN_LOG_TAB)];
  const active =
    typeof r.active === 'string' && ordered.some((tab) => tab.id === r.active) ? r.active : MAIN_LOG_TAB;
  const next = Math.max(typeof r.next === 'number' && Number.isInteger(r.next) ? r.next : 1, highest + 1);
  return { tabs: ordered, active, next };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** An object's fields, or nothing for anything that is not an object. */
function fieldsOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function isFilter(value: unknown): value is LogFilter {
  const f = fieldsOf(value);
  if (f === undefined) return false;
  if (f.sort !== 'date' && f.sort !== 'topo' && f.sort !== 'intelli') return false;
  if (f.refs !== undefined && f.refs !== 'ALL' && f.refs !== 'HEAD' && !isStringArray(f.refs)) return false;
  if (f.authors !== undefined && !isStringArray(f.authors)) return false;
  if (f.paths !== undefined && !isStringArray(f.paths)) return false;
  if (f.follow !== undefined && typeof f.follow !== 'boolean') return false;
  if (f.firstParent !== undefined && typeof f.firstParent !== 'boolean') return false;
  if (f.noMerges !== undefined && typeof f.noMerges !== 'boolean') return false;
  if (f.range !== undefined) {
    const range = fieldsOf(f.range);
    if (typeof range?.a !== 'string' || typeof range.b !== 'string') return false;
  }
  if (f.text !== undefined && typeof fieldsOf(f.text)?.q !== 'string') return false;
  if (f.dateRange !== undefined && fieldsOf(f.dateRange) === undefined) return false;
  return true;
}
