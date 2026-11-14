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
