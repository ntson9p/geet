/**
 * Rebase dialog argv (P13-T3), vscode-free so the option matrix is unit-testable.
 *
 * `--preserve-merges` is deliberately absent even though the phase plan lists it
 * alongside `--rebase-merges`: git removed it (deprecated in 2.22, deleted in
 * 2.36), so offering it would produce a command that simply fails on any modern
 * git. `--rebase-merges` is its replacement and is what the option exposes.
 */

export interface RebaseOptions {
  /** The ref to rebase onto — the "new base". */
  readonly onto: string;
  /**
   * Optional "from" ref. Present means `--onto <onto> <from>`: replay only the
   * commits after `from`, which is the transplant case IntelliJ exposes as
   * "Rebase a range".
   */
  readonly from: string;
  /** Hands off to the P5 interactive rebase webview instead of running argv. */
  readonly interactive: boolean;
  readonly rebaseMerges: boolean;
  readonly autostash: boolean;
  readonly noVerify: boolean;
  readonly keepEmpty: boolean;
}

export const EMPTY_REBASE_OPTIONS: RebaseOptions = {
  onto: '',
  from: '',
  interactive: false,
  rebaseMerges: false,
  autostash: false,
  noVerify: false,
  keepEmpty: false,
};

export function validateRebaseOptions(o: RebaseOptions): string[] {
  const errors: string[] = [];
  if (o.onto.trim().length === 0) errors.push('Choose a branch or revision to rebase onto.');
  if (o.from.trim().length > 0 && o.from.trim() === o.onto.trim()) {
    errors.push('“Onto” and “From” are the same revision — there is nothing to replay.');
  }
  return errors;
}

export function buildRebaseArgs(o: RebaseOptions): string[] {
  const args = ['rebase'];
  if (o.interactive) args.push('--interactive');
  if (o.rebaseMerges) args.push('--rebase-merges');
  if (o.autostash) args.push('--autostash');
  if (o.noVerify) args.push('--no-verify');
  if (o.keepEmpty) args.push('--keep-empty');
  const onto = o.onto.trim();
  const from = o.from.trim();
  if (from.length > 0) {
    // Transplant: replay `from..HEAD` onto `onto`.
    args.push('--onto', onto, from);
  } else {
    args.push(onto);
  }
  return args;
}
