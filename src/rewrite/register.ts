/**
 * Phase 5 registration (T1 slice — rebase engine, state monitors and the
 * continue/skip/abort commands; T2..T6 extend this file with the rebase
 * dialog, undo/drop, revert/cherry-pick, reword and push safety).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { resolveShimDir } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { RebaseEngine } from './rebase/rebaseEngine';
import { RebaseStateMonitor } from './rebase/stateMonitor';

export function registerPhase05HistoryRewriting(
  context: vscode.ExtensionContext,
  core: Core,
): void {
  const trace = (l: string): void => core.output.appendLine(`[rewrite] ${l}`);
  const shimDir = resolveShimDir(context);
  const engines = new Map<string, RebaseEngine>();
  const monitors = new Map<string, RebaseStateMonitor>();

  const updateContextKey = (): void => {
    const active = core.repos.some((r) => monitors.get(canonicalKey(r.root))?.isRebasing === true);
    void vscode.commands.executeCommand('setContext', 'gittree.rebase.active', active);
  };

  const attach = (repo: RepoHandle): void => {
    const key = canonicalKey(repo.root);
    if (engines.has(key)) return;
    const engine = new RebaseEngine(repo, { shimDir, trace });
    const monitor = new RebaseStateMonitor(repo);
    engines.set(key, engine);
    monitors.set(key, monitor);
    repo.disposables.add(engine);
    repo.disposables.add(monitor);
    repo.disposables.add({
      dispose: () => {
        engines.delete(key);
        monitors.delete(key);
      },
    });

    // Interim guidance toast until the P6 conflicts view takes over.
    repo.disposables.add(
      monitor.onDidPause((e) => {
        updateContextKey();
        const cont = vscode.l10n.t('Continue');
        const skip = vscode.l10n.t('Skip Commit');
        const abort = vscode.l10n.t('Abort');
        void vscode.window
          .showWarningMessage(
            vscode.l10n.t(
              'Rebase paused: {0} conflicted file(s). Resolve and stage them, then continue.',
              e.conflictedPaths.length,
            ),
            cont,
            skip,
            abort,
          )
          .then((choice) => {
            if (choice === cont) return vscode.commands.executeCommand('gittree.rebase.continue', repo.root);
            if (choice === skip) return vscode.commands.executeCommand('gittree.rebase.skip', repo.root);
            if (choice === abort) return vscode.commands.executeCommand('gittree.rebase.abort', repo.root);
            return undefined;
          });
      }),
    );
    repo.disposables.add(monitor.onDidChangeProgress(() => updateContextKey()));
    repo.disposables.add(monitor.onDidEnd(() => updateContextKey()));
  };

  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  const pickRepo = (arg?: unknown): RepoHandle | undefined => {
    if (typeof arg === 'string') return core.getRepo(arg);
    const rebasing = core.repos.find(
      (r) => monitors.get(canonicalKey(r.root))?.isRebasing === true,
    );
    if (rebasing) return rebasing;
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };
  const engineFor = (repo: RepoHandle | undefined): RebaseEngine | undefined =>
    repo ? engines.get(canonicalKey(repo.root)) : undefined;
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  const reportOutcome = async (
    action: () => Promise<{ status: string; stderr?: string }> | undefined,
  ): Promise<void> => {
    const outcome = await action();
    if (outcome?.status === 'completed') {
      void vscode.window.setStatusBarMessage(vscode.l10n.t('$(check) Rebase completed'), 5000);
    } else if (outcome?.status === 'failed') {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Rebase failed: {0}', outcome.stderr?.split('\n')[0] ?? ''),
      );
    }
  };

  register('gittree.rebase.continue', async (repoRoot) => {
    const engine = engineFor(pickRepo(repoRoot));
    if (engine) await reportOutcome(() => engine.continueRebase());
  });
  register('gittree.rebase.skip', async (repoRoot) => {
    const engine = engineFor(pickRepo(repoRoot));
    if (engine) await reportOutcome(() => engine.skip());
  });
  register('gittree.rebase.abort', async (repoRoot) => {
    const engine = engineFor(pickRepo(repoRoot));
    if (engine) {
      await engine.abort();
      void vscode.window.setStatusBarMessage(vscode.l10n.t('$(discard) Rebase aborted'), 5000);
    }
  });
  register('gittree.rebase.actions', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    const items: Array<vscode.QuickPickItem & { cmd: string }> = [
      { label: `$(debug-continue) ${vscode.l10n.t('Continue Rebase')}`, cmd: 'gittree.rebase.continue' },
      { label: `$(debug-step-over) ${vscode.l10n.t('Skip Current Commit')}`, cmd: 'gittree.rebase.skip' },
      { label: `$(discard) ${vscode.l10n.t('Abort Rebase')}`, cmd: 'gittree.rebase.abort' },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Rebase in progress — choose an action'),
    });
    if (picked) await vscode.commands.executeCommand(picked.cmd, repo.root);
  });

  core.debugRegistry.set('phase05', {
    getEngine: (repoRoot: string) => engines.get(canonicalKey(repoRoot)),
    getMonitor: (repoRoot: string) => monitors.get(canonicalKey(repoRoot)),
  });
}
