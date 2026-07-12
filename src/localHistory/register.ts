/**
 * Phase 9 registration (T1/T2 slice — store + hooks; T3/T4 extend this file
 * with the browse/restore views and recovery watcher). One SnapshotStore +
 * LocalHistoryHooks per repository handle, created for current and future
 * repos; GC runs on idle activation.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { repoRelative } from '../core/util/paths';
import { SnapContentProvider, SNAP_SCHEME } from '../core/vdocs/snapFs';
import { LocalHistoryHooks } from './hooks';
import { RecoveryWatch } from './recoveryWatch';
import { LocalHistoryViewProvider, RestoreUx, type HistoryNode } from './restoreUx';
import { repoStoreKey, SnapshotStore } from './snapshotStore';

interface RepoHistory {
  store: SnapshotStore;
  hooks: LocalHistoryHooks;
}

const registry = new Map<string, RepoHistory>();

/** Access for tests and later P9 tasks (views, restore). */
export function getSnapshotStore(repoRoot: string): SnapshotStore | undefined {
  return registry.get(canonicalKey(repoRoot))?.store;
}

export function registerPhase09LocalHistory(context: vscode.ExtensionContext, core: Core): void {
  const config = () => vscode.workspace.getConfiguration('gittree.localHistory');
  const trace = (l: string): void => core.output.appendLine(`[local-history] ${l}`);

  const attach = (repo: RepoHandle): void => {
    const key = canonicalKey(repo.root);
    if (registry.has(key)) return;
    const store = new SnapshotStore({
      storeDir: path.join(context.globalStorageUri.fsPath, 'history', repoStoreKey(key)),
      repoRoot: repo.root,
      maxFileSizeKb: config().get<number>('maxFileSizeKb', 1024),
      maxSizeMb: config().get<number>('maxSizeMb', 500),
      retentionDays: config().get<number>('retentionDays', 30),
      trace,
    });
    const hooks = new LocalHistoryHooks({
      repoRoot: repo.root,
      model: repo.model,
      queue: repo.queue,
      store,
      isEnabled: () => config().get<boolean>('enabled', true),
      taskLabelsEnabled: () => config().get<boolean>('taskLabels', true),
      onStoreFailure: (err) => {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'GitTree could not write a Local History snapshot ({0}). Git operations continue without the safety net.',
            err instanceof Error ? err.message : String(err),
          ),
        );
      },
      onLargeSnapshot: (count) => {
        void vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: vscode.l10n.t('GitTree: snapshotting {0} files…', count),
          },
          () => new Promise((r) => setTimeout(r, 500)),
        );
      },
      trace,
    });
    registry.set(key, { store, hooks });
    repo.disposables.add(hooks);
    repo.disposables.add({ dispose: () => registry.delete(key) });

    // GC on idle activation (never blocks startup).
    const timer = setTimeout(() => {
      store.gc().catch((err: unknown) => trace(`gc failed: ${String(err)}`));
    }, 10_000);
    timer.unref?.();
  };

  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  // ---- P9-T3: browse & restore UX -----------------------------------------
  const storeForRepo = (repo: RepoHandle): SnapshotStore | undefined =>
    getSnapshotStore(repo.root);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      SNAP_SCHEME,
      new SnapContentProvider((repoRoot) => getSnapshotStore(repoRoot)),
    ),
  );
  const viewProvider = new LocalHistoryViewProvider(core, storeForRepo);
  const view = vscode.window.createTreeView('gittree.localHistory', {
    treeDataProvider: viewProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);
  const restoreUx = new RestoreUx(core, storeForRepo, viewProvider);

  const setFilter = (filter: { repoRoot: string; prefix: string } | undefined): void => {
    viewProvider.setPathFilter(filter);
    void vscode.commands.executeCommand(
      'setContext',
      'gittree.localHistory.filtered',
      filter !== undefined,
    );
  };
  const pickRepo = (arg?: unknown): RepoHandle | undefined => {
    if (typeof arg === 'string') return core.getRepo(arg);
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };
  register('gittree.history.show', async (repoRoot) => {
    setFilter(undefined);
    void pickRepo(repoRoot);
    await vscode.commands.executeCommand('gittree.localHistory.focus');
  });
  register('gittree.history.showForPath', async (arg) => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file') return;
    const repo = core.repoForUri(uri);
    if (!repo) return;
    const rel = repoRelative(repo.root, uri.fsPath);
    if (rel === undefined) return;
    setFilter({ repoRoot: repo.root, prefix: rel });
    await vscode.commands.executeCommand('gittree.localHistory.focus');
  });
  register('gittree.history.compareSnapshot', (node) => restoreUx.compareSnapshot(node as HistoryNode));
  register('gittree.history.diffFile', (node) => restoreUx.diffFile(node as HistoryNode));
  register('gittree.history.restoreSnapshot', (node) => restoreUx.restore(node as HistoryNode, false));
  register('gittree.history.restoreFiles', (node) => restoreUx.restore(node as HistoryNode, true));
  register('gittree.history.deleteSnapshot', (node) => restoreUx.deleteSnapshot(node as HistoryNode));
  register('gittree.history.clearAll', (repoRoot) => restoreUx.clearAll(pickRepo(repoRoot)));
  register('gittree.history.gcNow', (repoRoot) => restoreUx.gcNow(pickRepo(repoRoot)));
  register('gittree.history.clearFilter', () => setFilter(undefined));

  // Keep the view fresh as snapshots land (current and future repos).
  const hookRefresh = (repo: RepoHandle): void => {
    repo.disposables.add(repo.queue.onDidFinishMutation(() => viewProvider.refresh()));
  };
  for (const repo of core.repos) hookRefresh(repo);
  const refreshSub = core.onDidAddRepo((repo) => hookRefresh(repo));
  context.subscriptions.push(new vscode.Disposable(() => refreshSub.dispose()));

  // ---- P9-T4: destruction detection ----------------------------------------
  const recovery = new RecoveryWatch(core);
  context.subscriptions.push(recovery);
  register('gittree.history.recoverCommit', async (repoRoot, sha) => {
    const repo = pickRepo(repoRoot);
    if (repo && typeof sha === 'string') {
      await recovery.recoverCommit(repo, sha);
    }
  });

  core.debugRegistry.set('phase09', {
    getStore: (repoRoot: string) => getSnapshotStore(repoRoot),
    viewProvider,
    restoreUx,
    recovery,
  });

  // Task-end labels (test/build groups only, cheap label snapshots).
  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e) => {
      const task = e.execution.task;
      const isTestOrBuild =
        task.group === vscode.TaskGroup.Test || task.group === vscode.TaskGroup.Build;
      const scopeUri =
        typeof task.scope === 'object' && task.scope !== null && 'uri' in task.scope
          ? task.scope.uri
          : undefined;
      const repo = scopeUri ? core.repoForUri(scopeUri) : core.repos[0];
      if (!repo) return;
      void registry.get(canonicalKey(repo.root))?.hooks.onTaskEnded(task.name, isTestOrBuild);
    }),
  );

  // Optional save snapshots (default off — native Local History owns saves).
  const saveDebounce = new Map<string, number>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== 'file') return;
      if (!config().get<boolean>('snapshotOnSave', false)) return;
      const repo = core.repoForUri(doc.uri);
      if (!repo) return;
      const now = Date.now();
      const last = saveDebounce.get(doc.uri.fsPath) ?? 0;
      if (now - last < 30_000) return; // 30s per-file debounce
      saveDebounce.set(doc.uri.fsPath, now);
      void registry.get(canonicalKey(repo.root))?.hooks.onFileSaved(doc.uri.fsPath);
    }),
  );
}
