/**
 * Conflict kinds and sides (P6-T1), the pure half of the conflict session:
 * vscode-free so the classification and the rebase swap (POST-QA F7) are
 * unit-tested.
 */
import type { StatusEntry } from '../core/git/parsers/statusV2';
import type { InProgressOpKind } from '../core/model/inProgressOp';

export type ConflictSource =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'revert'
  | 'stash-pop'
  | 'unshelve'
  | 'checkout-merge';

export type ConflictKind =
  | 'both-modified'
  | 'added-by-both'
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'both-deleted'
  | 'mode';

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
}

/** Pure classification from the porcelain-v2 conflict chars + stages. */
export function classifyConflict(entry: StatusEntry): ConflictKind {
  const xy = `${entry.x}${entry.y}`;
  switch (xy) {
    case 'DD':
      return 'both-deleted';
    case 'AA':
      return 'added-by-both';
    case 'DU':
      return 'deleted-by-us';
    case 'UD':
      return 'deleted-by-them';
    case 'AU':
      // Added by us, absent on their side (rename/delete divergence).
      return 'deleted-by-them';
    case 'UA':
      return 'deleted-by-us';
    default: {
      // UU: both modified — or a pure mode conflict when the contents agree
      // but the modes differ (e.g. 100644 vs 100755).
      const s = entry.stages;
      if (s && s.sha2 === s.sha3 && s.sha2 !== '' && s.mode2 !== s.mode3) return 'mode';
      return 'both-modified';
    }
  }
}

/** Kinds resolved via QuickPick instead of the tri-editor. */
export function isSpecialConflict(kind: ConflictKind): boolean {
  return kind !== 'both-modified' && kind !== 'added-by-both';
}

/**
 * A conflict kind seen from the user's side. git names "us" and "them" by its
 * own sides, which a rebase swaps (POST-QA F7): there "deleted by us" means
 * the branch being rebased onto deleted the file.
 */
export function userConflictKind(kind: ConflictKind, reversed: boolean): ConflictKind {
  if (!reversed) return kind;
  if (kind === 'deleted-by-us') return 'deleted-by-them';
  if (kind === 'deleted-by-them') return 'deleted-by-us';
  return kind;
}

/**
 * git's checkout flag for one of the user's sides: `--ours` for Yours,
 * except mid-rebase, where the user's own commit is git's `--theirs`.
 */
export function gitSideFlag(side: 'ours' | 'theirs', reversed: boolean): '--ours' | '--theirs' {
  const yours = side === 'ours';
  return yours !== reversed ? '--ours' : '--theirs';
}

/**
 * The commit behind one side of a conflict (POST-QA F7). Yours is HEAD, except
 * mid-rebase, where it is the user's commit being replayed (REBASE_HEAD) and
 * HEAD is the branch being rebased onto plus the commits already replayed.
 * Theirs is whatever is being merged in: MERGE_HEAD, CHERRY_PICK_HEAD,
 * REVERT_HEAD. Undefined for a side no commit stands for (unstash, unshelve).
 */
export function sideRef(
  side: 'left' | 'right',
  reversed: boolean,
  op: InProgressOpKind | undefined,
): string | undefined {
  if (reversed) return side === 'left' ? 'REBASE_HEAD' : 'HEAD';
  if (side === 'left') return 'HEAD';
  switch (op) {
    case 'merge':
      return 'MERGE_HEAD';
    case 'cherry-pick':
      return 'CHERRY_PICK_HEAD';
    case 'revert':
      return 'REVERT_HEAD';
    // `git am` (rebase-apply without "rebasing") applies a patch, no commit.
    case 'rebase-apply':
    case 'rebase-interactive':
    case undefined:
      return undefined;
  }
}
