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
import {
  resolveStatusBarMode,
  StatusBarController,
  type ResolvedStatusBarMode,
  type StatusBarMode,
} from '../ui/statusBar';
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
  /**
   * What the status bar believes it is showing. "The widget is gone" has four
   * distinguishable causes and no way to tell them apart from the outside:
   * discovery dropped the repository (`repos` empty), the controller was
   * unregistered (`bars` empty), GitTree hid it (`visible: false`), or VS Code
   * is not rendering an item we did show (`visible: true` and still invisible —
   * status-bar crowding, or an entry the user hid from the status bar's own
   * context menu). `gittree.debug.showState` prints this.
   */
  statusBarDiagnostics(): StatusBarDiagnostics;
}

export interface StatusBarDiagnostics {
  /** What `auto` resolved to — the shape the widget is currently drawing. */
  mode: ResolvedStatusBarMode;
  /** Whether something else is already drawing a branch readout. */
  builtInGitPresent: boolean;
  /** What `activeRepoKey()` is resolving against right now. */
  activeEditor: string | undefined;
  /** The key whose bar should be the visible one. */
  activeRepoKey: string | undefined;
  repoKeys: string[];
  bars: Array<{ key: string; visible: boolean; titles: string[] }>;
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

  /**
   * Is something *else* already drawing a branch readout in the status bar?
   *
   * Only the two cases we can actually observe count: the built-in Git
   * extension not being installed, and `git.enabled: false`. What this
   * deliberately cannot see is a user who hid those entries from the status
   * bar's own right-click menu — VS Code exposes no API for that — so `auto`
   * leaves them on the compact button and the setting is their way out. It is
   * a read; GitTree never writes `git.enabled` (see `unsetGitEnabled`).
   */
  const builtInGitPresent = (): boolean => {
    if (vscode.extensions.getExtension('vscode.git') === undefined) return false;
    return vscode.workspace.getConfiguration('git').get<boolean>('enabled', true);
  };

  const statusBarMode = (): ResolvedStatusBarMode =>
    resolveStatusBarMode(
      vscode.workspace.getConfiguration('gittree').get<StatusBarMode>('statusBar', 'auto'),
      builtInGitPresent(),
    );

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
      new StatusBarController(
        repo,
        () => activeRepoKey() === key,
        statusBarMode,
        () => core.repos.length,
      ),
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
  /**
   * Every bar's visibility is `activeRepoKey() === key`, and that reads the
   * live handle set — `repoForUri` resolves against it and the fallback is
   * `core.repos[0]` — so *the repository set* is an input to the answer just
   * as much as editor focus is. Membership changes therefore have to
   * re-evaluate all of them, not only the repository that joined.
   *
   * The removal half is the one that was missing. Dropping the repository
   * whose widget was showing disposed its items and left every surviving
   * bar holding the `visible = false` it last computed; nothing recomputed
   * them, because a controller only hears about its own model. The status bar
   * went empty and stayed empty until an unrelated event happened to call
   * `update()`. Branch-popup actions write into `.git`, which pokes a
   * rediscovery, which is why the widget "sometimes disappeared" there.
   */
  const updateAll = (): void => {
    for (const bar of statusBars.values()) bar.update();
  };

  for (const repo of core.repos) attach(repo);
  // `attach` alone is not enough: the new handle can change what
  // `activeRepoKey()` answers for repositories that already have a bar.
  const addSub = core.onDidAddRepo((repo) => {
    attach(repo);
    updateAll();
  });
  // Fired after the handle is out of the map and its own bar disposed, so
  // this sees exactly the set that remains.
  const removeSub = core.onDidRemoveRepo(() => updateAll());
  context.subscriptions.push(
    new vscode.Disposable(() => {
      addSub.dispose();
      removeSub.dispose();
    }),
    // Which repo is "active" is an editor-focus question, so the visibility of
    // every repo's items has to be re-evaluated when focus moves.
    vscode.window.onDidChangeActiveTextEditor(() => updateAll()),
    // The widget's *shape* has two inputs and neither is ours alone: the
    // setting, and whether the built-in Git extension is drawing a readout.
    // `git.enabled` flipping is what makes `auto` change its mind.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gittree.statusBar') || e.affectsConfiguration('git.enabled')) {
        updateAll();
      }
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

  const statusBarDiagnostics = (): StatusBarDiagnostics => ({
    mode: statusBarMode(),
    builtInGitPresent: builtInGitPresent(),
    activeEditor: vscode.window.activeTextEditor?.document.uri.toString(),
    activeRepoKey: activeRepoKey(),
    repoKeys: core.repos.map((r) => canonicalKey(r.root)),
    bars: [...statusBars.entries()].map(([key, b]) => ({
      key,
      visible: b.visible,
      titles: b.titles,
    })),
  });

  const registry: Phase01Registry = {
    statusBars,
    revProvider,
    changeBars,
    statusBarDiagnostics,
  };
  core.debugRegistry.set('phase01', registry);
  return registry;
}
