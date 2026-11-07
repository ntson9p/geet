/**
 * IntelliJ's `GitUnresolvedMergeCheckProvider`, as the pure pieces the commit
 * flow asks before anything is committed (POST-QA). vscode-free.
 */
import type { StatusEntry } from '../core/model/statusEntry';

const norm = (p: string): string => p.replace(/\\/g, '/');

/** "Cannot commit changes due to unresolved conflicts.": any unmerged path stops a commit. */
export function hasUnresolvedConflicts(entries: readonly StatusEntry[]): boolean {
  return entries.some((e) => e.kind === 'unmerged');
}

/**
 * The changes a merge commit would leave out. With changelists a merge commit
 * is HEAD plus what is ticked, so an unticked file keeps our side in it —
 * IntelliJ asks first ("Changes Excluded from Merge Commit"). Unversioned
 * files are no part of any commit and are not asked about.
 */
export function excludedFromMergeCommit(
  listed: readonly string[],
  ticked: readonly string[],
  isUntracked: (relPath: string) => boolean,
): string[] {
  const included = new Set(ticked.map(norm));
  return [...new Set(listed)].filter((p) => !included.has(norm(p)) && !isUntracked(p));
}

/** A dialog's detail: a path a line, the first `max` of them, then how many more. */
export function pathListDetail(paths: readonly string[], more: (count: number) => string, max = 10): string {
  const shown = paths.slice(0, max);
  const rest = paths.length - shown.length;
  return [...shown, ...(rest > 0 ? [more(rest)] : [])].join('\n');
}
