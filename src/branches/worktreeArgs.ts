/**
 * Worktree argv (P13-T6), vscode-free so the option matrix is unit-testable.
 * §3.10: GitTree resolved worktree paths internally but had no create/remove
 * commands at all — these are the write half.
 */

import { newBranchTrackFlag } from './newBranchArgs';

export type WorktreeBranchMode = 'existing' | 'new' | 'detach';

export interface NewWorktreeOptions {
  /** Absolute destination directory. */
  readonly path: string;
  readonly mode: WorktreeBranchMode;
  /** `existing`: the branch to check out. `new`: the start point. `detach`: the commit. */
  readonly ref: string;
  /** `new` only: the branch to create. */
  readonly newBranch: string;
  /** Create the worktree without checking files out (`--no-checkout`). */
  readonly noCheckout: boolean;
  /** Allow a branch already checked out elsewhere (`--force`). */
  readonly force: boolean;
}

export const EMPTY_NEW_WORKTREE_OPTIONS: NewWorktreeOptions = {
  path: '',
  mode: 'existing',
  ref: '',
  newBranch: '',
  noCheckout: false,
  force: false,
};

export function validateNewWorktree(o: NewWorktreeOptions): string[] {
  const errors: string[] = [];
  if (o.path.trim().length === 0) errors.push('Choose a directory for the worktree.');
  if (o.mode === 'new') {
    if (o.newBranch.trim().length === 0) errors.push('Enter a name for the new branch.');
    else if (/[\s~^:?*[\\]/u.test(o.newBranch.trim())) {
      errors.push('A branch name cannot contain spaces or ~ ^ : ? * [ \\.');
    }
  }
  if (o.mode !== 'new' && o.ref.trim().length === 0) {
    errors.push(o.mode === 'detach' ? 'Enter a revision to detach at.' : 'Choose a branch.');
  }
  return errors;
}

/**
 * `remotes` names the repository's remotes, for what a new branch tracks: nothing,
 * unless it takes the name of the remote branch it starts from (`newBranchArgs.ts`
 * says why). The dialog previews this argv, so it passes the same list.
 */
export function buildWorktreeAddArgs(
  o: NewWorktreeOptions,
  remotes: readonly string[] = [],
): string[] {
  const args = ['worktree', 'add'];
  if (o.force) args.push('--force');
  if (o.noCheckout) args.push('--no-checkout');
  const ref = o.ref.trim();
  if (o.mode === 'new') {
    const name = o.newBranch.trim();
    args.push(newBranchTrackFlag(name, ref, remotes), '-b', name);
  } else if (o.mode === 'detach') args.push('--detach');
  args.push(o.path.trim());
  // `new` may start from nothing (git uses HEAD); the other modes need the ref.
  if (ref.length > 0) args.push(ref);
  return args;
}

export function buildWorktreeListArgs(): string[] {
  return ['worktree', 'list', '--porcelain'];
}

export function buildWorktreeRemoveArgs(path: string, force: boolean): string[] {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  return args;
}

export function buildWorktreeLockArgs(path: string, reason: string): string[] {
  const args = ['worktree', 'lock'];
  if (reason.trim().length > 0) args.push('--reason', reason.trim());
  args.push(path);
  return args;
}

export function buildWorktreeUnlockArgs(path: string): string[] {
  return ['worktree', 'unlock', path];
}

export function buildWorktreePruneArgs(): string[] {
  return ['worktree', 'prune'];
}

/**
 * IntelliJ's default location for a new worktree: a sibling of the repository
 * named `<repo>-<branch>`, with the branch's slashes flattened so the result is
 * one directory rather than a nested tree.
 */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const normalized = repoRoot.replace(/[\\/]+$/u, '');
  const sep = normalized.includes('\\') && !normalized.includes('/') ? '\\' : '/';
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  const parent = cut > 0 ? normalized.slice(0, cut) : normalized;
  const name = cut >= 0 ? normalized.slice(cut + 1) : normalized;
  const suffix = branch.trim().replace(/[\\/]+/gu, '-');
  return `${parent}${sep}${name}${suffix.length > 0 ? `-${suffix}` : '-worktree'}`;
}
