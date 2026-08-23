/**
 * Clone argv (P13-T4), vscode-free so the option matrix is unit-testable.
 *
 * The dialog is URL-entry only: GitTree has no account integrations and cannot
 * enumerate a provider's repositories (deviation D11, a standing project
 * constraint rather than an API limit).
 */

export interface CloneOptions {
  readonly url: string;
  /** Absolute destination directory. */
  readonly directory: string;
  readonly recursiveSubmodules: boolean;
  /** `--depth <n>`; 0 means a full clone. */
  readonly depth: number;
  /** `--branch <name>`; empty means the remote's default. */
  readonly branch: string;
}

export const EMPTY_CLONE_OPTIONS: CloneOptions = {
  url: '',
  directory: '',
  recursiveSubmodules: false,
  depth: 0,
  branch: '',
};

export function validateCloneOptions(o: CloneOptions): string[] {
  const errors: string[] = [];
  if (o.url.trim().length === 0) errors.push('Enter a repository URL.');
  if (o.directory.trim().length === 0) errors.push('Choose a directory to clone into.');
  if (!Number.isInteger(o.depth) || o.depth < 0) errors.push('Depth must be 0 or a whole number.');
  return errors;
}

export function buildCloneArgs(o: CloneOptions): string[] {
  const args = ['clone'];
  if (o.recursiveSubmodules) args.push('--recurse-submodules');
  if (o.depth > 0) args.push('--depth', String(o.depth));
  if (o.branch.trim().length > 0) args.push('--branch', o.branch.trim());
  args.push('--', o.url.trim(), o.directory.trim());
  return args;
}

/**
 * The directory name a URL suggests: `https://host/team/repo.git` → `repo`.
 * Used to fill the destination as the user types, like every clone dialog does.
 */
export function suggestedDirName(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, '');
  if (trimmed.length === 0) return '';
  const afterColon = trimmed.includes('://')
    ? trimmed
    : trimmed.replace(/^[^@]*@[^:]*:/u, ''); // scp-style host:path
  const last = afterColon.split(/[/\\]/u).pop() ?? '';
  return last.replace(/\.git$/u, '');
}
