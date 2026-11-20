/**
 * The strategy flag for Geet: Pull (POST-QA F6), vscode-free for tests.
 *
 * `git pull` with nothing configured refuses a diverged branch since git 2.27
 * ("Need to specify how to reconcile divergent branches"), which left
 * Geet: Pull failing with exit 128 in the QA. The user's `pull.rebase`,
 * `pull.ff` or `branch.<name>.rebase` still decides when set; otherwise
 * merge — git's own long-time default and IntelliJ's.
 */
import type { GitExecutor } from '../core/git/executor';

export async function pullStrategyArgs(
  git: GitExecutor,
  root: string,
  branch: string | undefined,
): Promise<string[]> {
  const exec = (args: string[]): Promise<{ stdout: string }> =>
    git.exec(root, args, { structured: true, allowNonZeroExit: true });
  const pull = await exec(['config', '--get-regexp', '^pull\\.(rebase|ff)$']);
  if (pull.stdout.trim().length > 0) return [];
  if (branch !== undefined) {
    const own = await exec(['config', '--get', `branch.${branch}.rebase`]);
    if (own.stdout.trim().length > 0) return [];
  }
  return ['--no-rebase'];
}
