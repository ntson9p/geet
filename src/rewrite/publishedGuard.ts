/**
 * Published-history guard (shared helper named in P5-T3; used by T2's dialog
 * entry, T3 undo/drop and P3-T5 amend): a commit is "published" when the
 * current branch has an upstream and the commit is already reachable from it
 * — rewriting it would rewrite history others may have.
 */
import type { RepoHandle } from '../core/core';

/** Upstream ref of the current branch, or undefined when none is set. */
export async function upstreamRef(repo: RepoHandle): Promise<string | undefined> {
  const result = await repo.queue.enqueue({
    label: 'published guard (upstream)',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  if (result.exitCode !== 0) return undefined;
  const ref = result.stdout.trim();
  return ref.length > 0 ? ref : undefined;
}

/** True when `sha` is an ancestor of the current branch's upstream. */
export async function isPublished(repo: RepoHandle, sha: string): Promise<boolean> {
  const upstream = await upstreamRef(repo);
  if (upstream === undefined) return false;
  const result = await repo.queue.enqueue({
    label: 'published guard (ancestry)',
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['merge-base', '--is-ancestor', sha, upstream], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0;
}
