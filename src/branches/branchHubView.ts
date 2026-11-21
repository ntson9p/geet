/**
 * Branches view (new-way-2): **the branches popup, standing open**.
 *
 * It renders the very rows the popup renders — `popupTree.rootRows` and
 * `childRows`, the same order, the same labels, the same descriptions — so the
 * two surfaces cannot come to disagree about what the tree contains. What it
 * does not do is flatten them: a `TreeView` expands natively, so here the
 * levels are real tree nodes with real disclosure triangles, which is what the
 * popup can only approximate with indentation (deviation D5).
 *
 * It is **project-level**, as the popup is: every repository, then the refs
 * every repository shares. The Repositories section above it no longer filters
 * this view; it decides which repository opens first, which is what the owner's
 * reference does when you arrive from a particular root.
 *
 * Rows do not check out on click. A single click is how a tree is *selected*,
 * and a checkout is not what anyone means by selecting a row; the inline ✓ and
 * the context menu are the two ways to run one.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { branchContextValue } from './branchActions';
import {
  applyShowTags,
  childRows,
  commonRefNames,
  nodeIds,
  rootRows,
  type RepoRefs,
  type TreeContext,
  type TreeRow,
} from './popupTree';
import type { RefService } from './refService';
import type { RepoScope } from './repoScope';
import { showTagsSetting } from './showTags';
import { INTELLIJ_KEYMAP_SETTING, shownAccelerator } from '../ui/accelerators';

const DND_MIME = 'application/vnd.code.tree.geet.branches';

export interface BranchHubDeps {
  readonly core: Core;
  readonly scope: RepoScope;
  readonly refServiceFor: (repo: RepoHandle) => RefService;
  readonly showInOut: () => boolean;
  /** The legacy tree's drop handler, reused so the gesture has one implementation. */
  readonly onDrop: (repo: RepoHandle, source: string, target: string) => Promise<void>;
}

export class BranchHubViewProvider
  implements vscode.TreeDataProvider<TreeRow>, vscode.TreeDragAndDropController<TreeRow>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dropMimeTypes = [DND_MIME];
  readonly dragMimeTypes = [DND_MIME];

  /** Rebuilt on refresh; `childRows` needs it synchronously. */
  private ctx: TreeContext | undefined;
  private readonly watches = new Map<string, vscode.Disposable>();

  constructor(private readonly deps: BranchHubDeps) {
    this.rewatch();
  }

  /** The repository that opens first — the Repositories section's pick. */
  repo(): RepoHandle | undefined {
    const root = this.deps.scope.current;
    return root === undefined ? undefined : this.deps.core.getRepo(root);
  }

  private rewatch(): void {
    const live = new Set(this.deps.core.repos.map((r) => r.root));
    for (const [root, sub] of [...this.watches]) {
      if (live.has(root)) continue;
      sub.dispose();
      this.watches.delete(root);
    }
    for (const repo of this.deps.core.repos) {
      if (this.watches.has(repo.root)) continue;
      const refsSub = repo.model.onDidChange((sections) => {
        if (sections.has('refs') || sections.has('head')) this.refresh();
      });
      const favSub = this.deps.refServiceFor(repo).onDidChangeFavorites(() => this.refresh());
      this.watches.set(repo.root, {
        dispose: () => {
          refsSub.dispose();
          favSub.dispose();
        },
      });
    }
  }

  refresh(): void {
    this.ctx = undefined;
    this.rewatch();
    this._onDidChange.fire();
  }

  private async repoRefs(repo: RepoHandle): Promise<RepoRefs> {
    const service = this.deps.refServiceFor(repo);
    const snap = repo.model.snapshot;
    const favorites = await service.getFavorites();
    return {
      root: repo.root,
      name: this.deps.scope.label(repo.root) || path.basename(repo.root),
      ...(snap.headRef !== undefined ? { currentBranch: snap.headRef } : {}),
      ...(snap.detached ? { detached: true } : {}),
      ...(snap.headSha !== undefined ? { headSha: snap.headSha } : {}),
      ...(snap.ahead !== undefined ? { ahead: snap.ahead } : {}),
      ...(snap.behind !== undefined ? { behind: snap.behind } : {}),
      locals: service.localBranches,
      remotes: service.remoteBranches,
      tags: service.tags,
      favorites,
    };
  }

  private async context(): Promise<TreeContext> {
    if (this.ctx) return this.ctx;
    const repos = await Promise.all(this.deps.core.repos.map((r) => this.repoRefs(r)));
    this.ctx = applyShowTags(
      {
        repos,
        commonLocals: commonRefNames(repos.map((r) => r.locals.map((b) => b.name))),
        commonRemotes: commonRefNames(repos.map((r) => r.remotes.map((b) => b.name))),
        commonTags: commonRefNames(repos.map((r) => r.tags.map((t) => t.name))),
        showInOut: this.deps.showInOut(),
      },
      showTagsSetting(),
    );
    return this.ctx;
  }

  async getChildren(row?: TreeRow): Promise<TreeRow[]> {
    const ctx = await this.context();
    return row === undefined ? rootRows(ctx) : childRows(ctx, row);
  }

  getTreeItem(row: TreeRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, this.collapsibleState(row));
    item.id = row.id;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    const description =
      row.description ??
      shownAccelerator(
        row.verb?.accelerator,
        vscode.workspace.getConfiguration('geet').get<boolean>(INTELLIJ_KEYMAP_SETTING, false),
      );
    if (description !== undefined) item.description = description;
    item.contextValue = this.contextValue(row);
    item.tooltip = this.tooltip(row);
    if (row.verb !== undefined) {
      // A repository's own copy of a verb (the `New Branch…` under an open
      // repository) runs there. The project's verbs take no argument, exactly as
      // the popup runs them, so `geet.commit` spans every root.
      item.command = {
        command: row.verb.command,
        title: row.verb.label,
        ...(row.repoRoot !== undefined ? { arguments: [row.repoRoot] } : {}),
      };
    }
    /**
     * **A branch row carries no command**, so clicking one does nothing: not a
     * checkout, not a menu. It used to open the actions `QuickPick`, and that is
     * the swap being taken off the click gesture everywhere — a menu arriving
     * over the whole window is not what pointing at a row should cost.
     *
     * Here the menu needs no replacement affordance: this is a `TreeView`, so
     * right-click already gives the same actions from `view/item/context`, which
     * is where a tree's menu belongs. The popup and the sidebar, which have no
     * such menu, put it on a `›` button instead.
     */
    return item;
  }

  private collapsibleState(row: TreeRow): vscode.TreeItemCollapsibleState {
    if (!row.expandable) return vscode.TreeItemCollapsibleState.None;
    // What opens on arrival: the repository the Repositories section points at,
    // and its local branches — the list anyone opening this is looking for.
    const focused = this.deps.scope.current;
    if (focused !== undefined) {
      if (row.id === nodeIds.repo(focused) || row.id === nodeIds.locals(focused)) {
        return vscode.TreeItemCollapsibleState.Expanded;
      }
    }
    return vscode.TreeItemCollapsibleState.Collapsed;
  }

  /**
   * Ref rows carry `branchActions.branchContextValue`, which is what all 21
   * `view/item/context` clauses match — the same value the legacy tree emits, so
   * one ref cannot collect two different menus.
   */
  private contextValue(row: TreeRow): string {
    if (row.ref !== undefined) return branchContextValue(row.ref);
    if (row.kind === 'repo') return 'hub:repository';
    if (row.kind === 'common') return `hub:common:${row.common?.kind ?? ''}`;
    if (row.kind === 'verb') return 'hub:verb';
    return 'hub:group';
  }

  private tooltip(row: TreeRow): vscode.MarkdownString | string | undefined {
    if (row.ref === undefined) return row.kind === 'repo' ? row.repoRoot : undefined;
    const ref = row.ref;
    const lines = [`\`${ref.name}\``];
    if (ref.subject !== undefined) lines.push(ref.subject);
    if (ref.upstream !== undefined) lines.push(vscode.l10n.t('Tracks {0}', ref.upstream));
    lines.push(ref.sha.slice(0, 7));
    return new vscode.MarkdownString(lines.join('\n\n'));
  }

  // ---- Drag & drop ---------------------------------------------------------
  // The same gesture the legacy tree has, dispatched through that tree's own
  // handler rather than a second copy of the merge/rebase/compare menu.

  handleDrag(source: readonly TreeRow[], dataTransfer: vscode.DataTransfer): void {
    const row = source.find((r) => r.ref?.type === 'head');
    if (!row?.ref || row.repoRoot === undefined) return;
    dataTransfer.set(
      DND_MIME,
      new vscode.DataTransferItem(JSON.stringify({ repo: row.repoRoot, name: row.ref.name })),
    );
  }

  async handleDrop(target: TreeRow | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    if (target?.ref?.type !== 'head' || target.repoRoot === undefined) return;
    const raw = await dataTransfer.get(DND_MIME)?.asString();
    if (raw === undefined) return;
    const { repo: sourceRoot, name } = JSON.parse(raw) as { repo: string; name: string };
    // Refuse a cross-repository drop rather than merging a same-named branch
    // from somewhere else, which is what the two roots would silently do.
    if (sourceRoot !== target.repoRoot || name === target.ref.name) return;
    const repo = this.deps.core.getRepo(target.repoRoot);
    if (repo) await this.deps.onDrop(repo, name, target.ref.name);
  }

  dispose(): void {
    for (const sub of this.watches.values()) sub.dispose();
    this.watches.clear();
    this._onDidChange.dispose();
  }
}
