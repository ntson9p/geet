/**
 * LogFilter (P4-T1): canonical filter model → git args + cache key. Pure and
 * vscode-free; every UI surface (filter bar, file history, compare upgrade)
 * funnels through this one shape so filters always intersect.
 */

export interface LogFilter {
  /** Branch/ref selection: explicit refs, all refs, or HEAD's history. */
  refs?: string[] | 'ALL' | 'HEAD';
  /** Two-branch range mode (P2-T5 upgrade): symmetric difference A...B. */
  range?: { a: string; b: string };
  /** OR within; intersects with the other filter kinds (git semantics). */
  authors?: string[];
  dateRange?: { from?: string; to?: string };
  paths?: string[];
  text?: { q: string; regex: boolean; matchCase: boolean };
  sort: 'topo' | 'date' | 'intelli';
  /** Single-path file-history mode: adds --follow. */
  follow?: boolean;
  /**
   * Graph Options ▸ First Parent: follow only the first parent of a merge
   * (`--first-parent`). IntelliJ makes this a graph mode that stands in for the
   * sort (`PermanentGraph.Options.FirstParent`), so while it is on `sort` is
   * kept but not applied — see `graphSort` — and comes back when it is off.
   */
  firstParent?: boolean;
  /**
   * Graph Options ▸ No Merges: hide merge commits. Not handed to git as
   * `--no-merges`: the host drops them itself, so it still sees where each
   * one led and the graph's lines run through it — see `hidesCommit`.
   */
  noMerges?: boolean;
}

/**
 * POST-P14y: **date order is the default**, as it is in IntelliJ. Topological
 * order groups a branch's commits together wherever they were made, which
 * reads well for archaeology and badly for "what happened this week" — and
 * the second question is the one the log is opened for.
 */
export const DEFAULT_FILTER: LogFilter = { refs: 'HEAD', sort: 'date' };

/**
 * True when this filter hides nothing the repository has — every commit
 * reachable from any ref is in the view.
 *
 * `sort` is excluded on purpose: it reorders the stream, it never shortens it.
 * Note that the DEFAULT filter is *not* unfiltered — `refs: 'HEAD'` shows one
 * branch's history, which is why a commit on an unmerged branch is routinely
 * absent from a log nobody thinks they have filtered.
 */
export function isUnfiltered(f: LogFilter): boolean {
  return (
    f.refs === 'ALL' &&
    f.range === undefined &&
    (f.authors === undefined || f.authors.length === 0) &&
    f.dateRange === undefined &&
    (f.paths === undefined || f.paths.length === 0) &&
    (f.text === undefined || f.text.q.length === 0) &&
    f.follow !== true &&
    f.firstParent !== true &&
    f.noMerges !== true
  );
}

/** Canonical cache key: stable field order, undefineds dropped. */
export function filterKey(f: LogFilter): string {
  const refs = f.refs === undefined ? 'HEAD' : Array.isArray(f.refs) ? [...f.refs].sort() : f.refs;
  return JSON.stringify({
    refs,
    range: f.range ? `${f.range.a}...${f.range.b}` : undefined,
    authors: f.authors ? [...f.authors].sort() : undefined,
    from: f.dateRange?.from,
    to: f.dateRange?.to,
    paths: f.paths ? [...f.paths].sort() : undefined,
    q: f.text?.q,
    rx: f.text?.regex === true,
    mc: f.text?.matchCase === true,
    sort: f.sort,
    follow: f.follow === true,
    fp: f.firstParent === true,
    nm: f.noMerges === true,
  });
}

/**
 * The order the view is drawn in. First Parent replaces the sort while it is
 * on, as it does in IntelliJ, and draws in commit-date order: a first-parent
 * history has no merged-in commits for the topological orders to place.
 */
export function graphSort(f: LogFilter): LogFilter['sort'] {
  return f.firstParent === true ? 'date' : f.sort;
}

/**
 * The parents the graph draws a commit with. Under First Parent only the
 * first: `--first-parent` stops git *walking* the others, but `--parents`
 * still lists them, and a lane opened for a parent that never arrives would
 * run to the bottom of the log.
 */
export function graphParents(f: LogFilter, parents: readonly string[]): readonly string[] {
  return f.firstParent === true ? parents.slice(0, 1) : parents;
}

/**
 * Whether the host leaves this commit out of the view: a merge, under No
 * Merges. git's own `--no-merges` would hide it before the host ever saw its
 * parents, and every line waiting for it would then dangle.
 */
export function hidesCommit(f: LogFilter, parents: readonly string[]): boolean {
  return f.noMerges === true && parents.length > 1;
}

export interface LogPage {
  skip: number;
  maxCount: number;
}

/**
 * Builds the argv for one page. `--parents` keeps graph topology correct
 * under pathspec filtering (parent rewriting).
 */
/** `git rev-list --left-right --count a...b` prints the two counts on a line: `2\t3`. */
export function parseRangeCounts(output: string): { left: number; right: number } | undefined {
  const match = /^(\d+)\s+(\d+)\s*$/u.exec(output.trim());
  return match ? { left: Number(match[1]), right: Number(match[2]) } : undefined;
}

export function buildLogArgs(f: LogFilter, format: string, page: LogPage): string[] {
  // Full ref names: only they tell a local `feature/x` from a remote branch.
  const args = ['log', `--format=${format}`, '--parents', '--decorate=full'];

  args.push(graphSort(f) === 'date' ? '--date-order' : '--topo-order');
  if (f.firstParent === true) args.push('--first-parent');
  // `noMerges` has no argv on purpose — see `hidesCommit`.

  if (f.range) {
    args.push('--left-right', `${f.range.a}...${f.range.b}`);
  } else if (f.refs === 'ALL') {
    args.push('--all');
  } else if (Array.isArray(f.refs) && f.refs.length > 0) {
    args.push(...f.refs);
  }
  // refs === 'HEAD' or undefined → default HEAD history, no extra arg.

  for (const author of f.authors ?? []) {
    args.push(`--author=${author}`);
  }
  if (f.dateRange?.from !== undefined) args.push(`--since=${f.dateRange.from}`);
  if (f.dateRange?.to !== undefined) args.push(`--until=${f.dateRange.to}`);

  if (f.text && f.text.q.length > 0) {
    args.push(`--grep=${f.text.q}`);
    if (!f.text.matchCase) args.push('-i');
    args.push(f.text.regex ? '--extended-regexp' : '--fixed-strings');
  }

  args.push(`--skip=${page.skip}`, `--max-count=${page.maxCount}`);

  if (f.follow === true && f.paths?.length === 1) {
    args.push('--follow');
  }
  if (f.paths && f.paths.length > 0) {
    args.push('--', ...f.paths);
  }
  return args;
}
