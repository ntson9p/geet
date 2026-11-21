/**
 * What a commit row hands VS Code's native context menu (`data-vscode-context`):
 * the commits it acts on, and the keys `package.json`'s `webview/context`
 * entries read to follow IntelliJ's menu for a selection —
 *
 * - `geet.commitCount`: how many commits; `Compare Versions` shows at 2.
 * - `geet.multiCommit`: set from 2 on. Single-commit actions IntelliJ hides
 *   (`Checkout`, `Compare with Local`, `Undo Commit`, `Edit Commit Message…`,
 *   `Fixup…`, `Squash Into…`, `Interactively Rebase from Here…`, the branch
 *   group) go; the ones it greys out (`Show Repository at Revision`, `Reset
 *   Current Branch to Here…`, `Push All up to Here`, `New Branch…`, `New Tag…`,
 *   `Go to Child/Parent Commit`) stay disabled; `Revert Commits`, `Drop
 *   Commits` and `Squash Commits…` take the plural places.
 * - `geet.mergeSelected`: one of them is a merge, which IntelliJ will not
 *   revert, drop or squash.
 * - `geet.notHead`: the one commit is not HEAD. IntelliJ's `Undo Commit…`
 *   stays in the menu, greyed out, for any commit but the branch's last
 *   (POST-QA: it was offered, then refused). Negated in `enablement`, so the
 *   palette, where no row says anything, keeps it.
 *
 * Built from the selection as it stood before the right-click, because VS Code
 * reads this attribute in the same event. Pure.
 */
export interface MenuRow {
  readonly sha: string;
  readonly parents: readonly string[];
  /** The row's ref chips: HEAD is a bare `head` chip, or the branch it points at. */
  readonly refs?: readonly { readonly type: string; readonly isHeadTarget?: boolean }[];
}

/** Whether the row is HEAD; unknown without its refs. */
function isHeadRow(row: MenuRow): boolean | undefined {
  if (row.refs === undefined) return undefined;
  return row.refs.some((r) => r.type === 'head' || r.isHeadTarget === true);
}

export function commitMenuContext(
  row: MenuRow,
  selection: readonly string[],
  rowOf: (sha: string) => MenuRow | undefined,
): Record<string, unknown> {
  // Right-clicking outside the selection acts on that commit alone.
  const shas = selection.includes(row.sha) ? [...selection] : [row.sha];
  const merge = shas.some((sha) => ((sha === row.sha ? row : rowOf(sha))?.parents.length ?? 0) > 1);
  return {
    webviewSection: 'commit',
    sha: row.sha,
    shas,
    'geet.commitCount': shas.length,
    ...(shas.length > 1 ? { 'geet.multiCommit': true } : {}),
    ...(merge ? { 'geet.mergeSelected': true } : {}),
    ...(shas.length === 1 && isHeadRow(row) === false ? { 'geet.notHead': true } : {}),
    preventDefaultContextMenuItems: true,
  };
}
