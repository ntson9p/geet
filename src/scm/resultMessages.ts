/**
 * The words of the completion notifications whose wording depends on counts
 * (POST-P14ap), vscode-free so the cases are unit-testable. IntelliJ's
 * `{0,choice,1#commit|2#commits}` is `plural` here.
 */

/** `1 commit` / `3 commits`. */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A pull's result: *Already up to date*, else what came in — the commits and
 * the files they changed, from where when that is known.
 */
export function pullResultMessage(commits: number, files: number, source?: string): string {
  if (commits === 0) return 'Already up to date';
  const what = plural(commits, 'commit', 'commits');
  const changed = plural(files, 'file', 'files');
  return source !== undefined && source.length > 0
    ? `Pulled ${what} from ${source}: ${changed} changed`
    : `Pulled ${what}: ${changed} changed`;
}

/**
 * IntelliJ's commit result (`vcs.commit.files.committed`): `1 file committed`,
 * `3 files committed`, `No files committed` — with the message's first line.
 */
export function committedMessage(files: number, message: string): string {
  const count = files === 0 ? 'No files' : plural(files, 'file', 'files');
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  return subject.length > 0 ? `${count} committed: ${subject}` : `${count} committed`;
}

/**
 * Several repositories' results as one notification: distinct messages, in
 * order, at most three and a count of the rest.
 */
export function joinMessages(messages: readonly string[]): string {
  const distinct = [...new Set(messages)];
  const shown = distinct.slice(0, 3).join(' · ');
  return distinct.length > 3 ? `${shown} · +${distinct.length - 3} more` : shown;
}
