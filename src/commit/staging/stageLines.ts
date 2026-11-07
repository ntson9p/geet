/**
 * Line-level staging against the index as it is right now (POST-QA F1).
 *
 * Every hunk and range action — the change popup's Stage, the diff editor's
 * `Stage hunk ≫` lens, Stage/Unstage Selected Ranges — comes through here and
 * runs inside its mutate task, so the index it reads is the index it patches:
 * nothing can stage in between. The changes are diffed afresh against that
 * index and the caller's `pick` chooses among them; a change measured a moment
 * ago, or against HEAD, is matched onto them by `correspondingChanges`.
 *
 * The working-tree text goes through `toBlobEol` first, so a CRLF checkout of
 * an LF blob stages LF lines — what `git add` would store — instead of
 * smuggling `\r` into the index.
 *
 * vscode-free, so it is unit-tested against real git.
 */
import type { CancelToken, GitExecutor } from '../../core/git/executor';
import { toBlobEol } from '../../core/patch/eol';
import { computeLineChanges } from '../../core/patch/lineDiff';
import { buildPatch, invertChanges, type LineChange } from '../../core/patch/patchBuilder';

/** Changes whose modified-side lines intersect any selection (0-based editor lines). */
export function selectChanges(
  changes: readonly LineChange[],
  selections: ReadonlyArray<{ startLine: number; endLine: number }>,
): LineChange[] {
  return changes.filter((c) => {
    // Deletions anchor at the modified line after which content vanished.
    const start = c.modifiedStartLineNumber;
    const end = c.modifiedEndLineNumber === 0 ? c.modifiedStartLineNumber + 1 : c.modifiedEndLineNumber;
    return selections.some((s) => s.startLine + 1 <= end && s.endLine + 1 >= start);
  });
}

/** `notInIndex`: no stage-0 entry — untracked, or in the middle of a conflict. */
export type StageLinesOutcome = 'done' | 'nothing' | 'notInIndex';

export type PickChanges = (fresh: readonly LineChange[]) => readonly LineChange[];

async function show(
  git: GitExecutor,
  root: string,
  spec: string,
  token: CancelToken | undefined,
): Promise<string | undefined> {
  const result = await git.exec(root, ['show', spec], {
    structured: true,
    allowNonZeroExit: true,
    ...(token ? { token } : {}),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

async function applyToIndex(
  git: GitExecutor,
  root: string,
  patch: string,
  token: CancelToken | undefined,
): Promise<void> {
  await git.exec(root, ['apply', '--cached', '--unidiff-zero', '-'], {
    stdin: patch,
    ...(token ? { token } : {}),
  });
}

/**
 * Stages the working-tree changes `pick` chooses from the index → working-tree
 * diff of `rel`. `worktreeText` is the file as the user sees it (a saved
 * document's text).
 */
export async function stageWorktreeLines(
  git: GitExecutor,
  root: string,
  rel: string,
  worktreeText: string,
  pick: PickChanges,
  token?: CancelToken,
): Promise<StageLinesOutcome> {
  const indexText = await show(git, root, `:0:${rel}`, token);
  if (indexText === undefined) return 'notInIndex';
  const modifiedText = toBlobEol(indexText, worktreeText).text;
  const picked = pick(computeLineChanges(indexText, modifiedText));
  if (picked.length === 0) return 'nothing';
  const patch = buildPatch({ relPath: rel, originalText: indexText, modifiedText, changes: [...picked] });
  await applyToIndex(git, root, patch, token);
  return 'done';
}

/**
 * Takes the staged changes `pick` chooses (from the HEAD → index diff, so in
 * index line numbers) back out of the index. A file that HEAD does not have
 * yet counts as empty there.
 */
export async function unstageIndexLines(
  git: GitExecutor,
  root: string,
  rel: string,
  pick: PickChanges,
  token?: CancelToken,
): Promise<StageLinesOutcome> {
  const indexText = await show(git, root, `:0:${rel}`, token);
  if (indexText === undefined) return 'notInIndex';
  const headText = (await show(git, root, `HEAD:${rel}`, token)) ?? '';
  const picked = pick(computeLineChanges(headText, indexText));
  if (picked.length === 0) return 'nothing';
  const patch = buildPatch({
    relPath: rel,
    originalText: indexText,
    modifiedText: headText,
    changes: invertChanges(picked),
  });
  await applyToIndex(git, root, patch, token);
  return 'done';
}
