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
    f.follow !== true
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
  });
}

export interface LogPage {
  skip: number;
  maxCount: number;
}

/**
 * Builds the argv for one page. `--parents` keeps graph topology correct
 * under pathspec filtering (parent rewriting).
 */
export function buildLogArgs(f: LogFilter, format: string, page: LogPage): string[] {
  const args = ['log', `--format=${format}`, '--parents'];

  args.push(f.sort === 'date' ? '--date-order' : '--topo-order');

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
