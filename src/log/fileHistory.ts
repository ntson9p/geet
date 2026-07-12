/**
 * File History (P4-T8): `gittree.showFileHistory` opens the log panel in
 * single-path --follow mode; row clicks diff parent↔sha for that path via the
 * details panel (rename chains surface through git's --follow + rename-aware
 * details).
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
      await logView.setFilter({ sort: 'topo', refs: 'ALL', paths: [rel], follow: true });
    }),
  );
}
