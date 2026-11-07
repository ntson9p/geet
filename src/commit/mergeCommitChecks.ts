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
