/**
 * Phase 4 registration: log panel webview, commit actions, blame service/UI,
 * file history. Single entry point per master §0.6.
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { REV_TREE_SCHEME, RevTreeFs, RevTreeViewProvider } from '../core/vdocs/revTreeFs';
import { registerCommitActions } from './commitActions';
import { BlameUi } from './blame/blameUi';
import { registerFileHistory } from './fileHistory';
import { LogViewProvider } from './logView';

export interface Phase04Registry {
  logView: LogViewProvider;
  blameUi: BlameUi;
  /** P12-T7 — the Show-Repository-at-Revision surface. */
  revTree: RevTreeViewProvider;
  revTreeFs: RevTreeFs;
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
      if (
        e.affectsConfiguration('gittree.log.graphPalette') ||
        e.affectsConfiguration('gittree.log.issuePattern') ||
        e.affectsConfiguration('gittree.log.issueUrl')
      ) {
        logView.refreshInit();
      }
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

  // P12-T7: Show Repository at Revision — read-only FS + dedicated tree view
  // (deviation D8: no second project frame exists in VS Code).
  const revTreeFs = new RevTreeFs(core);
  const revTree = new RevTreeViewProvider(revTreeFs);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(REV_TREE_SCHEME, revTreeFs, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.window.createTreeView('gittree.revTree', { treeDataProvider: revTree }),
    vscode.commands.registerCommand('gittree.log.showRepoAtRevision', async (arg: unknown) => {
      const fromCtx =
        typeof arg === 'object' && arg !== null && 'sha' in arg ? arg.sha : undefined;
      const sha =
        typeof fromCtx === 'string' ? fromCtx : typeof arg === 'string' ? arg : undefined;
      const root = logView.currentSession?.repoRoot;
      const repo =
        (root !== undefined
          ? core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root))
          : undefined) ?? core.repos[0];
      if (sha === undefined || !repo) return;
      await revTree.show({ repo, rev: sha, label: sha.slice(0, 7) });
      await vscode.commands.executeCommand('gittree.revTree.focus');
    }),
    vscode.commands.registerCommand('gittree.revTree.close', () => revTree.close()),
    // P12-T8: palette access to the Console ring's clear.
    vscode.commands.registerCommand('gittree.log.console.clear', () => core.commandLog.clear()),
  );

  const registry: Phase04Registry = { logView, blameUi, revTree, revTreeFs };
  core.debugRegistry.set('phase04', registry);
  return registry;
}
