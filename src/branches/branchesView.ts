/**
 * Branches TreeView (P2-T6): persistent sidebar sibling of the popup with
 * real right-click menus (Favorites / Local / per-remote / Tags), inline
 * checkout + star, and branch-onto-branch drag & drop (merge / rebase /
 * compare — IntelliJ drag affordance).
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { confirmModal } from '../ui/confirm';
import type { BranchOps } from './branchOps';
import type { RefService } from './refService';

export type BranchNode =
  | { kind: 'repo'; repo: RepoHandle }
  | { kind: 'section'; repo: RepoHandle; section: 'favorites' | 'local' | 'tags' }
  | { kind: 'remote'; repo: RepoHandle; remote: string }
  | { kind: 'branch'; repo: RepoHandle; ref: RefInfo; favorite: boolean };

const DND_MIME = 'application/vnd.code.tree.gittree.branches';

export class BranchesViewProvider
  implements vscode.TreeDataProvider<BranchNode>, vscode.TreeDragAndDropController<BranchNode>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dropMimeTypes = [DND_MIME];
  readonly dragMimeTypes = [DND_MIME];
  private favoritesCache = new Map<string, Set<string>>();

  constructor(
    private readonly core: Core,
    private readonly refServiceFor: (repo: RepoHandle) => RefService,
    private readonly ops: BranchOps,
  ) {
    for (const repo of core.repos) this.subscribe(repo);
    core.onDidAddRepo((repo) => {
      this.subscribe(repo);
      this.refresh();
    });
    core.onDidRemoveRepo(() => this.refresh());
  }

  private subscribe(repo: RepoHandle): void {
    repo.disposables.add(
      repo.model.onDidChange((sections) => {
        if (sections.has('refs') || sections.has('head')) this.refresh();
      }),
    );
    repo.disposables.add(this.refServiceFor(repo).onDidChangeFavorites(() => this.refresh()));
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  async getChildren(node?: BranchNode): Promise<BranchNode[]> {
    if (!node) {
      const repos = this.core.repos;
      // Preload favorites so getTreeItem stays sync.
      for (const repo of repos) {
        this.favoritesCache.set(repo.root, await this.refServiceFor(repo).getFavorites());
      }
      if (repos.length === 1) return this.repoChildren(repos[0]!);
      return repos.map((repo) => ({ kind: 'repo', repo }));
    }
    switch (node.kind) {
      case 'repo':
        return this.repoChildren(node.repo);
      case 'section': {
        const service = this.refServiceFor(node.repo);
        const favorites = this.favoritesCache.get(node.repo.root) ?? new Set<string>();
        if (node.section === 'favorites') {
          return service.localBranches
            .filter((b) => favorites.has(b.name))
            .map((ref) => this.branchNode(node.repo, ref, true));
        }
        if (node.section === 'local') {
          return service.localBranches.map((ref) =>
            this.branchNode(node.repo, ref, favorites.has(ref.name)),
          );
        }
        return service.tags.map((ref) => this.branchNode(node.repo, ref, false));
      }
      case 'remote': {
        const service = this.refServiceFor(node.repo);
        return service.remoteBranches
          .filter((r) => r.remote === node.remote)
          .map((ref) => this.branchNode(node.repo, ref, false));
      }
      case 'branch':
        return [];
    }
  }

  private repoChildren(repo: RepoHandle): BranchNode[] {
    const service = this.refServiceFor(repo);
    const favorites = this.favoritesCache.get(repo.root) ?? new Set<string>();
    const nodes: BranchNode[] = [];
    if (service.localBranches.some((b) => favorites.has(b.name))) {
      nodes.push({ kind: 'section', repo, section: 'favorites' });
    }
    nodes.push({ kind: 'section', repo, section: 'local' });
    const remotes = [...new Set(service.remoteBranches.map((r) => r.remote ?? ''))].sort();
    for (const remote of remotes) nodes.push({ kind: 'remote', repo, remote });
    if (service.tags.length > 0) nodes.push({ kind: 'section', repo, section: 'tags' });
    return nodes;
  }

  private branchNode(repo: RepoHandle, ref: RefInfo, favorite: boolean): BranchNode {
    return { kind: 'branch', repo, ref, favorite };
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
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
      case 'section': {
        const labels = {
          favorites: vscode.l10n.t('Favorites'),
          local: vscode.l10n.t('Local'),
          tags: vscode.l10n.t('Tags'),
        } as const;
        const item = new vscode.TreeItem(
          labels[node.section],
          node.section === 'tags'
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(
          node.section === 'favorites' ? 'star-full' : node.section === 'tags' ? 'tag' : 'git-branch',
        );
        item.contextValue = `section:${node.section}`;
        return item;
      }
      case 'remote': {
        const item = new vscode.TreeItem(node.remote, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('cloud');
        item.contextValue = 'section:remote';
        return item;
      }
      case 'branch': {
        const ref = node.ref;
        const isCurrent = ref.isHead;
        const label: vscode.TreeItemLabel = {
          label: ref.name,
          highlights: isCurrent ? [[0, ref.name.length]] : [],
        };
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        const track: string[] = [];
        if ((ref.ahead ?? 0) > 0) track.push(`↑${ref.ahead}`);
        if ((ref.behind ?? 0) > 0) track.push(`↓${ref.behind}`);
        if (ref.upstreamGone) track.push(vscode.l10n.t('gone'));
        item.description = [track.join(' '), ref.sha.slice(0, 7)].filter((s) => s.length > 0).join(' · ');
        item.tooltip = ref.subject ?? ref.name;
        item.iconPath = new vscode.ThemeIcon(
          isCurrent ? 'check' : ref.type === 'tag' ? 'tag' : ref.type === 'remote' ? 'cloud' : 'git-branch',
        );
        item.contextValue = isCurrent
          ? 'branch:current'
          : ref.type === 'remote'
            ? 'branch:remote'
            : ref.type === 'tag'
              ? 'branch:tag'
              : 'branch:local';
        return item;
      }
    }
  }

  // ---- Drag & drop ---------------------------------------------------------

  handleDrag(source: readonly BranchNode[], dataTransfer: vscode.DataTransfer): void {
    const branch = source.find((n) => n.kind === 'branch');
    if (branch?.kind === 'branch' && branch.ref.type === 'head') {
      dataTransfer.set(
        DND_MIME,
        new vscode.DataTransferItem(JSON.stringify({ repo: branch.repo.root, name: branch.ref.name })),
      );
    }
  }

  async handleDrop(target: BranchNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (!target || target.kind !== 'branch' || target.ref.type !== 'head') return;
    const raw = await dataTransfer.get(DND_MIME)?.asString();
    if (raw === undefined) return;
    const { repo: repoRoot, name: source } = JSON.parse(raw) as { repo: string; name: string };
    const repo = this.core.getRepo(repoRoot);
    if (!repo || repoRoot !== target.repo.root || source === target.ref.name) return;
    await this.showDropActions(repo, source, target.ref.name);
  }

  /** Exposed for integration tests (drag events can't be synthesized). */
  async showDropActions(repo: RepoHandle, source: string, target: string): Promise<void> {
    const merge = vscode.l10n.t('$(git-merge) Merge "{0}" into "{1}"', source, target);
    const rebase = vscode.l10n.t('$(git-branch) Rebase "{0}" onto "{1}"', target, source);
    const compare = vscode.l10n.t('$(diff) Compare "{0}" with "{1}"', source, target);
    const picked =
      process.env['GITTREE_TEST_DROP_CHOICE'] === 'merge'
        ? merge
        : await vscode.window.showQuickPick([merge, rebase, compare], {
            placeHolder: vscode.l10n.t('Dropped "{0}" onto "{1}"', source, target),
          });
    if (picked === undefined) return;
    if (picked === merge) {
      const ok = await confirmModal(
        vscode.l10n.t('Merge "{0}" into "{1}"?', source, target),
        vscode.l10n.t('"{0}" will be checked out first if needed.', target),
        vscode.l10n.t('Merge'),
      );
      if (!ok) return;
      if (repo.model.snapshot.headRef !== target) {
        await this.ops.checkout(repo, target);
      }
      await this.ops.mergeIntoCurrent(repo, source);
    } else if (picked === rebase) {
      const ok = await confirmModal(
        vscode.l10n.t('Rebase "{0}" onto "{1}"?', target, source),
        '',
        vscode.l10n.t('Rebase'),
      );
      if (!ok) return;
      await repo.queue.enqueue({
        label: vscode.l10n.t('Rebase {0} onto {1}', target, source),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.rebaseStart,
        snapshotAfter: true,
        run: async (git, token) => {
          await git.exec(repo.root, ['rebase', source, target], { token });
        },
      });
    } else {
      await vscode.commands.executeCommand('gittree.branches.compareWithCurrent', repo.root, source);
    }
  }
}
