/**
 * Stash / Unstash argv (P13-T4), vscode-free so the option matrix is
 * unit-testable. The dialog's preview and its run build through the same
 * function; the P7 QuickPick path (`StashService.push`) has its own.
 */
import { literalPathspecs } from '../../core/git/pathspec';

export interface StashPushArgsOptions {
  readonly message: string;
  /** `--keep-index`: stash everything but leave the index applied on disk. */
  readonly keepIndex: boolean;
  /** `--include-untracked`. Ignored when `all` or `staged` is set. */
  readonly includeUntracked: boolean;
  /** `--all`: untracked *and* ignored files. Supersedes `includeUntracked`. */
  readonly all: boolean;
  /** `--staged` (git ≥ 2.35). Mutually exclusive with the two above. */
  readonly staged: boolean;
  /** Pathspec subset for "stash selected files". */
  readonly paths: readonly string[];
}

export const EMPTY_STASH_PUSH_OPTIONS: StashPushArgsOptions = {
  message: '',
  keepIndex: false,
  includeUntracked: true,
  all: false,
  staged: false,
  paths: [],
};

export function validateStashPushOptions(o: StashPushArgsOptions): string[] {
  const errors: string[] = [];
  if (o.staged && (o.all || o.includeUntracked)) {
    errors.push('“Only staged changes” cannot be combined with untracked or ignored files.');
  }
  if (o.staged && o.keepIndex) {
    errors.push('“Only staged changes” and “Keep index” contradict each other.');
  }
  return errors;
}

export function buildStashPushArgs(o: StashPushArgsOptions): string[] {
  const args = ['stash', 'push'];
  if (o.staged) {
    args.push('--staged');
  } else if (o.all) {
    // `--all` already covers untracked; passing both is redundant noise.
    args.push('--all');
  } else if (o.includeUntracked) {
    args.push('--include-untracked');
  }
  if (o.keepIndex && !o.staged) args.push('--keep-index');
  if (o.message.trim().length > 0) args.push('-m', o.message.trim());
  if (o.paths.length > 0) args.push('--', ...literalPathspecs(o.paths));
  return args;
}

export interface StashApplyArgsOptions {
  readonly index: number;
  /** Pop removes the entry; apply keeps it. */
  readonly pop: boolean;
  /** `--index`: restore the staged/unstaged split as it was. */
  readonly reinstateIndex: boolean;
}

export function buildStashApplyArgs(o: StashApplyArgsOptions): string[] {
  const args = ['stash', o.pop ? 'pop' : 'apply'];
  if (o.reinstateIndex) args.push('--index');
  args.push(`stash@{${o.index}}`);
  return args;
}
