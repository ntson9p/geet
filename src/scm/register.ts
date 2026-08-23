/**
 * Phase 1 registration: `gittree-rev:` provider, change bars, hunk actions,
 * file ops, status bar + sync, explorer decorations. Single entry point per
 * master §0.6.
 *
 * P14-T4 removed the per-repo `vscode.scm` SourceControl — the last reference
 * to the SCM framework anywhere in `src/`. What it carried has its own home
 * now: the change bars are GitTree-painted (T3), the status bar owns its
 * items, the count is a view badge, and the commit message lives in the commit
 * tool window.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { RevContentProvider, REV_SCHEME } from '../core/vdocs/revContentProvider';
import { StatusBarController } from '../ui/statusBar';
import { wireFileDecorations } from './fileDecorations';
import { registerFileOps } from './fileOps';
import { ChangeBarsController } from './gutter/changeBars';
import { registerChangePopup } from './gutter/changePopup';
import { registerHunkActions } from './hunkActions';
import { registerSyncOps } from './syncOps';

export interface Phase01Registry {
  statusBars: Map<string, StatusBarController>;
  revProvider: RevContentProvider;
  /** P14-T3 — GitTree's own change bars; the test seam for what is painted. */
  changeBars: ChangeBarsController;
}

export function registerPhase01(context: vscode.ExtensionContext, core: Core): Phase01Registry {
  const statusBars = new Map<string, StatusBarController>();

  /**
   * The status bar shows one repository at a time — the one the active editor
   * belongs to, else the first. `SourceControl.statusBarCommands` was scoped by
   * VS Code to the selected provider; with plain items the scoping is ours.
   */
  const activeRepoKey = (): string | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const repo = (uri && core.repoForUri(uri)) ?? core.repos[0];
    return repo ? canonicalKey(repo.root) : undefined;
  };

  // gittree-rev: content provider (P1-T2 / master §2), refreshed on status
  // changes so open diffs and gutter bars track index updates.
  const revProvider = new RevContentProvider(core);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(REV_SCHEME, revProvider),
    revProvider,
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === REV_SCHEME) revProvider.forget(doc.uri);
    }),
  );

  const attach = (repo: RepoHandle): void => {
    const key = canonicalKey(repo.root);
    if (statusBars.has(key)) return;
    const bar = repo.disposables.add(
      new StatusBarController(repo, () => activeRepoKey() === key),
    );
    statusBars.set(key, bar);
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('status')) revProvider.refreshRepo(repo.root);
      }),
    );
    repo.disposables.add({
      dispose: () => {
        statusBars.delete(key);
      },
    });
  };
  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(
    new vscode.Disposable(() => addSub.dispose()),
    // Which repo is "active" is an editor-focus question, so the visibility of
    // every repo's items has to be re-evaluated when focus moves.
    vscode.window.onDidChangeActiveTextEditor(() => {
      for (const bar of statusBars.values()) bar.update();
    }),
  );

  const changeBars = new ChangeBarsController(core);
  context.subscriptions.push(changeBars);
  registerChangePopup(context, core, changeBars);
  registerHunkActions(context, core);
  registerFileOps(context, core);
  registerSyncOps(context, core, statusBars);
  // gittree.commit + acceptInputCommand are owned by Phase 3 (commitFlow),
  // which supersedes the P1-T7 MVP over the same command ids.
  wireFileDecorations(context, core);

  const registry: Phase01Registry = { statusBars, revProvider, changeBars };
  core.debugRegistry.set('phase01', registry);
  return registry;
}
