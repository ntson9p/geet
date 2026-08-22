/**
 * Changelists TreeView (P3-T3): the IntelliJ commit tool window's file tree.
 * Checkboxes at both levels (tri-state rollup on lists), drag & drop between
 * lists, native context menus. Visible only in the changelists paradigm
 * (`when: gittree.paradigm == changelists` on the view contribution).
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../../core/core';
import { canonicalKey } from '../../core/repoDiscovery';
import { UNVERSIONED_ID, type Changelist, type ChangelistService } from './changelistService';

export type ChangelistNode =
  | { kind: 'repo'; repo: RepoHandle }
  | { kind: 'list'; repo: RepoHandle; list: Changelist }
  | { kind: 'unversioned'; repo: RepoHandle; files: string[] }
  | { kind: 'file'; repo: RepoHandle; relPath: string; listId: string; checked: boolean };

const DND_MIME = 'application/vnd.code.tree.gittree.changelists';

export class ChangelistsViewProvider
  implements vscode.TreeDataProvider<ChangelistNode>, vscode.TreeDragAndDropController<ChangelistNode>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dragMimeTypes = [DND_MIME];
  readonly dropMimeTypes = [DND_MIME];

  constructor(
    private readonly core: Core,
    private readonly serviceFor: (repo: RepoHandle) => ChangelistService,
  ) {
    for (const repo of core.repos) this.subscribe(repo);
    core.onDidAddRepo((repo) => {
      this.subscribe(repo);
      this.refresh();
    });
    core.onDidRemoveRepo(() => this.refresh());
  }

  private subscribe(repo: RepoHandle): void {
    repo.disposables.add(this.serviceFor(repo).onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getChildren(node?: ChangelistNode): ChangelistNode[] {
    if (!node) {
      const repos = this.core.repos;
      if (repos.length === 1) return this.repoChildren(repos[0] as RepoHandle);
      return repos.map((repo) => ({ kind: 'repo' as const, repo }));
    }
    switch (node.kind) {
      case 'repo':
        return this.repoChildren(node.repo);
      case 'list':
        return node.list.files.map((relPath) => ({
          kind: 'file' as const,
          repo: node.repo,
          relPath,
          listId: node.list.id,
          checked: node.list.checked.includes(relPath),
        }));
      case 'unversioned': {
        // P11-T3: untracked files carry a real checkbox now, so their ticked
        // state has to come from the service instead of being hardcoded false.
        const ticked = new Set(this.serviceFor(node.repo).unversionedCheckedPaths());
        return node.files.map((relPath) => ({
          kind: 'file' as const,
          repo: node.repo,
          relPath,
          listId: UNVERSIONED_ID,
          checked: ticked.has(relPath),
        }));
      }
      case 'file':
        return [];
    }
  }

  private repoChildren(repo: RepoHandle): ChangelistNode[] {
    const service = this.serviceFor(repo);
    const nodes: ChangelistNode[] = service
      .getLists()
      .map((list) => ({ kind: 'list' as const, repo, list }));
    const unversioned = service.unversioned();
    if (unversioned.length > 0) nodes.push({ kind: 'unversioned', repo, files: unversioned });
    return nodes;
  }

  getTreeItem(node: ChangelistNode): vscode.TreeItem {
    switch (node.kind) {
      case 'repo': {
        const item = new vscode.TreeItem(
          node.repo.root.split(/[\\/]/).pop() ?? node.repo.root,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'repo';
        return item;
      }
      case 'list': {
        const { list } = node;
        const label: vscode.TreeItemLabel = {
          label: list.name,
          highlights: list.isActive ? [[0, list.name.length]] : [],
        };
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        const parts = [vscode.l10n.t('{0} files', list.files.length)];
        if (list.comment !== undefined && list.comment.length > 0) parts.unshift(list.comment);
        item.description = parts.join(' · ');
        item.iconPath = new vscode.ThemeIcon(list.isActive ? 'circle-filled' : 'circle-outline');
        item.contextValue = list.isDefault ? 'changelist:default' : 'changelist';
        const checkedCount = list.checked.length;
        item.checkboxState =
          list.files.length > 0 && checkedCount === list.files.length
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        item.tooltip = list.isActive
          ? vscode.l10n.t('{0} (active changelist)', list.name)
          : list.name;
        return item;
      }
      case 'unversioned': {
        const item = new vscode.TreeItem(
          vscode.l10n.t('Unversioned Files'),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = vscode.l10n.t('{0} files', node.files.length);
        item.iconPath = new vscode.ThemeIcon('question');
        item.contextValue = 'changelist:unversioned';
        // P11-T3: ticking the group includes every untracked file in the commit.
        const ticked = this.serviceFor(node.repo).unversionedCheckedPaths().length;
        item.checkboxState =
          ticked > 0 && ticked === node.files.length
            ? vscode.TreeItemCheckboxState.Checked
            : vscode.TreeItemCheckboxState.Unchecked;
        return item;
      }
      case 'file': {
        const abs = path.join(node.repo.root, node.relPath);
        const item = new vscode.TreeItem(
          path.basename(node.relPath),
          vscode.TreeItemCollapsibleState.None,
        );
        item.resourceUri = vscode.Uri.file(abs);
        item.description = path.dirname(node.relPath) === '.' ? '' : path.dirname(node.relPath);
        const entry = this.serviceFor(node.repo).statusEntry(node.relPath);
        const code = entry ? (entry.kind === 'untracked' ? '?' : entry.x !== '.' ? entry.x : entry.y) : 'M';
        item.iconPath = new vscode.ThemeIcon(
          code === 'A' || code === '?'
            ? 'diff-added'
            : code === 'D'
              ? 'diff-removed'
              : code === 'R'
                ? 'diff-renamed'
                : 'diff-modified',
          new vscode.ThemeColor(
            code === 'A' || code === '?'
              ? 'gitDecoration.untrackedResourceForeground'
              : code === 'D'
                ? 'gitDecoration.deletedResourceForeground'
                : 'gitDecoration.modifiedResourceForeground',
          ),
        );
        item.contextValue = node.listId === UNVERSIONED_ID ? 'clfile:unversioned' : 'clfile';
        item.checkboxState = node.checked
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
        item.command = {
          command: 'gittree.openDiff',
          title: vscode.l10n.t('Open Changes'),
          arguments: [vscode.Uri.file(abs)],
        };
        return item;
      }
    }
  }

  // ---- Checkboxes ----------------------------------------------------------

  onCheckboxChanged(
    items: ReadonlyArray<[ChangelistNode, vscode.TreeItemCheckboxState]>,
  ): void {
    for (const [node, state] of items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      if (node.kind === 'list') {
        this.serviceFor(node.repo).setListChecked(node.list.id, checked);
      } else if (node.kind === 'unversioned') {
        this.serviceFor(node.repo).setListChecked(UNVERSIONED_ID, checked);
      } else if (node.kind === 'file') {
        this.serviceFor(node.repo).setChecked([node.relPath], checked);
      }
    }
  }

  // ---- Drag & drop ---------------------------------------------------------

  handleDrag(source: readonly ChangelistNode[], dataTransfer: vscode.DataTransfer): void {
    const files = source.filter((n): n is Extract<ChangelistNode, { kind: 'file' }> => n.kind === 'file');
    if (files.length === 0) return;
    dataTransfer.set(
      DND_MIME,
      new vscode.DataTransferItem(
        JSON.stringify({
          repo: files[0]!.repo.root,
          paths: files.map((f) => f.relPath),
        }),
      ),
    );
  }

  async handleDrop(target: ChangelistNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const raw = await dataTransfer.get(DND_MIME)?.asString();
    if (raw === undefined) return;
    const { repo: repoRoot, paths } = JSON.parse(raw) as { repo: string; paths: string[] };
    const repo = this.core.getRepo(repoRoot);
    if (!repo) return;

    let targetListId: string | undefined;
    if (target?.kind === 'list') targetListId = target.list.id;
    else if (target?.kind === 'file' && target.listId !== UNVERSIONED_ID) targetListId = target.listId;

    if (targetListId === undefined) {
      // Background / unversioned drop → offer a new changelist.
      const name = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New changelist for {0} file(s)', paths.length),
        ignoreFocusOut: true,
      });
      if (name === undefined || name.trim().length === 0) return;
      targetListId = this.serviceFor(repo).create(name.trim()).id;
    }
    if (canonicalKey(repo.root) !== canonicalKey(repoRoot)) return;
    this.serviceFor(repo).moveFiles(paths, targetListId);
  }
}
