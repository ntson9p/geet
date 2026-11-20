/**
 * POST-P14cd: the address a row of Geet's own tree views gives VS Code when
 * the row stands for a file or a folder: Stashes, Local History, Conflicts and
 * Worktrees.
 *
 * A `file:` address tells VS Code that the row *is* that file on disk, and
 * every extension that marks files marks the row too. VS Code's built-in Git
 * did, with the file's status now, which says nothing about a stash or a
 * snapshot: of two files a stash changed, the one edited since got an `M`, the
 * other nothing. Under Geet's own scheme only Geet marks these rows, with
 * what is true of them: what the stash did to the file, a conflict's `!`.
 * Local History and Worktrees rows carry no mark.
 *
 * The address keeps the file's path, so its last segment is the file's name,
 * which VS Code's file icon theme reads for a `ThemeIcon.File` row. The view is
 * the authority, the mark the query: `gittree-row://stash/c:/repo/src/a.ts?modified`.
 * The Compare view has had its own scheme since P12 (`gittree-compare`); this is
 * the same idea for the rest. Free of `vscode`, so it is unit-tested.
 */

export const ROW_SCHEME = 'gittree-row';

/** The views whose rows carry such an address. */
export type RowView = 'stash' | 'history' | 'conflict' | 'worktree';

export const ROW_VIEWS: readonly RowView[] = ['stash', 'history', 'conflict', 'worktree'];

/** What Geet marks a row with: the row's own status, in its view's terms. */
export type RowMark = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflicted';

/** A mark's letter, as VS Code's views write it, and its colour: one of Geet's `gittree.color.*`. */
export interface RowLook {
  readonly letter: string;
  readonly color: string;
}

const LOOKS: Readonly<Record<RowMark, RowLook>> = {
  added: { letter: 'A', color: 'gittree.color.added' },
  modified: { letter: 'M', color: 'gittree.color.modified' },
  deleted: { letter: 'D', color: 'gittree.color.deleted' },
  renamed: { letter: 'R', color: 'gittree.color.renamed' },
  untracked: { letter: 'U', color: 'gittree.color.untracked' },
  conflicted: { letter: '!', color: 'gittree.color.conflicted' },
};

export const ROW_MARKS = Object.keys(LOOKS) as readonly RowMark[];

/** The parts of a row's address, in the shape `vscode.Uri.from` takes. */
export interface RowAddressParts {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  readonly query: string;
}

/**
 * A row's address: its view, the file's path as a `file:` URI writes it
 * (`/c:/repo/src/a.ts`, from `vscode.Uri.file(fsPath).path`), and its mark.
 */
export function rowAddress(view: RowView, uriPath: string, mark?: RowMark): RowAddressParts {
  return {
    scheme: ROW_SCHEME,
    authority: view,
    path: uriPath.startsWith('/') ? uriPath : `/${uriPath}`,
    query: mark ?? '',
  };
}

function isRowView(value: string): value is RowView {
  return (ROW_VIEWS as readonly string[]).includes(value);
}

function isRowMark(value: string): value is RowMark {
  return Object.prototype.hasOwnProperty.call(LOOKS, value);
}

/**
 * The mark an address asks for, with the view it is in; `undefined` for any
 * other scheme, a view that is not Geet's, or an address with no mark.
 */
export function rowMarkOf(
  scheme: string,
  authority: string,
  query: string,
): { readonly view: RowView; readonly mark: RowMark } | undefined {
  if (scheme !== ROW_SCHEME || !isRowView(authority) || !isRowMark(query)) return undefined;
  return { view: authority, mark: query };
}

export function rowLook(mark: RowMark): RowLook {
  return LOOKS[mark];
}
