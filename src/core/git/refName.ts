/**
 * Git reference names, the way IntelliJ's `GitRefNameValidator` checks and
 * cleans them (git-check-ref-format, minus what a branch field can never hold).
 * vscode-free: the Push dialog's target field imports it in the webview too, so
 * the name it shows while you type is the one the host will push to.
 */

/** Control characters 0–31 and DEL. */
const CONTROL = '[\\u0000-\\u001f\\u007f]';

/** Replaced while typing: runs of spaces, control characters. */
const REPLACE = ` +|${CONTROL}`;

/** Dropped while typing: what git forbids anywhere in a name. */
const DROP = [
  '(^\\.)', // begins with a dot
  '(^-)', // begins with '-'
  '(^/)', // begins with '/'
  '[~:^?*"\\[\\\\]+', // one of ~:^?*"[\
  '(@\\{)+', // an @{ sequence
  '/(?=/)', // a double slash
  '(\\.(?=\\.))+', // two dots in a row
  '\\.(?=/)', // a dot before a slash
  '(?<=/)\\.', // a dot after a slash
].join('|');

/** Only wrong at the end — the name may still be being typed. */
const END = '(([./]|\\.lock)$)';

const INVALID = new RegExp(`${DROP}|${END}|${REPLACE}`);

/** IntelliJ's `checkInput`: a non-blank name git would accept for a branch. */
export function isValidRefName(name: string): boolean {
  return name.trim().length > 0 && !INVALID.test(name);
}

/**
 * IntelliJ's `cleanUpBranchNameOnTyping`: what the field holds after each
 * keystroke. Forbidden characters disappear; spaces become `symbol` (IntelliJ's
 * `git.branch.cleanup.symbol`, `_` by default). A trailing `.` or `/` stays —
 * the user may not have finished.
 */
export function cleanUpBranchNameOnTyping(name: string, symbol = '_'): string {
  return name.replace(new RegExp(DROP, 'g'), '').replace(new RegExp(REPLACE, 'g'), symbol);
}

/** IntelliJ's `cleanUpBranchName`: the typing clean-up, then the bad endings too. */
export function cleanUpBranchName(name: string, symbol = '_'): string {
  return cleanUpBranchNameOnTyping(name, symbol).replace(new RegExp(END, 'g'), '');
}
