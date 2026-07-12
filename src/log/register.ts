/**
 * Phase 4 registration: log panel webview, commit actions, blame service/UI,
 * file history. Single entry point per master §0.6.
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { registerCommitActions } from './commitActions';
import { BlameUi } from './blame/blameUi';
import { registerFileHistory } from './fileHistory';
import { LogViewProvider } from './logView';

export interface Phase04Registry {
  logView: LogViewProvider;
  blameUi: BlameUi;
}

export function registerPhase04(context: vscode.ExtensionContext, core: Core): Phase04Registry {
  const logView = new LogViewProvider(context, core);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(LogViewProvider.viewId, logView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  registerCommitActions(context, core, logView);
  registerFileHistory(context, core, logView);

  const blameUi = new BlameUi(context, core);
  context.subscriptions.push(blameUi);
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.blame.toggle', () => blameUi.toggle()),
    vscode.commands.registerCommand('gittree.blame.showDiff', (sha: unknown, fsPath: unknown) => {
      if (typeof sha === 'string' && typeof fsPath === 'string') {
        return blameUi.showDiff(sha, fsPath);
      }
      return undefined;
    }),
    vscode.commands.registerCommand('gittree.blame.revealCursorCommit', async () => {
      const lb = blameUi.cursorCommit();
      if (lb && !lb.isUncommitted) {
        await logView.revealCommit(lb.sha);
      }
    }),
  );

  const registry: Phase04Registry = { logView, blameUi };
  core.debugRegistry.set('phase04', registry);
  return registry;
}
