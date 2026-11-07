/**
 * Detection of an in-progress multi-step git operation from `.git` contents
 * (master §4). Mirrors git's own precedence: rebase → am → merge →
 * cherry-pick → revert → bare sequencer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type InProgressOpKind =
  | 'merge'
  | 'rebase-interactive'
  | 'rebase-apply'
  | 'cherry-pick'
  | 'revert';

export interface InProgressOp {
  kind: InProgressOpKind;
  /** 1-based current step (rebase msgnum / am next). */
  step?: number;
  /** Total steps (rebase end / am last). */
  total?: number;
  /** Branch being rebased, short name (rebase-merge/head-name). */
  headName?: string;
  /** Remaining sequencer todo entries (multi-commit cherry-pick/revert). */
  todoRemaining?: number;
}

/**
 * @param gitDir resolved real git dir (worktree `.git` files already followed).
 */
export function detectInProgressOp(gitDir: string): InProgressOp | undefined {
  const rebaseMerge = path.join(gitDir, 'rebase-merge');
  if (isDir(rebaseMerge)) {
    const op: InProgressOp = { kind: 'rebase-interactive' };
    const step = readIntFile(path.join(rebaseMerge, 'msgnum'));
    const total = readIntFile(path.join(rebaseMerge, 'end'));
    const headName = readTextFile(path.join(rebaseMerge, 'head-name'));
    if (step !== undefined) op.step = step;
    if (total !== undefined) op.total = total;
    if (headName !== undefined) op.headName = shortenRef(headName);
    return op;
  }

  const rebaseApply = path.join(gitDir, 'rebase-apply');
  if (isDir(rebaseApply)) {
    const op: InProgressOp = { kind: 'rebase-apply' };
    const step = readIntFile(path.join(rebaseApply, 'next'));
    const total = readIntFile(path.join(rebaseApply, 'last'));
    const headName = readTextFile(path.join(rebaseApply, 'head-name'));
    if (step !== undefined) op.step = step;
    if (total !== undefined) op.total = total;
    if (headName !== undefined) op.headName = shortenRef(headName);
    return op;
  }

  if (isFile(path.join(gitDir, 'MERGE_HEAD'))) {
    return { kind: 'merge' };
  }

  const todoRemaining = countSequencerTodo(gitDir);
  if (isFile(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
    const op: InProgressOp = { kind: 'cherry-pick' };
    if (todoRemaining !== undefined) op.todoRemaining = todoRemaining;
    return op;
  }
  if (isFile(path.join(gitDir, 'REVERT_HEAD'))) {
    const op: InProgressOp = { kind: 'revert' };
    if (todoRemaining !== undefined) op.todoRemaining = todoRemaining;
    return op;
  }

  // Sequencer alive between steps (e.g. conflict resolved, next pick pending).
  if (todoRemaining !== undefined) {
    const first = readTextFile(path.join(gitDir, 'sequencer', 'todo'))
      ?.split('\n')
      .find((l) => l.trim().length > 0);
    const kind: InProgressOpKind = first?.startsWith('revert') ? 'revert' : 'cherry-pick';
    return { kind, todoRemaining };
  }

  return undefined;
}

/**
 * True while a rebase is replaying commits (POST-QA F7) — not `git am`, which
 * shares `rebase-apply` but applies onto the user's own branch. During a
 * rebase git's sides are the other way round from the user's: "ours" (stage
 * 2, `--ours`) is the branch being rebased onto, "theirs" (stage 3) the
 * user's own commit. IntelliJ swaps them back for exactly this state
 * (`GitMergeUtil.isReverseRoot`: the repository is REBASING).
 */
export function isRebasing(gitDir: string): boolean {
  return isDir(path.join(gitDir, 'rebase-merge')) || isFile(path.join(gitDir, 'rebase-apply', 'rebasing'));
}

function countSequencerTodo(gitDir: string): number | undefined {
  const todo = readTextFile(path.join(gitDir, 'sequencer', 'todo'));
  if (todo === undefined) return undefined;
  return todo.split('\n').filter((l) => /^(pick|revert|p|edit)\b/.test(l.trim())).length;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readTextFile(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function readIntFile(p: string): number | undefined {
  const text = readTextFile(p);
  if (text === undefined) return undefined;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) ? n : undefined;
}

function shortenRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}
