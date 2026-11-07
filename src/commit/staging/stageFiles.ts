/**
 * Whole-file Stage and Unstage for the staging paradigm's Commit window
 * (POST-QA F5). vscode-free, so it is unit-tested against real git.
 */
import type { CancelToken, GitExecutor } from '../../core/git/executor';
import { chunked } from '../changelists/moveChoices';

const opt = (token: CancelToken | undefined): { token?: CancelToken } => (token ? { token } : {});

/**
 * `git add -A` per slice of paths: a modification, a new file and a deletion
 * all go into the index alike, as IntelliJ's Stage does.
 */
export async function stageFiles(
  git: GitExecutor,
  root: string,
  paths: readonly string[],
  token?: CancelToken,
): Promise<void> {
  for (const slice of chunked(paths)) {
    await git.exec(root, ['add', '-A', '--', ...slice], opt(token));
  }
}

/**
 * The index back to HEAD for these paths — a staged new file becomes
 * untracked again, its content untouched. Before the first commit there is
 * no HEAD to go back to, so the paths simply leave the index.
 */
export async function unstageFiles(
  git: GitExecutor,
  root: string,
  paths: readonly string[],
  token?: CancelToken,
): Promise<void> {
  const head = await git.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    structured: true,
    allowNonZeroExit: true,
    ...opt(token),
  });
  for (const slice of chunked(paths)) {
    if (head.exitCode === 0) {
      await git.exec(root, ['reset', '-q', 'HEAD', '--', ...slice], opt(token));
    } else {
      await git.exec(root, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...slice], opt(token));
    }
  }
}
