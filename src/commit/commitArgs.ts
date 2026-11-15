/**
 * Pure commit argv assembly (P3-T5; vscode-free for unit tests).
 * P11-T5 adds the author override (`--author=`) and sign-off (`-s`) — both
 * optional so every pre-P11 call site keeps meaning exactly what it said.
 * POST-P14ck: `--only`'s paths go as literal pathspecs — a ticked `[id].tsx`
 * also committed a changed `i.tsx` (see core/git/pathspec).
 */
import { literalPathspecs } from '../core/git/pathspec';

export interface CommitOptions {
  amend: boolean;
  /** GPG-sign (`-S`) — distinct from `signoff`. */
  sign: boolean;
  /** `Name <email>` for `--author=`; git resolves author-only overrides. */
  author?: string;
  /** DCO trailer via `-s`. */
  signoff?: boolean;
}

export function buildCommitArgs(
  mode: 'staged' | 'only' | 'all',
  message: string,
  options: CommitOptions,
  paths: readonly string[] = [],
): string[] {
  const args = ['commit'];
  if (options.sign) args.push('-S');
  if (options.signoff === true) args.push('-s');
  if (options.author !== undefined && options.author.length > 0) {
    args.push(`--author=${options.author}`);
  }
  if (options.amend) args.push('--amend');
  if (message.length > 0) {
    args.push('-m', message);
  } else if (options.amend) {
    args.push('--no-edit');
  }
  if (mode === 'all') args.push('--all');
  if (mode === 'only') args.push('--only', '--', ...literalPathspecs(paths));
  return args;
}
