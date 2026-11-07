/**
 * What a repository has checked out, as its row in the Commit window carries
 * it: IntelliJ's repository row shows the current branch after its file count
 * (`RepositoryChangesBrowserNodeBase.appendCurrentBranch`). Kept free of
 * `vscode` so its cases are unit-tested.
 */
import type { RepoSnapshot } from '../../core/model/repositoryModel';
import type { CommitRepoHeadDto } from '../../shared/protocol';

export type RepoHeadInput = Pick<RepoSnapshot, 'headRef' | 'headSha' | 'detached' | 'initial' | 'upstream'>;

/** Nothing when nothing is known yet: a repository read for the first time has no HEAD to name. */
export function repoHeadOf(snapshot: RepoHeadInput): CommitRepoHeadDto | undefined {
  const branch = snapshot.detached ? undefined : snapshot.headRef;
  if (branch === undefined && snapshot.headSha === undefined) return undefined;
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(snapshot.headSha !== undefined ? { sha: snapshot.headSha } : {}),
    // A detached HEAD tracks nothing, whatever the branch it left did.
    ...(branch !== undefined && snapshot.upstream !== undefined ? { upstream: snapshot.upstream } : {}),
    ...(snapshot.initial ? { unborn: true } : {}),
  };
}
