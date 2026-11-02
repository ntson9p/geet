/**
 * The New Branch form's rules (new-way-4), apart from the form so they are
 * unit-tested: which repositories can take the branch, what is wrong with what
 * was typed, how the start point reads, and what the branch will track.
 */
import { newBranchTrackFlag } from '../../../src/branches/newBranchArgs';
import { isValidRefName } from '../../../src/core/git/refName';
import type { BranchPanelRepoDto } from '../../../src/shared/protocol';

function hasRef(repo: BranchPanelRepoDto, name: string): boolean {
  return (
    repo.locals.some((r) => r.name === name) ||
    repo.remotes.some((r) => r.name === name) ||
    repo.tags.some((r) => r.name === name)
  );
}

/** Where a start point is available: everywhere for `HEAD`, else where the ref exists. */
export function eligibleRepos(repos: readonly BranchPanelRepoDto[], from: string): BranchPanelRepoDto[] {
  return from === 'HEAD' ? [...repos] : repos.filter((r) => hasRef(r, from));
}

/** What the form says is wrong, or `undefined` when Create can go. */
export function formProblem(
  name: string,
  chosen: readonly BranchPanelRepoDto[],
  checkout: boolean,
  from: string,
): string | undefined {
  if (name.trim().length === 0) return undefined;
  if (!isValidRefName(name)) return 'Not a valid branch name.';
  if (chosen.length === 0) return 'Choose a repository.';
  const taken = chosen.filter((r) => r.locals.some((b) => b.name === name)).map((r) => r.label);
  if (taken.length > 0) {
    return `${taken.join(', ')} already ${taken.length === 1 ? 'has' : 'have'} a branch named “${name}”.`;
  }
  if (!checkout && from === 'HEAD') {
    const empty = chosen.filter((r) => r.unborn).map((r) => r.label);
    if (empty.length > 0) return `${empty.join(', ')} has no commit yet: check the branch out instead.`;
  }
  return undefined;
}

export function fromText(from: string, chosen: readonly BranchPanelRepoDto[]): string {
  if (from !== 'HEAD') return from;
  const heads = [...new Set(chosen.map((r) => (r.detached ? 'HEAD' : (r.head ?? 'HEAD'))))];
  if (heads.length === 1) return heads[0]!;
  return 'each repository’s current branch';
}

/**
 * What the new branch will track, when there is something to say: only a remote
 * start point raises the question, and the answer is the rule the host runs.
 */
export function trackingNote(
  name: string,
  from: string,
  chosen: readonly BranchPanelRepoDto[],
): string | undefined {
  const remote = chosen.flatMap((r) => r.remotes).find((r) => r.name === from)?.remote;
  if (remote === undefined) return undefined;
  return newBranchTrackFlag(name.trim(), from, [remote]) === '--track'
    ? `It will track ${from}, the remote branch of the same name.`
    : `It will track nothing: your first push creates a branch of its own on ${remote}.`;
}
