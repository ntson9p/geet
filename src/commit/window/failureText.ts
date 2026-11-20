/**
 * What the Commit window says when a commit fails (POST-QA). A failed hook
 * writes its findings to stderr, one per line; the banner showed git's first
 * line only — "lint: notes.md line 3: trailing whitespace", dropping the rest
 * and the summary — and never said which repository refused. Now it shows the
 * hook's own lines, a dozen at most, the repository first when there are
 * several, and points at the Geet output for the rest. vscode-free.
 */

/** The parts of a `GitError` this needs; structural so tests need no git. */
interface GitFailureLike {
  readonly message: string;
  readonly stderr: string;
}

function isGitFailure(err: unknown): err is GitFailureLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as GitFailureLike).message === 'string' &&
    typeof (err as GitFailureLike).stderr === 'string'
  );
}

export const FAILURE_LINES = 12;

export function failureText(err: unknown, repoLabel?: string): string {
  const prefix = repoLabel !== undefined ? `${repoLabel}: ` : '';
  if (isGitFailure(err)) {
    const lines = err.stderr
      .split(/\r?\n/u)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) return `${prefix}${err.message}`;
    const shown = lines.slice(0, FAILURE_LINES).join('\n');
    const more = lines.length - FAILURE_LINES;
    return `${prefix}${shown}${more > 0 ? `\n… ${more} more line${more === 1 ? '' : 's'} in the Geet output` : ''}`;
  }
  return `${prefix}${err instanceof Error ? err.message : String(err)}`;
}
