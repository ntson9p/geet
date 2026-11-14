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
 *
 * POST-P14ce: `repos` names where it went, for a commit narrowed to some
 * repositories — the Repositories panel's pick, which Ctrl+K follows even with
 * the Commit window out of sight: `3 files committed to api: …`. Absent, or
 * empty, it says nothing of where, as IntelliJ's does.
 */
export function committedMessage(files: number, message: string, repos?: readonly string[]): string {
  const count = files === 0 ? 'No files' : plural(files, 'file', 'files');
  const where = repos !== undefined && repos.length > 0 ? ` to ${repositoriesPhrase(repos)}` : '';
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  return subject.length > 0 ? `${count} committed${where}: ${subject}` : `${count} committed${where}`;
}

/** `api`, `api and web`, `3 repositories`: some repositories, short enough for a notification. */
export function repositoriesPhrase(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} repositories`;
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
