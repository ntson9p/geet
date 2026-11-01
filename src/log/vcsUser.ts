/**
 * The Author column's rules, ported from IntelliJ's `VcsUserUtil` and
 * `CommitPresentationUtil.getAuthorPresentation`: who a commit is shown as,
 * and whether it gets the `*` that says someone else committed it. Pure and
 * vscode-free.
 */

/** Java's `(\w+)[\p{Punct}\s](\w+)`: two words and one separator between them. */
const NAME_PATTERN = /^(\w+)[!-/:-@\[-`{-~\s](\w+)$/u;
const PRINTABLE_ASCII = /^[ -~]*$/u;

/** The name a user is shown by: their name, else the part of their email before the `@`, else the email. */
export function userName(name: string, email: string): string {
  if (name.length > 0) return name;
  const at = email.indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}

/**
 * A name reduced so that spellings of one person compare equal: `Ben Okafor`,
 * `ben.okafor` and `BEN_OKAFOR` all read `ben okafor`. Names that are not
 * plain ASCII are left as they are.
 */
export function nameInStandardForm(name: string): string {
  const match = NAME_PATTERN.exec(name);
  if (match !== null) return `${match[1]!.toLowerCase()} ${match[2]!.toLowerCase()}`;
  return PRINTABLE_ASCII.test(name) ? name.toLowerCase() : name;
}

/** IntelliJ's `isSamePerson`: two names in standard form, compared. */
export function isSamePerson(a: string, b: string): boolean {
  return nameInStandardForm(a) === nameInStandardForm(b);
}

/**
 * Whether the Author column marks this commit with IntelliJ's `*`: its
 * committer is someone other than its author, as after a rebase or a
 * cherry-pick by another person. IntelliJ's list of robot committers to
 * exempt is empty unless configured, so nobody is exempt here. A commit with
 * no committer name recorded is left unmarked rather than guessed at.
 */
export function committedByOther(authorName: string, authorEmail: string, committerName: string): boolean {
  if (committerName.length === 0) return false;
  return !isSamePerson(userName(authorName, authorEmail), committerName);
}
