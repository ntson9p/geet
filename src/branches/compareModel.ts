/**
 * What the Compare pane lists: the files that differ between two revisions, or
 * between a revision and the working tree. Pure and vscode-free, so it unit-tests
 * under the root suite.
 *
 * A comparison holds the shas its names resolved to when it was read, not the
 * names. A branch can move while its files are being walked, and every diff has
 * to keep agreeing with the list it came from until the list is read again, which
 * is what IntelliJ's `Change` objects do by holding revision numbers.
 */
import type { NameStatusEntry } from './parsing';

export interface Revision {
  /** What it is called on screen. */
  readonly name: string;
  readonly sha: string;
}

export interface Comparison {
  readonly left: Revision;
  /** Another revision, or the files on disk. */
  readonly right: Revision | 'worktree';
}

/**
 * Resolves what a comparison names, each on a line of its own, in order. With no
 * `right` it is against the working tree: not a name, as a branch can be called anything.
 */
export function revParseArgs(left: string, right: string | undefined): string[] {
  return ['rev-parse', `${left}^{commit}`, ...(right === undefined ? [] : [`${right}^{commit}`])];
}

export function comparisonFrom(
  left: string,
  right: string | undefined,
  revParseOutput: string,
): Comparison | undefined {
  const [leftSha, rightSha] = revParseOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (leftSha === undefined) return undefined;
  if (right === undefined) return { left: { name: left, sha: leftSha }, right: 'worktree' };
  if (rightSha === undefined) return undefined;
  return { left: { name: left, sha: leftSha }, right: { name: right, sha: rightSha } };
}

/**
 * Tip against tip, which is IntelliJ's `GitChangeUtils.getDiff`: what differs now,
 * not only what one side did since they parted.
 */
export function diffArgs(comparison: Comparison): string[] {
  const { left, right } = comparison;
  return ['diff', '--name-status', '-z', '-M', left.sha, ...(right === 'worktree' ? [] : [right.sha])];
}

export interface RevisionSide {
  readonly path: string;
  readonly ref: string;
}

export interface FileSides {
  /** A file the left side lacks reads as empty: no revision holds that path. */
  readonly left: RevisionSide;
  readonly right: RevisionSide | 'worktree';
}

export function sidesOf(comparison: Comparison, file: NameStatusEntry): FileSides {
  const left = { path: file.origPath ?? file.path, ref: comparison.left.sha };
  return comparison.right === 'worktree'
    ? { left, right: 'worktree' }
    : { left, right: { path: file.path, ref: comparison.right.sha } };
}

export type CompareStatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflicted';

/** `R` and `C` carry a similarity score (`R094`), so only the first letter counts. */
export function statusKind(status: string): CompareStatusKind {
  switch (status.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

export const STATUS_BADGE: Readonly<Record<CompareStatusKind, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  conflicted: '!',
};

/** The colours the Log's Changed Files pane and the Commit window use for the same statuses. */
export const STATUS_COLOR: Readonly<Record<CompareStatusKind, string>> = {
  added: 'geet.color.added',
  modified: 'geet.color.modified',
  deleted: 'geet.color.deleted',
  renamed: 'geet.color.renamed',
  conflicted: 'geet.color.conflicted',
};

/** A press this soon after another on the same row was a double click. */
export const DOUBLE_CLICK_MS = 500;

/**
 * Whether a click on a row should hand the keyboard to the diff. A single click
 * browses, as in VS Code's own Source Control view, so the list keeps it. A second
 * click on the same row goes into the diff, and so does the only click there is
 * under `workbench.list.openMode: doubleClick`. A tree view's command is not told
 * which kind of click ran it.
 */
export function goesIntoDiff(
  previous: { readonly path: string; readonly at: number } | undefined,
  path: string,
  at: number,
  opensOnDoubleClickOnly: boolean,
): boolean {
  if (opensOnDoubleClickOnly) return true;
  return previous !== undefined && previous.path === path && at - previous.at < DOUBLE_CLICK_MS;
}
