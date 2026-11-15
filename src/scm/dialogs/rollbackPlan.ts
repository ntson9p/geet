/**
 * Rollback planning (P13-T3), vscode-free so the file classification is
 * unit-testable. Rollback is not one git command — it is a restore for tracked
 * changes plus, optionally, deleting the local copies of files that are new.
 *
 * IntelliJ's rollback is a *dialog with a file list*, not a silent action, and
 * `[x] Delete local copies of added files` is a real switch there: untick it and
 * a newly added file is unstaged but stays on disk.
 */
import { literalPathspecs } from '../../core/git/pathspec';

/** How rollback must treat one file — derived from its status, not its name. */
export type RollbackKind =
  /** Tracked in HEAD: restore index + worktree from HEAD. */
  | 'restore'
  /** Staged-new (`A`): unstage it; delete the file only if the box is ticked. */
  | 'added'
  /** Never tracked (`??`): delete the file only if the box is ticked. */
  | 'untracked';

export interface RollbackFile {
  readonly path: string;
  readonly kind: RollbackKind;
  /** Rename source — restoring a rename has to bring the original back too. */
  readonly origPath?: string;
}

export interface RollbackPlan {
  /** `git restore --source=HEAD --staged --worktree -- <paths>` */
  readonly restorePaths: string[];
  /** `git rm --cached -- <paths>` — staged-new files leaving the index. */
  readonly unstagePaths: string[];
  /** Files to remove from disk. */
  readonly deletePaths: string[];
}

/**
 * `deleteAddedLocalCopies` maps the dialog's checkbox: when off, added and
 * untracked files are left on disk (merely unstaged), which is exactly what
 * "delete local copies of added files" being unticked means.
 */
export function planRollback(
  files: readonly RollbackFile[],
  deleteAddedLocalCopies: boolean,
): RollbackPlan {
  const restorePaths: string[] = [];
  const unstagePaths: string[] = [];
  const deletePaths: string[] = [];
  for (const f of files) {
    switch (f.kind) {
      case 'restore':
        restorePaths.push(f.path);
        // A rename's source is a separate path in HEAD and must come back.
        if (f.origPath !== undefined && f.origPath !== f.path) restorePaths.push(f.origPath);
        break;
      case 'added':
        unstagePaths.push(f.path);
        if (deleteAddedLocalCopies) deletePaths.push(f.path);
        break;
      case 'untracked':
        if (deleteAddedLocalCopies) deletePaths.push(f.path);
        break;
    }
  }
  return {
    restorePaths: dedupe(restorePaths),
    unstagePaths: dedupe(unstagePaths),
    deletePaths: dedupe(deletePaths),
  };
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

/** True when the plan would do nothing at all — the dialog disables its action. */
export function isEmptyRollbackPlan(plan: RollbackPlan): boolean {
  return (
    plan.restorePaths.length === 0 &&
    plan.unstagePaths.length === 0 &&
    plan.deletePaths.length === 0
  );
}

/**
 * Rollback's several commands, in order: what the host runs and the dim "will
 * run" line shows. The paths go as literal pathspecs (POST-P14ck): rolling
 * back `[id].tsx` as a pattern also threw away a changed `i.tsx`'s changes.
 */
export function rollbackCommands(plan: RollbackPlan): string[][] {
  const out: string[][] = [];
  if (plan.restorePaths.length > 0) {
    out.push(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...literalPathspecs(plan.restorePaths)]);
  }
  if (plan.unstagePaths.length > 0) {
    out.push(['rm', '--cached', '-q', '--', ...literalPathspecs(plan.unstagePaths)]);
  }
  return out;
}

/** Status code → what rollback has to do with the file. */
export function rollbackKindOf(entry: {
  kind: string;
  x: string;
  y: string;
}): RollbackKind {
  if (entry.kind === 'untracked') return 'untracked';
  // Staged addition: nothing in HEAD to restore from.
  if (entry.x === 'A') return 'added';
  return 'restore';
}
