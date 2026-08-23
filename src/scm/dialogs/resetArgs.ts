/**
 * Reset dialog argv (P13-T3), vscode-free so the mode matrix is unit-testable.
 *
 * `keep` is git's fourth mode and was missing from every GitTree surface before
 * P12-T7.6: it moves HEAD like `--hard` but **refuses** rather than discarding
 * local changes. The dialog offers it explicitly because "hard, but safe" is
 * what most users actually want.
 */

export type ResetMode = 'soft' | 'mixed' | 'hard' | 'keep';

export const RESET_MODES: ResetMode[] = ['soft', 'mixed', 'hard', 'keep'];

export interface ResetOptions {
  /** Ref or sha to reset the current branch to. */
  readonly ref: string;
  readonly mode: ResetMode;
}

export function validateResetOptions(o: ResetOptions): string[] {
  const errors: string[] = [];
  if (o.ref.trim().length === 0) errors.push('Enter a revision to reset to.');
  return errors;
}

export function buildResetArgs(o: ResetOptions): string[] {
  return ['reset', `--${o.mode}`, o.ref.trim()];
}

/** Modes that can destroy uncommitted work, and therefore need a P9 snapshot. */
export function resetNeedsSnapshot(mode: ResetMode): boolean {
  return mode === 'hard' || mode === 'keep';
}

/** Modes that require an explicit confirmation before running. */
export function resetNeedsConfirm(mode: ResetMode): boolean {
  // `keep` refuses instead of discarding, so it does not need the warning —
  // its whole point is that it cannot lose work.
  return mode === 'hard';
}

/**
 * The live "this will discard N local changes" line. `soft` touches neither
 * index nor worktree; `mixed` resets the index only, so staged work is undone
 * but nothing on disk is lost; `hard` discards everything dirty; `keep` will
 * refuse if anything conflicts, so it discards nothing.
 */
export function describeResetImpact(mode: ResetMode, dirtyCount: number, stagedCount: number): string {
  switch (mode) {
    case 'soft':
      return 'Moves the branch only. The index and working tree are untouched.';
    case 'mixed':
      return stagedCount === 0
        ? 'Moves the branch and resets the index. Nothing is currently staged.'
        : `Moves the branch and unstages ${stagedCount} staged change${stagedCount === 1 ? '' : 's'}. Files on disk are untouched.`;
    case 'hard':
      return dirtyCount === 0
        ? 'Moves the branch and discards uncommitted changes. The working tree is currently clean.'
        : `Moves the branch and DISCARDS ${dirtyCount} local change${dirtyCount === 1 ? '' : 's'}.`;
    case 'keep':
      return dirtyCount === 0
        ? 'Moves the branch, keeping local changes. The working tree is currently clean.'
        : `Moves the branch and keeps your ${dirtyCount} local change${dirtyCount === 1 ? '' : 's'} — git refuses the reset instead of discarding them.`;
  }
}
