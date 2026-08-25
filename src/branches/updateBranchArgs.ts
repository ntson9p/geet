/**
 * `Update` on a branch row — IntelliJ's branch-level Update — kept vscode-free
 * so the command matrix is unit-testable the way `scm/dialogs/updateArgs.ts`
 * is.
 *
 * Only the harder half lives here. The checked-out branch is Update Project's
 * job already (same fetch, same merge/rebase choice), so `BranchOps` delegates
 * to it rather than growing a second implementation of one behaviour. What is
 * left is a branch git cannot integrate because it is not checked out, and
 * there IntelliJ moves the ref by fast-forward only. `git fetch` is what
 * expresses that: a refspec without a leading `+` is refused unless the update
 * really is a fast-forward, so the safety property belongs to git rather than
 * to a check of ours that could drift out of step with the ref it guards.
 */

/**
 * `git fetch . origin/x:x` — fast-forward a ref we are not standing on, from
 * the remote-tracking ref a preceding fetch has already moved. `.` is the
 * repository itself, which keeps this step local: it cannot fail for network
 * reasons, and the tracking refs stay whatever the real fetch made them.
 */
export function buildFastForwardArgs(upstreamRef: string, localBranch: string): string[] {
  return ['fetch', '.', `${upstreamRef}:${localBranch}`];
}

/**
 * `ahead<TAB>behind` for one branch against its upstream in a single call —
 * the snapshot's own counts are not usable here because they predate the fetch
 * this update just ran.
 */
export function buildAheadBehindArgs(branch: string, upstreamRef: string): string[] {
  return ['rev-list', '--left-right', '--count', `${branch}...${upstreamRef}`];
}

/** Left is the branch's own commits, right is the upstream's — git's order. */
export function parseAheadBehind(stdout: string): { ahead: number; behind: number } {
  const [left, right] = stdout.trim().split(/\s+/u);
  return { ahead: Number(left) || 0, behind: Number(right) || 0 };
}
