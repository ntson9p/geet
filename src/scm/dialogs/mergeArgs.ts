/**
 * Merge dialog argv (P13-T3), vscode-free so the option matrix is unit-testable
 * and the dialog previews exactly what runs. S4 is the biggest power-user gap in
 * the gap analysis precisely because these flags were unreachable before.
 */

export type MergeStrategy = '' | 'ort' | 'recursive' | 'resolve' | 'octopus' | 'ours' | 'subtree';
export type MergeStrategyOption = '' | 'ours' | 'theirs' | 'ignore-space-change' | 'patience';

export interface MergeOptions {
  /** Branch, tag or sha being merged in. */
  readonly ref: string;
  readonly noFf: boolean;
  readonly ffOnly: boolean;
  readonly squash: boolean;
  readonly noCommit: boolean;
  readonly allowUnrelatedHistories: boolean;
  readonly strategy: MergeStrategy;
  readonly strategyOption: MergeStrategyOption;
  /** Custom merge commit message; empty means git's default. */
  readonly message: string;
}

export const EMPTY_MERGE_OPTIONS: MergeOptions = {
  ref: '',
  noFf: false,
  ffOnly: false,
  squash: false,
  noCommit: false,
  allowUnrelatedHistories: false,
  strategy: '',
  strategyOption: '',
  message: '',
};

/**
 * Combinations git itself refuses, or that would silently drop user input.
 * Returned as messages so the dialog can disable the action *and say why* —
 * "the option is greyed out" without a reason is its own usability bug.
 */
export function validateMergeOptions(o: MergeOptions): string[] {
  const errors: string[] = [];
  if (o.ref.trim().length === 0) errors.push('Choose a branch or revision to merge.');
  if (o.noFf && o.ffOnly) {
    errors.push('“Create a merge commit” and “Fast-forward only” contradict each other.');
  }
  if (o.squash && o.noFf) errors.push('git refuses --squash together with --no-ff.');
  if (o.squash && o.message.trim().length > 0) {
    errors.push('A squash merge creates no commit, so the message would be dropped.');
  }
  return errors;
}

export function buildMergeArgs(o: MergeOptions): string[] {
  const args = ['merge'];
  if (o.noFf) args.push('--no-ff');
  if (o.ffOnly) args.push('--ff-only');
  if (o.squash) args.push('--squash');
  if (o.noCommit) args.push('--no-commit');
  if (o.allowUnrelatedHistories) args.push('--allow-unrelated-histories');
  if (o.strategy.length > 0) args.push('--strategy', o.strategy);
  if (o.strategyOption.length > 0) args.push('--strategy-option', o.strategyOption);
  if (o.message.trim().length > 0 && !o.squash) args.push('-m', o.message.trim());
  // `--` keeps a branch named like an option (or like a path) unambiguous.
  args.push('--', o.ref);
  return args;
}
