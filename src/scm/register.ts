/**
 * Phase 1 registration: SourceControl per repo, `gittree-rev:` provider,
 * quick diff, hunk actions, file ops, status bar + sync, explorer
 * decorations, commit MVP. Single entry point per master §0.6.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { RevContentProvider, REV_SCHEME } from '../core/vdocs/revContentProvider';
import { StatusBarController } from '../ui/statusBar';
import { wireFileDecorations } from './fileDecorations';
import { registerFileOps } from './fileOps';
import { registerHunkActions } from './hunkActions';
import { wireQuickDiff } from './quickDiff';
import { GitTreeSourceControl } from './sourceControl';
import { registerSyncOps } from './syncOps';

export interface Phase01Registry {
  sourceControls: Map<string, GitTreeSourceControl>;
  statusBars: Map<string, StatusBarController>;
  revProvider: RevContentProvider;
}

export function registerPhase01(context: vscode.ExtensionContext, core: Core): Phase01Registry {
  const sourceControls = new Map<string, GitTreeSourceControl>();
  const statusBars = new Map<string, StatusBarController>();

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
    if (sourceControls.has(key)) return;
    const sc = repo.disposables.add(new GitTreeSourceControl(repo));
    sourceControls.set(key, sc);
    const bar = repo.disposables.add(new StatusBarController(repo, sc.sc));
    statusBars.set(key, bar);
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('status')) revProvider.refreshRepo(repo.root);
      }),
    );
    repo.disposables.add({
      dispose: () => {
        sourceControls.delete(key);
        statusBars.delete(key);
      },
    });
  };
  for (const repo of core.repos) attach(repo);
  const addSub = core.onDidAddRepo((repo) => attach(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  context.subscriptions.push(
    wireQuickDiff(core, (repo) => sourceControls.get(canonicalKey(repo.root))?.sc),
  );
  registerHunkActions(context, core);
  registerFileOps(context, core);
  registerSyncOps(context, core, statusBars);
  // gittree.commit + acceptInputCommand are owned by Phase 3 (commitFlow),
  // which supersedes the P1-T7 MVP over the same command ids.
  wireFileDecorations(context, core);

  const registry: Phase01Registry = { sourceControls, statusBars, revProvider };
  core.debugRegistry.set('phase01', registry);
  return registry;
}
