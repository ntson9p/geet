/**
 * A Stash tab row's menu context (`StashTab.rowContext`): which stash it is,
 * by sha (POST-QA: the rows had no menu). vscode-free.
 */
export function stashRowOf(arg: unknown): { repoRoot: string; sha: string } | undefined {
  if (typeof arg !== 'object' || arg === null) return undefined;
  const { webviewSection, repoRoot, stashSha } = arg as Record<string, unknown>;
  if (webviewSection !== 'stashEntry' && webviewSection !== 'stashFile') return undefined;
  if (typeof repoRoot !== 'string' || typeof stashSha !== 'string') return undefined;
  return { repoRoot, sha: stashSha };
}
