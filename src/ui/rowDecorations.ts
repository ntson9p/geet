/**
 * POST-P14cd: the addresses of Geet's own tree rows (`rowAddress.ts`) as VS
 * Code URIs, and the letters and colours Geet marks them with, which VS Code
 * takes only from a file decoration. Only rows under `gittree-row` with a mark
 * get one: a stash's file, what the stash did to it; a conflicted file, `!`.
 */
import * as vscode from 'vscode';
import { rowAddress, rowLook, rowMarkOf, type RowMark, type RowView } from './rowAddress';

/** A row's `TreeItem.resourceUri`: the file or folder at `fsPath`, in `view`, with its mark if it has one. */
export function rowUri(view: RowView, fsPath: string, mark?: RowMark): vscode.Uri {
  return vscode.Uri.from(rowAddress(view, vscode.Uri.file(fsPath).path, mark));
}

/** What a mark means where it is: the decoration's hover. */
function markTitle(view: RowView, mark: RowMark): string {
  if (view === 'stash') {
    switch (mark) {
      case 'added':
        return vscode.l10n.t('Added in this stash');
      case 'modified':
        return vscode.l10n.t('Modified in this stash');
      case 'deleted':
        return vscode.l10n.t('Deleted in this stash');
      case 'renamed':
        return vscode.l10n.t('Renamed in this stash');
      case 'untracked':
        return vscode.l10n.t('Untracked, kept in this stash');
      case 'conflicted':
        return vscode.l10n.t('Merge conflict');
    }
  }
  switch (mark) {
    case 'added':
      return vscode.l10n.t('Added');
    case 'modified':
      return vscode.l10n.t('Modified');
    case 'deleted':
      return vscode.l10n.t('Deleted');
    case 'renamed':
      return vscode.l10n.t('Renamed');
    case 'untracked':
      return vscode.l10n.t('Untracked');
    case 'conflicted':
      return vscode.l10n.t('Merge conflict');
  }
}

class RowDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const marked = rowMarkOf(uri.scheme, uri.authority, uri.query);
    if (marked === undefined) return undefined;
    const look = rowLook(marked.mark);
    return new vscode.FileDecoration(
      look.letter,
      markTitle(marked.view, marked.mark),
      new vscode.ThemeColor(look.color),
    );
  }
}

/** Once, at activation. A row's mark is in its address, so nothing ever needs redrawing. */
export function registerRowDecorations(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(new RowDecorations()));
}
