/**
 * Cherry-pick argv (P13-T4), vscode-free so the option matrix is unit-testable.
 * `-x` and `-m` were both unreachable before: the P5 sequencer hard-codes its
 * flags, and `-m <parent>` is the only way to cherry-pick a merge commit at all.
 */

export interface CherryPickOptions {
  /** Commits to replay, oldest first — the order git must be given them in. */
  readonly shas: readonly string[];
  /** `-x`: append "(cherry picked from commit …)" to the message. */
  readonly recordOrigin: boolean;
  /** `--no-commit`: stage the result without committing. */
  readonly noCommit: boolean;
  /**
   * `-m <parent>`: mainline parent number for a merge commit. 0 = not a merge
   * pick, which is the only correct value for an ordinary commit — git rejects
   * `-m` there.
   */
  readonly mainline: number;
}

export const EMPTY_CHERRY_PICK_OPTIONS: CherryPickOptions = {
  shas: [],
  recordOrigin: true,
  noCommit: false,
  mainline: 0,
};

export function validateCherryPickOptions(o: CherryPickOptions): string[] {
  const errors: string[] = [];
  if (o.shas.length === 0) errors.push('Choose at least one commit to cherry-pick.');
  if (o.mainline < 0 || !Number.isInteger(o.mainline)) {
    errors.push('The mainline parent must be a whole number.');
  }
  if (o.mainline > 0 && o.shas.length > 1) {
    errors.push('A mainline parent applies to one merge commit, not to a range.');
  }
  if (o.mainline > 0 && o.recordOrigin && o.noCommit) {
    // `-x` writes into the message git never gets to create.
    errors.push('“Record origin” has no effect without a commit.');
  }
  return errors;
}

export function buildCherryPickArgs(o: CherryPickOptions): string[] {
  const args = ['cherry-pick'];
  if (o.recordOrigin && !o.noCommit) args.push('-x');
  if (o.noCommit) args.push('--no-commit');
  if (o.mainline > 0) args.push('-m', String(o.mainline));
  args.push(...o.shas);
  return args;
}
