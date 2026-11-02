/**
 * Whether a repository can take a branch operation now (POST-P14ax), and why
 * not, in the words every GitTree summary uses for it. vscode-free, so the rule
 * is unit-tested.
 *
 * A merge or rebase in progress is one reason. Conflicts with no operation
 * behind them are the other: a stash or Smart Checkout whose changes did not go
 * back cleanly. The conflict lifecycle holds the repository's mutations while
 * either lasts, so an operation queued there would wait until the conflicts are
 * resolved — and an operation across repositories that queued one would wait
 * with it, for every repository after.
 */
import type { RepoSnapshot } from './repositoryModel';

export function repoBusyReason(snapshot: Pick<RepoSnapshot, 'inProgressOp' | 'statusEntries'>): string | undefined {
  const op = snapshot.inProgressOp?.kind;
  if (op !== undefined) return `a ${op.startsWith('rebase') ? 'rebase' : op} is in progress`;
  if (snapshot.statusEntries.some((e) => e.kind === 'unmerged')) return 'it has conflicts to resolve';
  return undefined;
}
