import * as vscode from 'vscode';

/**
 * `gittree.branches.showTags`: IntelliJ's **Show Tags**, which it offers in the
 * Branches popup's gear and in the log's *Branches Pane Settings* alike, for one
 * setting. Every surface that lists branches reads it here: the popup, the
 * sidebar's Branches views and the log's Branches pane.
 */
export function showTagsSetting(): boolean {
  return vscode.workspace.getConfiguration('gittree.branches').get<boolean>('showTags', true);
}
