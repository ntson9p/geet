/**
 * A dialog's list of files, kept to what a dialog can hold (POST-QA). vscode-free.
 */

/** A path a line, the first `max` of them, then how many more. */
export function pathListDetail(paths: readonly string[], more: (count: number) => string, max = 10): string {
  const shown = paths.slice(0, max);
  const rest = paths.length - shown.length;
  return [...shown, ...(rest > 0 ? [more(rest)] : [])].join('\n');
}
