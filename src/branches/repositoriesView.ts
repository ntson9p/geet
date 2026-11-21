/**
 * Repositories view (POST-P14u): one row per repository, with its current
 * branch and how far that branch is from its upstream — the multi-repo
 * dashboard VS Code users read in the Source Control view, and the selector the
 * Branches section below it follows.
 *
 * **The element is the root string, deliberately.** Every `geet.*` command
 * that acts on a repository already takes `repoRoot` as its first argument
 * (`resolveRepo`, `pickRepo`), and VS Code hands a tree node straight to the
 * command a menu entry names — so the row's context menu is built from the
 * *existing* commands with no adapter in between. An adapter is where a menu
 * starts to disagree with the surface it was copied from, which is POST-P14d.
 *
 * Rows do not expand. IntelliJ has no repositories window at all, and VS Code's
 * own Repositories view does not expand either; the expansion in a VS Code user's
 * memory belongs to the *Source Control* view, which is a different list with a
 * different job (see D29).
 */
import * as vscode from 'vscode';
import type { Core } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { repoRowDescription, type RepoRow } from './branchesPopup';
import type { RepoScope } from './repoScope';

export class RepositoriesViewProvider implements vscode.TreeDataProvider<string> {
  private readonly _onDidChange = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  /** Per-repo model subscriptions, rebuilt as repositories join and leave. */
  private readonly watches = new Map<string, vscode.Disposable>();

  constructor(
    private readonly core: Core,
    private readonly scope: RepoScope,
    private readonly showInOut: () => boolean,
  ) {
    this.rewatch();
  }

  /** A `head` change moves the branch name and the ahead/behind pair — the whole row. */
  private rewatch(): void {
    const live = new Set(this.core.repos.map((r) => canonicalKey(r.root)));
    for (const [key, sub] of [...this.watches]) {
      if (live.has(key)) continue;
      sub.dispose();
      this.watches.delete(key);
    }
    for (const repo of this.core.repos) {
      const key = canonicalKey(repo.root);
      if (this.watches.has(key)) continue;
      this.watches.set(
        key,
        repo.model.onDidChange((sections) => {
          if (sections.has('head')) this._onDidChange.fire(repo.root);
        }),
      );
    }
  }

  refresh(): void {
    this.rewatch();
    this._onDidChange.fire(undefined);
  }

  getChildren(element?: string): string[] {
    return element === undefined ? [...this.scope.all] : [];
  }

  /** Required for `TreeView.reveal`, which is how the focused row stays selected. */
  getParent(): undefined {
    return undefined;
  }

  getTreeItem(root: string): vscode.TreeItem {
    const name = this.scope.label(root);
    const focused = this.scope.isFocused(root);
    // Bold, the way `branchesView` marks the checked-out branch. Selection
    // supplies the background; this is what survives the view losing focus.
    const label: vscode.TreeItemLabel = {
      label: name,
      highlights: focused ? [[0, name.length]] : [],
    };
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = canonicalKey(root);
    item.iconPath = new vscode.ThemeIcon(focused ? 'circle-filled' : 'repo');
    item.description = this.rowDescription(root);
    item.tooltip = focused
      ? vscode.l10n.t('{0}\n{1}\n\nShowing this repository in Branches.', name, root)
      : vscode.l10n.t('{0}\n{1}\n\nClick to show this repository in Branches.', name, root);
    item.contextValue = 'repository';
    item.command = {
      command: 'geet.repositories.select',
      title: vscode.l10n.t('Focus Repository'),
      arguments: [root],
    };
    return item;
  }

  private rowDescription(root: string): string {
    const repo = this.core.getRepo(root);
    if (!repo) return '';
    const snap = repo.model.snapshot;
    const row: RepoRow = {
      root,
      name: this.scope.label(root),
      ...(snap.headRef !== undefined ? { currentBranch: snap.headRef } : {}),
      ...(snap.detached ? { detached: true } : {}),
      ...(snap.headSha !== undefined ? { headSha: snap.headSha } : {}),
      ...(snap.ahead !== undefined ? { ahead: snap.ahead } : {}),
      ...(snap.behind !== undefined ? { behind: snap.behind } : {}),
    };
    // The same builder the branches popup's repository rows use, so a
    // repository reads the same in both places — including the four states
    // that have no counts at all (detached, unborn, no upstream, never fetched).
    return repoRowDescription(row, this.showInOut());
  }

  dispose(): void {
    for (const sub of this.watches.values()) sub.dispose();
    this.watches.clear();
    this._onDidChange.dispose();
  }
}
