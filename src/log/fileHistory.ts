/**
 * File History (P4-T8): `gittree.showFileHistory` opens the log panel in
 * single-path --follow mode; row clicks diff parent↔sha for that path via the
 * details panel (rename chains surface through git's --follow + rename-aware
 * details). It opens in a Log tab of its own (`History: <file>`), as
 * IntelliJ's History tab does, so the filters of the tab you came from stay
 * as you left them; asking again for the same file brings that tab back.
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { repoRelative } from '../core/util/paths';
import type { LogViewProvider } from './logView';

export function registerFileHistory(
  context: vscode.ExtensionContext,
  core: Core,
  logView: LogViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.showFileHistory', async (arg?: unknown) => {
      const uri =
        arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') return;
      const repo = core.repoForUri(uri);
      if (!repo) return;
      const rel = repoRelative(repo.root, uri.fsPath);
      if (rel === undefined) return;
      // `rel` is relative to *this* repository — say so. Without the root the
      // log re-resolved from the focused editor, so a file picked in the
      // Explorer of one repository was filtered against another one's history
      // and simply came back empty.
      await logView.openTab({ sort: 'topo', refs: 'ALL', paths: [rel], follow: true }, repo.root);
    }),
  );
}
