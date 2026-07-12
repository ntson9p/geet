/**
 * Phase 5 registration (T1 engine + T2 dialog slice; T3..T6 extend this file
 * with undo/drop, revert/cherry-pick, reword and push safety).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { resolveShimDir } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { RebaseEngine } from './rebase/rebaseEngine';
import { oldestOf, RebaseViewController } from './rebase/rebaseView';
import { RebaseStateMonitor } from './rebase/stateMonitor';
import { UndoDropService } from './undoDrop';

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

  // ---- T2: interactive rebase dialog ---------------------------------------
  const rebaseView = new RebaseViewController(
    context,
    core,
    (repo) => engines.get(canonicalKey(repo.root)),
    (repo) => monitors.get(canonicalKey(repo.root)),
  );
  context.subscriptions.push(rebaseView);

  /** The log panel's repo (same seam commitActions uses), else fallbacks. */
  const logRepo = (): RepoHandle | undefined => {
    const p4 = core.debugRegistry.get('phase04') as
      | { logView?: { currentSession?: { repoRoot?: string } } }
      | undefined;
    const root = p4?.logView?.currentSession?.repoRoot;
    return (root !== undefined ? core.getRepo(root) : undefined) ?? pickRepo();
  };

  register('gittree.rebase.interactive', async (arg) => {
    const ctx = (typeof arg === 'object' && arg !== null ? arg : {}) as {
      sha?: string;
      shas?: string[];
    };
    const repo = logRepo();
    if (!repo) return;
    const candidates =
      ctx.shas !== undefined && ctx.shas.length > 0
        ? ctx.shas
        : typeof ctx.sha === 'string'
          ? [ctx.sha]
          : [];
    if (candidates.length === 0) return;
    const anchor = await oldestOf(repo, candidates);
    if (anchor !== undefined) await rebaseView.open(repo, anchor);
  });
  register('gittree.rebase.row.showInLog', async (arg) => {
    const sha = (arg as { sha?: string } | undefined)?.sha;
    if (typeof sha === 'string') {
      await vscode.commands.executeCommand('gittree.log.revealCommit', sha);
    }
  });
  register('gittree.rebase.row.resetAction', (arg) => {
    const sha = (arg as { sha?: string } | undefined)?.sha;
    if (typeof sha === 'string') rebaseView.resetRowAction(sha);
  });

  // ---- T3: Undo Commit & Drop Commit ---------------------------------------
  const undoDrop = new UndoDropService(core, (repo) => engines.get(canonicalKey(repo.root)));

  const shaOf = (arg: unknown): string | undefined => {
    if (typeof arg === 'object' && arg !== null && 'sha' in arg) {
      const sha = (arg as { sha?: unknown }).sha;
      if (typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha)) return sha;
    }
    if (typeof arg === 'string' && /^[0-9a-f]{7,64}$/i.test(arg)) return arg;
    return undefined;
  };
  register('gittree.commit.undo', async (arg) => {
    const repo = logRepo();
    if (!repo) return;
    // HEAD only — from the log menu the handler validates the clicked sha.
    const sha = shaOf(arg);
    const head = repo.model.snapshot.headSha;
    if (sha !== undefined && head !== undefined && !head.startsWith(sha)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Undo Commit only applies to the latest commit (HEAD). Use Drop Commit for older ones.'),
      );
      return;
    }
    await undoDrop.undoCommit(repo);
  });
  register('gittree.commit.drop', async (arg) => {
    const repo = logRepo();
    const sha = shaOf(arg);
    if (repo && sha !== undefined) {
      await undoDrop.dropCommit(repo, sha);
    }
  });

  core.debugRegistry.set('phase05', {
    getEngine: (repoRoot: string) => engines.get(canonicalKey(repoRoot)),
    getMonitor: (repoRoot: string) => monitors.get(canonicalKey(repoRoot)),
    rebaseView,
    undoDrop,
  });
}
