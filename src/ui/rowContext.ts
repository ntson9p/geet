/**
 * The repository a webview row's native context menu was opened on. VS Code
 * hands a `webview/context` command the row's `data-vscode-context` object, so
 * a row standing for one repository passes `{ repoRoot }` (the Commit window's
 * repository rows do). Free of `vscode`, so it is unit-tested.
 */
export function repoRootOf(arg: unknown): string | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const root = (arg as { repoRoot?: unknown }).repoRoot;
  return typeof root === 'string' && root.length > 0 ? root : undefined;
}
