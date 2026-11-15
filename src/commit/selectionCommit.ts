/**
 * HEAD plus a selection, committed through a scratch index (P11-T3). Moved
 * out of CommitService and kept vscode-free so it runs against real git in
 * unit tests (POST-QA: the merge commit).
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CancelToken, GitExecutor } from '../core/git/executor';
import { literalPathspecs } from '../core/git/pathspec';
import { chunked } from './changelists/moveChoices';
import { buildCommitArgs, type CommitOptions } from './commitArgs';

export interface SelectionPatch {
  relPath: string;
  /** Zero-context patch from HEAD to the ticked part of the file. */
  patch: string;
}

/** The scratch index's name in the git dir. */
export const SCRATCH_INDEX = 'gittree-partial-index';

/**
 * Commits HEAD plus the ticked files and parts of files, and nothing else.
 *
 * `git commit --only` cannot do this: it takes the **working tree** contents
 * of the named paths and disregards the index, so staging a partial patch
 * first has no effect — verified, not assumed. During a merge it refuses
 * outright ("cannot do a partial commit during a merge"). Instead the target
 * tree is assembled in a scratch index (`GIT_INDEX_FILE`): seed it from HEAD,
 * add the whole files, then `git apply --cached` each partial patch. `git
 * commit` against that index, with no pathspec, writes exactly the intended
 * tree while the working tree is never touched, so an interrupted commit can
 * never leave the user's file truncated to the ticked hunks. During a merge
 * that commit takes MERGE_HEAD as its second parent and ends the merge — what
 * IntelliJ makes of a merge whose included changes are committed.
 *
 * The scratch index then has to be reconciled with the real one: the real
 * index still holds pre-commit entries for the committed paths, which would
 * read as staged reversals against the new HEAD. `git reset -- <paths>` puts
 * exactly those entries back on HEAD and leaves the working tree alone —
 * which is the state `--only` would have produced.
 *
 * The scratch index lives in the git dir. GitDirWatcher ignores unknown names
 * there, so building it does not trigger a refresh storm.
 */
export async function commitSelection(
  git: GitExecutor,
  root: string,
  gitDir: string,
  wholeRelPaths: readonly string[],
  partials: readonly SelectionPatch[],
  message: string,
  options: CommitOptions,
  token?: CancelToken,
): Promise<void> {
  const indexFile = path.join(gitDir, SCRATCH_INDEX);
  const committed = [...wholeRelPaths, ...partials.map((p) => p.relPath)];
  const tok = token !== undefined ? { token } : {};
  const env = { GIT_INDEX_FILE: indexFile };
  // The scratch index never sees the real one's conflicts, so git's own
  // refusal to commit unmerged files cannot fire: asked of the real index.
  const unmerged = await git.exec(root, ['ls-files', '--unmerged', '-z'], { structured: true, ...tok });
  if (unmerged.stdout.length > 0) {
    throw new Error('Committing is not possible because you have unmerged files.');
  }
  await fs.rm(indexFile, { force: true });
  try {
    // HEAD, not the current index: the commit must contain HEAD plus the
    // ticked changes and nothing else that happens to be staged.
    await git.exec(root, ['read-tree', 'HEAD'], { env, ...tok });
    // `git add <path>` also records deletions, so a ticked deleted file needs
    // no separate branch here. Sliced: a merge can tick thousands of files.
    for (const slice of chunked(wholeRelPaths)) {
      await git.exec(root, ['add', '--', ...literalPathspecs(slice)], { env, ...tok });
    }
    for (const partial of partials) {
      await git.exec(root, ['apply', '--cached', '--unidiff-zero', '-'], { env, stdin: partial.patch, ...tok });
    }
    await git.exec(root, buildCommitArgs('staged', message, options), { env, ...tok });
  } finally {
    await fs.rm(indexFile, { force: true });
    await fs.rm(`${indexFile}.lock`, { force: true });
  }
  // Real index ← new HEAD for exactly the paths we committed.
  for (const slice of chunked(committed)) {
    await git.exec(root, ['reset', '-q', '--', ...literalPathspecs(slice)], { allowNonZeroExit: true, ...tok });
  }
}
