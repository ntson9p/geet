/**
 * The order a repository pick lists them in (POST-P14bp): the one the active
 * editor's file belongs to first, so Enter takes it as before, now with its
 * name on screen; then the rest as the workspace lists them. Pure and
 * vscode-free, so it is unit-testable.
 */
export function repoPickOrder<T extends { readonly root: string }>(
  repos: readonly T[],
  preferredRoot: string | undefined,
  key: (root: string) => string = (root) => root,
): T[] {
  if (preferredRoot === undefined) return [...repos];
  const wanted = key(preferredRoot);
  const first = repos.find((r) => key(r.root) === wanted);
  return first === undefined ? [...repos] : [first, ...repos.filter((r) => r !== first)];
}
