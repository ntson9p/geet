/**
 * Pure commit argv assembly (P3-T5; vscode-free for unit tests).
 */
export interface CommitOptions {
  amend: boolean;
  sign: boolean;
}

export function buildCommitArgs(
  mode: 'staged' | 'only' | 'all',
  message: string,
  options: CommitOptions,
  paths: readonly string[] = [],
): string[] {
  const args = ['commit'];
  if (options.sign) args.push('-S');
  if (options.amend) args.push('--amend');
  if (message.length > 0) {
    args.push('-m', message);
  } else if (options.amend) {
    args.push('--no-edit');
  }
  if (mode === 'all') args.push('--all');
  if (mode === 'only') args.push('--only', '--', ...paths);
  return args;
}
