/**
 * What a commit would hold, read from git as diffs (POST-P14cj, Generate
 * Commit Message): the ticked files, the ticked part of a file committed in
 * part, the new files, and with Amend the last commit's own changes, since the
 * message is then the message of both.
 *
 * Read-only. The commit itself builds its tree in a scratch index
 * (`selectionCommit.ts`); doing that here would write a blob for every ticked
 * file each time a message is asked for. Instead: `git diff` against HEAD for
 * the files committed whole, the patch a partial commit would apply for the
 * others, and the file's own text for one git does not track yet.
 *
 * Free of `vscode`, so it runs against real git in unit tests.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CancelToken, GitExecutor } from '../../core/git/executor';
import { chunked } from '../changelists/moveChoices';
import { DEFAULT_DIFF_LIMITS, DiffReader, readNewFile, type ChangeDiff, type DiffLimits } from './changeDiff';

export interface CollectRequest {
  /** `changelists`: what is ticked, from the working tree. `staged`: the index. */
  readonly mode: 'changelists' | 'staged';
  /** The commit under HEAD is rewritten, so its own changes are described too. */
  readonly amend: boolean;
  /** No commit yet: everything is new, and there is nothing to amend. */
  readonly unborn: boolean;
  /** `changelists`: the ticked files committed whole, tracked or not. */
  readonly wholePaths: readonly string[];
  /** `changelists`: those of `wholePaths` git does not track yet. */
  readonly untrackedPaths: readonly string[];
  /** `changelists`: files with only some changes ticked, as the patch a commit applies. */
  readonly partials: readonly { readonly relPath: string; readonly patch: string }[];
}

/** A new file larger than this is named, not read. */
export const MAX_NEW_FILE_BYTES = 512 * 1024;

/** Thrown when `token` was cancelled: a result read in part must never be taken for the whole. */
export class CollectCancelled extends Error {
  constructor() {
    super('Reading the changes was cancelled');
    this.name = 'CollectCancelled';
  }
}

const slash = (p: string): string => p.replace(/\\/g, '/');

/**
 * `--literal-pathspecs`: a ticked `[id].tsx` is that file, not a pattern.
 * `--no-ext-diff`: the text git writes, not a diff tool's window.
 */
const diffArgs = (rest: readonly string[]): string[] => [
  '--literal-pathspecs',
  'diff',
  '--no-color',
  '--no-ext-diff',
  '-M',
  '--unified=3',
  ...rest,
];

/** What the changes are compared against: HEAD, its parent when amending, nothing in a repository without a commit. */
async function baseOf(
  git: GitExecutor,
  root: string,
  request: CollectRequest,
  token: CancelToken | undefined,
): Promise<{ base: string; amending: boolean }> {
  const tok = token !== undefined ? { token } : {};
  const emptyTree = async (): Promise<string> => {
    // The tree with nothing in it, in this repository's hash (SHA-1 or SHA-256).
    const r = await git.exec(root, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '', structured: true, ...tok });
    return r.stdout.trim();
  };
  if (request.unborn) return { base: await emptyTree(), amending: false };
  if (!request.amend) return { base: 'HEAD', amending: false };
  const parent = await git.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^'], {
    structured: true,
    allowNonZeroExit: true,
    ...tok,
  });
  // The first commit has no parent: amended, it is compared against nothing.
  return { base: parent.exitCode === 0 ? 'HEAD^' : await emptyTree(), amending: true };
}

/**
 * The changes of `request`, file by file, each diff cut to `limits`. Throws
 * `CollectCancelled` when `token` fires, so a queue can run it again whole.
 */
export async function collectChanges(
  git: GitExecutor,
  root: string,
  request: CollectRequest,
  limits: DiffLimits = DEFAULT_DIFF_LIMITS,
  token?: CancelToken,
): Promise<ChangeDiff[]> {
  try {
    return await collect(git, root, request, limits, token);
  } catch (err) {
    // Whatever a git run says of being cancelled, the caller hears one thing.
    if (token?.isCancellationRequested === true) throw new CollectCancelled();
    throw err;
  }
}

async function collect(
  git: GitExecutor,
  root: string,
  request: CollectRequest,
  limits: DiffLimits,
  token: CancelToken | undefined,
): Promise<ChangeDiff[]> {
  const reader = new DiffReader(limits);
  const check = (): void => {
    if (token?.isCancellationRequested === true) throw new CollectCancelled();
  };
  check();
  const stream = async (rest: readonly string[]): Promise<void> => {
    check();
    const run = git.stream(root, diffArgs(rest), (line) => reader.push(line), {
      delimiter: '\n',
      // A background read never takes the index lock a commit may be waiting for.
      noOptionalLocks: true,
      ...(token !== undefined ? { token } : {}),
    });
    await run.done;
    // A cancelled stream ends quietly, with whatever it had written.
    check();
  };

  const { base, amending } = await baseOf(git, root, request, token);
  check();

  if (request.mode === 'staged') {
    // The index against the base: with Amend, the last commit's changes and the staged ones together.
    await stream(['--cached', base]);
    return reader.finish();
  }

  const untracked = new Set(request.untrackedPaths.map(slash));
  const tracked = request.wholePaths.map(slash).filter((p) => !untracked.has(p));
  for (const slice of chunked(tracked)) await stream([base, '--', ...slice]);

  reader.mark({ partial: true });
  for (const partial of request.partials) {
    // The patch ends in a line break, which is not one more line.
    for (const line of partial.patch.replace(/\n$/u, '').split('\n')) reader.push(line);
  }
  reader.mark({});

  for (const rel of untracked) {
    check();
    let content: string | undefined;
    try {
      const abs = path.join(root, rel);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      if (stat.size <= MAX_NEW_FILE_BYTES) content = await fs.readFile(abs, 'utf8');
    } catch {
      continue; // gone since it was ticked
    }
    readNewFile(reader, rel, content);
  }

  if (amending) {
    // What the last commit changed and no ticked file covers: in the amended
    // commit all the same. A file committed in part is listed here as well,
    // since its patch above starts from HEAD.
    check();
    const names = await git.exec(root, ['diff', '--name-only', '-z', '--no-renames', base, 'HEAD'], {
      structured: true,
      noOptionalLocks: true,
      ...(token !== undefined ? { token } : {}),
    });
    check();
    const covered = new Set([...tracked, ...untracked]);
    const others = names.stdout.split('\0').filter((p) => p.length > 0 && !covered.has(p));
    reader.mark({ amended: true });
    for (const slice of chunked(others)) await stream([base, 'HEAD', '--', ...slice]);
    reader.mark({});
  }
  return reader.finish();
}
