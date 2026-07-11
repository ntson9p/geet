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
import { LocalHistoryHooks } from './hooks';
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
  core.debugRegistry.set('phase09', {
    getStore: (repoRoot: string) => getSnapshotStore(repoRoot),
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
