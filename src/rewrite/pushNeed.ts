/**
 * What a history rewrite means for the next push (POST-QA F2). vscode-free so
 * the decision is unit-tested against real git; `PushSafetyService` asks it
 * after every rewrite.
 *
 * A force push is needed only when the rewrite replaced commits that were
 * already on the upstream, and that is asked of the commit the branch shared
 * with its upstream before the rewrite. "Is the upstream an ancestor of HEAD"
 * — the old test — is just as false when a teammate has pushed, which made
 * rewording a commit nobody had seen offer a force push over their work.
 */
import type { CancelToken, GitExecutor } from '../core/git/executor';
import { isBranchProtected, remoteBranchName } from '../scm/dialogs/pushModel';

export type PushNeed =
  /** The commits already on the upstream are all still in the branch. */
  | 'none'
  /** Published commits were replaced, and the upstream has nothing the branch lacked. */
  | 'force'
  /** Published commits were replaced, and the upstream also has commits the branch never had. */
  | 'force-would-lose'
  /** Published commits were replaced on a protected branch. */
  | 'protected';

export async function pushNeedAfterRewrite(
  git: GitExecutor,
  root: string,
  upstream: string,
  preHead: string,
  protectedPatterns: readonly string[],
  token?: CancelToken,
): Promise<PushNeed> {
  const run = (args: string[]): Promise<{ stdout: string; exitCode: number }> =>
    git.exec(root, args, { structured: true, noOptionalLocks: true, allowNonZeroExit: true, ...(token ? { token } : {}) });
  const isAncestor = async (a: string, b: string): Promise<boolean> =>
    (await run(['merge-base', '--is-ancestor', a, b])).exitCode === 0;

  const base = await run(['merge-base', preHead, upstream]);
  const shared = base.stdout.trim();
  if (base.exitCode !== 0 || shared.length === 0) return 'none';
  if (await isAncestor(shared, 'HEAD')) return 'none';
  if (isBranchProtected(remoteBranchName(upstream), protectedPatterns)) return 'protected';
  return (await isAncestor(upstream, preHead)) ? 'force' : 'force-would-lose';
}
