/**
 * Phase 4 registration: log panel webview, commit actions, blame service/UI,
 * file history. Single entry point per master §0.6.
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
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
    // P10-T2: keyboard parity — reveal the log and focus its filter box.
    vscode.commands.registerCommand('gittree.log.focusFilter', async () => {
      await vscode.commands.executeCommand('gittree.log.focus');
      logView.focusFilter();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gittree.log.graphPalette')) logView.refreshInit();
    }),
  );

  // P12-T2: the Branches pane's native context menu. The webview rows carry
  // {repoRoot, refName, refType}; every command dispatches through the shared
  // branchActions registry — the same code the branches tree runs.
  const branchCtx = (
    arg: unknown,
  ): { repoRoot: string; refName: string; refType: 'local' | 'remote' | 'tag' } | undefined => {
    if (
      arg &&
      typeof arg === 'object' &&
      'refName' in arg &&
      'repoRoot' in arg &&
      typeof (arg as { refName: unknown }).refName === 'string'
    ) {
      const a = arg as { repoRoot: string; refName: string; refType?: string };
      const refType = a.refType === 'remote' || a.refType === 'tag' ? a.refType : 'local';
      return { repoRoot: a.repoRoot, refName: a.refName, refType };
    }
    return undefined;
  };
  for (const action of [
    'checkout',
    'newFrom',
    'compareWithCurrent',
    'diffWithWorkingTree',
    'rebaseOntoCurrent',
    'push',
    'rename',
    'delete',
    'toggleFavorite',
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`gittree.log.branch.${action}`, async (arg: unknown) => {
        const ctx = branchCtx(arg);
        if (!ctx) return;
        // Canonical match, and NO fallback: acting on some other repo because
        // the path spelling differed (8.3 short names) would be worse than
        // not acting at all.
        const repo = core.repos.find(
          (r) => canonicalKey(r.root) === canonicalKey(ctx.repoRoot),
        );
        if (!repo) return;
        await logView.branchesBridge.dispatch(repo, {
          action,
          name: ctx.refName,
          type: ctx.refType,
        });
      }),
    );
  }

  const registry: Phase04Registry = { logView, blameUi };
  core.debugRegistry.set('phase04', registry);
  return registry;
}
