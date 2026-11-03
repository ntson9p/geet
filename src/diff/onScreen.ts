/**
 * The mark a list keeps on the file whose diff is on screen (`DiffEntry.onScreen`),
 * pure and vscode-free so the rule is unit-tested. The Log's Changed Files, the
 * Commit window and the Compare pane each keep one.
 */

/**
 * What a list marks once one of its diffs came on screen or left it. A diff
 * leaving is no reason to drop a mark that names another file: the list may
 * already have heard of the one that came. `unchanged`: nothing to tell the list.
 */
export function nextMark<T>(
  marked: T | undefined,
  file: T,
  showing: boolean,
  same: (a: T, b: T) => boolean,
): { readonly mark: T | undefined } | 'unchanged' {
  if (showing) return { mark: file };
  return marked !== undefined && same(marked, file) ? { mark: undefined } : 'unchanged';
}
