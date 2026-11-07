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

/**
 * The folder a Commit-window folder row stands for, repository-relative with
 * `/` separators, among the arguments a command was called with. Its files
 * travel beside it in `relPaths`; the folder itself is what lets Add to
 * .gitignore write one rule for it.
 */
export function folderOf(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) continue;
    const folder = (arg as { folder?: unknown }).folder;
    if (typeof folder !== 'string') continue;
    const clean = folder.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
    if (clean.length > 0 && !clean.split('/').includes('..')) return clean;
  }
  return undefined;
}
