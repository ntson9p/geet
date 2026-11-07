/**
 * Keeping the user's staged changes across an operation that resets the index
 * (POST-QA F3/F4).
 *
 * `git rebase --autostash` re-applies its stash without `--index`, and
 * `git reset --keep` rebuilds the index from the target commit: both turn
 * every staged change into an unstaged one, and a staged new file into an
 * untracked one. The content survives, the staging does not — and staging is
 * the user's work too (IntelliJ pops its own stash with `--index` whenever the
 * staging area is on, for the same reason).
 *
 * `readStaged` records the staged entries (index against HEAD) before such an
 * operation; `restoreStaged` writes them back afterwards for every path the
 * operation itself left alone. A path the operation changed in HEAD keeps
 * whatever the operation left in the index: its old staged blob was cut from
 * the old HEAD and would re-stage what the operation just removed.
 *
 * vscode-free; unit-tested against real git.
 */
import type { CancelToken, GitExecutor } from '../git/executor';

export interface StagedEntry {
  readonly path: string;
  /** HEAD's side: `000000` when the path is new in the index. */
  readonly headMode: string;
  /** The index's side: `000000` when the path is deleted in the index. */
  readonly indexMode: string;
  readonly indexSha: string;
}

export interface StagedSnapshot {
  readonly head: string;
  readonly entries: readonly StagedEntry[];
}

const tokenOpt = (token: CancelToken | undefined): { token?: CancelToken } => (token ? { token } : {});

/** Parses `git diff-index --cached -z --no-renames <rev>` (raw format). */
export function parseDiffIndexRaw(stdout: string): StagedEntry[] {
  const parts = stdout.split('\0');
  const entries: StagedEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i] as string;
    const path = parts[i + 1] as string;
    if (!meta.startsWith(':') || path.length === 0) continue;
    const [headMode, indexMode, , indexSha] = meta.slice(1).split(' ');
    if (headMode === undefined || indexMode === undefined || indexSha === undefined) continue;
    entries.push({ path, headMode, indexMode, indexSha });
  }
  return entries;
}

/**
 * The staged entries and the HEAD they are staged against, or undefined when
 * there is nothing to keep (no commit yet, nothing staged) or nothing can be
 * kept (unmerged entries: the operation will refuse on its own).
 */
export async function readStaged(
  git: GitExecutor,
  root: string,
  token?: CancelToken,
): Promise<StagedSnapshot | undefined> {
  const head = await git.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    structured: true,
    allowNonZeroExit: true,
    ...tokenOpt(token),
  });
  if (head.exitCode !== 0) return undefined;
  const unmerged = await git.exec(root, ['ls-files', '--unmerged', '-z'], { structured: true, ...tokenOpt(token) });
  if (unmerged.stdout.length > 0) return undefined;
  const diff = await git.exec(root, ['diff-index', '--cached', '-z', '--no-renames', 'HEAD'], {
    structured: true,
    ...tokenOpt(token),
  });
  const entries = parseDiffIndexRaw(diff.stdout);
  return entries.length > 0 ? { head: head.stdout.trim(), entries } : undefined;
}

export interface RestoreResult {
  /** Staged again, exactly as before. */
  readonly restored: readonly string[];
  /** Changed by the operation itself: left as the operation left them. */
  readonly skipped: readonly string[];
}

/**
 * Writes `snapshot`'s entries back into the index for every path the commits
 * `snapshot.head` and the current HEAD agree on.
 */
export async function restoreStaged(
  git: GitExecutor,
  root: string,
  snapshot: StagedSnapshot,
  token?: CancelToken,
): Promise<RestoreResult> {
  const now = await git.exec(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], {
    structured: true,
    allowNonZeroExit: true,
    ...tokenOpt(token),
  });
  if (now.exitCode !== 0) return { restored: [], skipped: snapshot.entries.map((e) => e.path) };
  const touched = new Set<string>();
  if (now.stdout.trim() !== snapshot.head) {
    const changed = await git.exec(
      root,
      ['diff-tree', '-r', '-z', '--no-renames', '--name-only', snapshot.head, now.stdout.trim()],
      { structured: true, ...tokenOpt(token) },
    );
    for (const p of changed.stdout.split('\0')) if (p.length > 0) touched.add(p);
  }
  const restored: string[] = [];
  const skipped: string[] = [];
  let input = '';
  for (const e of snapshot.entries) {
    if (touched.has(e.path)) {
      skipped.push(e.path);
      continue;
    }
    restored.push(e.path);
    // Mode 0 removes the entry: a staged deletion.
    input += /^0+$/u.test(e.indexMode)
      ? `0 ${'0'.repeat(e.indexSha.length)}\t${e.path}\0`
      : `${e.indexMode} ${e.indexSha}\t${e.path}\0`;
  }
  if (input.length > 0) {
    await git.exec(root, ['update-index', '-z', '--index-info'], { stdin: input, ...tokenOpt(token) });
  }
  return { restored, skipped };
}

/**
 * `git reset --keep <target>` that keeps the staging: refused by git, with
 * nothing changed, when a path the reset must move has local changes.
 */
export async function resetKeepStaged(
  git: GitExecutor,
  root: string,
  target: string,
  token?: CancelToken,
): Promise<RestoreResult> {
  const snapshot = await readStaged(git, root, token);
  await git.exec(root, ['reset', '--keep', target], tokenOpt(token));
  return snapshot ? restoreStaged(git, root, snapshot, token) : { restored: [], skipped: [] };
}
