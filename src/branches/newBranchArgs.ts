/**
 * How a new branch is made, and what it tracks. vscode-free: the host runs these
 * argv, the New Worktree dialog previews them, and the New Branch form says what
 * they will do, so all three give the same answer.
 *
 * **A new branch tracks nothing, unless it takes the remote branch's own name.**
 *
 * Left to itself git decides: `git checkout -b mine origin/develop` makes `mine`
 * track `origin/develop` (`branch.autoSetupMerge`, on by default; set to `inherit`
 * or `always` it does the same from a local branch). The Push dialog pushes a
 * branch to what it tracks, as IntelliJ's does, so the first push of `mine` created
 * nothing on the remote and put its commits on `develop`, someone's existing branch.
 *
 * So the flag is always spelled out, whatever the user's git config says. Starting
 * from `origin/develop` under the name `develop` still tracks it: that is what
 * `Checkout` on a remote branch does, and a push there goes where the name says.
 * It is the rule of git's own `branch.autoSetupMerge=simple`.
 */
import type { RefInfo } from '../core/model/refs';

export type TrackFlag = '--track' | '--no-track';

export function newBranchTrackFlag(
  name: string,
  startPoint: string,
  remotes: Iterable<string>,
): TrackFlag {
  for (const remote of remotes) {
    if (startPoint === `${remote}/${name}`) return '--track';
  }
  return '--no-track';
}

/** The remotes the refs name. A remote with no branches fetched yet has nothing to start from. */
export function remoteNamesOf(refs: readonly Pick<RefInfo, 'type' | 'remote'>[]): string[] {
  const names = new Set<string>();
  for (const ref of refs) {
    if (ref.type === 'remote' && ref.remote !== undefined) names.add(ref.remote);
  }
  return [...names];
}

export interface NewBranchArgsOptions {
  readonly name: string;
  /** `HEAD`, or the ref it starts from. */
  readonly startPoint: string;
  readonly checkout: boolean;
  /** The repository has no commit yet. */
  readonly unborn?: boolean;
  readonly refs: readonly Pick<RefInfo, 'type' | 'remote'>[];
}

/** The argv that makes the branch. */
export function buildNewBranchArgs(o: NewBranchArgsOptions): string[] {
  // An unborn HEAD has no commit to start from; `checkout -b` with no start point
  // is how git names the branch-to-be, and there is nothing yet to track.
  if (o.checkout && o.startPoint === 'HEAD' && o.unborn === true) return ['checkout', '-b', o.name];
  const track = newBranchTrackFlag(o.name, o.startPoint, remoteNamesOf(o.refs));
  return o.checkout
    ? ['checkout', '-b', o.name, track, o.startPoint]
    : ['branch', track, '--', o.name, o.startPoint];
}
