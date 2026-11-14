/**
 * Which repository a commit across several repositories amends, or lets speak
 * when at most one has anything ticked (POST-P14by). Pure and vscode-free, so
 * every case is unit-tested: `runCommitAcross` can be narrowed to the
 * repositories asked for (the Repositories panel's `⋯` with some of them in
 * view), and the repository the message was typed against, whose Amend box the
 * Commit window shows, may lie outside them.
 */

/**
 * The repository a commit across several amends: the message's own when it is
 * being committed and its Amend is ticked, else the first being committed whose
 * Amend is. Outside the repositories asked for, the message's Amend amends
 * nothing: it would rewrite a repository nobody asked to commit.
 */
export function amendTarget<R>(
  messageRepo: R,
  participants: readonly R[],
  inScope: (repo: R) => boolean,
  isAmend: (repo: R) => boolean,
): R | undefined {
  if (inScope(messageRepo) && isAmend(messageRepo)) return messageRepo;
  return participants.find((repo) => isAmend(repo));
}

/**
 * The repository committed on its own when at most one has anything ticked:
 * that one. With none, the one whose own diagnostics speak (*No checked files
 * to commit*, the staging area's commit-all offer): the message's when it is
 * asked for, else the first asked for whose Amend is ticked, else the first
 * asked for, never one outside them.
 *
 * POST-P14ce: the one with Amend ticked, because the Commit window narrowed to
 * some repositories shows the Amend of the first it lists while the message
 * stays the editor's repository's; an amend of that one's message alone must
 * reach it, wherever it is among the repositories asked for.
 */
export function singleCommitRepo<R>(
  messageRepo: R,
  participants: readonly R[],
  candidates: readonly R[],
  inScope: (repo: R) => boolean,
  isAmend: (repo: R) => boolean = () => false,
): R {
  return (
    participants[0] ??
    (inScope(messageRepo) ? messageRepo : (candidates.find((repo) => isAmend(repo)) ?? candidates[0] ?? messageRepo))
  );
}

/** One repository a generated commit message describes, and whether its last commit is rewritten. */
export interface GenerationTarget<R> {
  readonly repo: R;
  readonly amend: boolean;
}

/**
 * The repositories a generated commit message describes (POST-P14cj): the ones
 * a Commit pressed now would commit, decided as `runCommitAcross` decides it,
 * so the message is written for the commit it will be used on.
 *
 * - At most one repository has anything ticked: that one (`singleCommitRepo`),
 *   amended if its own Amend is ticked.
 * - Several have, and one is to be amended (`amendTarget`): that one alone,
 *   since Amend rewrites one repository and leaves the others uncommitted.
 * - Several have and none is amended: all of them, under the one message.
 */
export function generationScope<R>(
  messageRepo: R,
  participants: readonly R[],
  candidates: readonly R[],
  inScope: (repo: R) => boolean,
  isAmend: (repo: R) => boolean,
): GenerationTarget<R>[] {
  if (participants.length <= 1) {
    const repo = singleCommitRepo(messageRepo, participants, candidates, inScope, isAmend);
    return [{ repo, amend: isAmend(repo) }];
  }
  const amending = amendTarget(messageRepo, participants, inScope, isAmend);
  if (amending !== undefined) return [{ repo: amending, amend: true }];
  return participants.map((repo) => ({ repo, amend: false }));
}
