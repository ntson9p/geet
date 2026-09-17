/**
 * Branches view (POST-P14u): the branches popup, standing open, scoped to the
 * repository the Repositories section above it is focused on.
 *
 * It replaces what `gittree.branches` used to draw — an all-repositories tree
 * with no verbs, no favourites-first ordering and no recents, which in a
 * seven-root workspace opened as seven identical `Local / origin / Tags`
 * subtrees. The legacy tree is not deleted; it moved to `gittree.branchesLegacy`
 * behind `gittree.sidebar.extraViews`.
 *
 * Three things are deliberately shared rather than re-stated, because three
 * surfaces of one registry drifting is POST-P14d:
 *
 *   - the sections and their order come from `branchHubModel.hubSections`,
 *     lifted out of the popup's own `buildPopupItems`;
 *   - the `Actions` rows are literally `HUB_VERBS`, the popup's list, each row
 *     carrying the focused root so a verb cannot act on a repository other than
 *     the one this view names;
 *   - every row's `contextValue` comes from `branchActions.branchContextValue`,
 *     so the existing `view/item/context` menus serve this view unchanged.
 *
 * Rows do not check out on click. A single click is how a tree is *selected*,
 * and a checkout is not what anyone means by selecting a row; the inline ✓ and
 * the context menu are the two ways to run one, as they were in the tree this
 * replaces.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import { branchContextValue } from './branchActions';
import { HUB_VERBS, type HubVerb } from './branchesPopup';
import { hubLevel, hubSections, type HubSection, type HubSectionKind } from './branchHubModel';
import type { RefService } from './refService';
import type { RepoScope } from './repoScope';

export type HubNode =
  | { kind: 'actions' }
  | { kind: 'verb'; verb: HubVerb }
  | { kind: 'section'; id: string }
  | { kind: 'folder'; sectionId: string; prefix: string; name: string; count: number }
  /**
   * `label` is the name minus the folder prefix it is shown under. `repo` is
   * carried rather than read from the scope at dispatch time for two reasons:
   * `register.ts`'s `branchArg` already destructures exactly `{ repo, ref }`
   * from the legacy tree's nodes, so every existing `gittree.branches.*` and
   * `gittree.branch.*` command serves this view with no adapter; and a row
   * clicked after focus moved still acts on the repository whose menu was built.
   */
  | {
      kind: 'branch';
      repo: RepoHandle;
      ref: RefInfo;
      sectionKind: HubSectionKind;
      label: string;
    };

const DND_MIME = 'application/vnd.code.tree.gittree.branches';

/** Where a section's folder nesting starts. Remote refs carry their remote. */
function basePrefix(section: HubSection): string {
  return section.kind === 'remote' ? `${section.remote ?? ''}/` : '';
}

function sectionLabel(section: HubSection): string {
  switch (section.kind) {
    case 'current':
      return vscode.l10n.t('Current');
    case 'favorites':
      return vscode.l10n.t('Favorites');
    case 'recent':
      return vscode.l10n.t('Recent');
    case 'local':
      return vscode.l10n.t('Local');
    case 'tags':
      return vscode.l10n.t('Tags');
    case 'remote':
      return vscode.l10n.t('Remote: {0}', section.remote ?? '');
  }
}

function sectionIcon(section: HubSection): string {
  switch (section.kind) {
    case 'current':
      return 'check';
    case 'favorites':
      return 'star-full';
    case 'recent':
      return 'history';
    case 'local':
      return 'git-branch';
    case 'tags':
      return 'tag';
    case 'remote':
      return 'cloud';
  }
}

function refIcon(kind: HubSectionKind, ref: RefInfo): string {
  if (ref.isHead === true) return 'check';
  if (ref.type === 'tag') return 'tag';
  if (ref.type === 'remote') return 'cloud';
  if (kind === 'favorites') return 'star-full';
  return kind === 'recent' ? 'history' : 'git-branch';
}

/** `↑2 ↓1 · gone · 1a2b3c4 · subject` — the popup's own row description. */
function trackDescription(ref: RefInfo, showInOut: boolean): string {
  const parts: string[] = [];
  if (showInOut) {
    if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
    if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
  } else {
    if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
    if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
  }
  if (ref.upstreamGone === true) parts.push(vscode.l10n.t('upstream gone'));
  parts.push(ref.sha.slice(0, 7));
  if (ref.subject !== undefined) parts.push(ref.subject);
  return parts.join(' · ');
}

export interface BranchHubDeps {
  readonly core: Core;
  readonly scope: RepoScope;
  readonly refServiceFor: (repo: RepoHandle) => RefService;
  readonly showInOut: () => boolean;
  /** The legacy tree's drop handler, reused so the gesture has one implementation. */
  readonly onDrop: (repo: RepoHandle, source: string, target: string) => Promise<void>;
}

export class BranchHubViewProvider
  implements vscode.TreeDataProvider<HubNode>, vscode.TreeDragAndDropController<HubNode>
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  readonly dropMimeTypes = [DND_MIME];
  readonly dragMimeTypes = [DND_MIME];

  /** Rebuilt on every `getChildren(undefined)`; folder nodes resolve through it. */
  private sections = new Map<string, HubSection>();
  private readonly watches = new Map<string, vscode.Disposable>();

  constructor(private readonly deps: BranchHubDeps) {
    this.rewatch();
  }

  /** The focused repository, or undefined when the workspace has none. */
  repo(): RepoHandle | undefined {
    const root = this.deps.scope.current;
    return root === undefined ? undefined : this.deps.core.getRepo(root);
  }

  /**
   * Only the focused repository's refs can change this view, but focus moves,
   * so every repository is watched and the listener filters. Watching one and
   * re-subscribing on focus change would leave a window where a ref update in
   * the newly focused repository arrived before its subscription did.
   */
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
        if (!sections.has('refs') && !sections.has('head')) return;
        if (this.repo()?.root === repo.root) this.refresh();
      });
      const favSub = this.deps.refServiceFor(repo).onDidChangeFavorites(() => {
        if (this.repo()?.root === repo.root) this.refresh();
      });
      this.watches.set(repo.root, {
        dispose: () => {
          refsSub.dispose();
          favSub.dispose();
        },
      });
    }
  }

  refresh(): void {
    this.rewatch();
    this._onDidChange.fire();
  }

  async getChildren(node?: HubNode): Promise<HubNode[]> {
    const repo = this.repo();
    if (!repo) return [];
    if (node === undefined) return this.rootChildren(repo);
    switch (node.kind) {
      case 'actions':
        return HUB_VERBS.map((verb) => ({ kind: 'verb', verb }));
      case 'section': {
        const section = this.sections.get(node.id);
        if (!section) return [];
        return this.levelChildren(repo, section, basePrefix(section));
      }
      case 'folder': {
        const section = this.sections.get(node.sectionId);
        if (!section) return [];
        return this.levelChildren(repo, section, node.prefix);
      }
      case 'verb':
      case 'branch':
        return [];
    }
  }

  private async rootChildren(repo: RepoHandle): Promise<HubNode[]> {
    const service = this.deps.refServiceFor(repo);
    // Preloaded so `getTreeItem` stays synchronous, the way `branchesView` does.
    const [recent, favorites] = await Promise.all([
      service.getRecentBranches(),
      service.getFavorites(),
    ]);
    const sections = hubSections({
      current: service.currentBranch,
      locals: service.localBranches,
      remotes: service.remoteBranches,
      tags: service.tags,
      recent,
      favorites,
    });
    this.sections = new Map(sections.map((s) => [s.id, s]));
    return [{ kind: 'actions' }, ...sections.map((s): HubNode => ({ kind: 'section', id: s.id }))];
  }

  private levelChildren(repo: RepoHandle, section: HubSection, prefix: string): HubNode[] {
    const level = hubLevel(section.refs, prefix, section.flat);
    return [
      ...level.folders.map(
        (f): HubNode => ({
          kind: 'folder',
          sectionId: section.id,
          prefix: f.prefix,
          name: f.name,
          count: f.count,
        }),
      ),
      ...level.refs.map(
        (ref): HubNode => ({
          kind: 'branch',
          repo,
          ref,
          sectionKind: section.kind,
          // A flat section shows the whole name — `feature/x` pinned as a
          // favourite must not render as a bare `x` beside an unrelated `x`.
          label: section.flat ? ref.name : ref.name.slice(prefix.length),
        }),
      ),
    ];
  }

  getTreeItem(node: HubNode): vscode.TreeItem {
    switch (node.kind) {
      case 'actions': {
        const item = new vscode.TreeItem(
          vscode.l10n.t('Actions'),
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.iconPath = new vscode.ThemeIcon('zap');
        item.contextValue = 'hub:actions';
        return item;
      }
      case 'verb': {
        const item = new vscode.TreeItem(
          node.verb.label,
          vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon(node.verb.icon);
        if (node.verb.accelerator !== undefined) item.description = node.verb.accelerator;
        item.contextValue = 'hub:verb';
        // The root travels with the row. A title-bar button cannot carry one,
        // which is why the verbs are rows: a view that names a repository must
        // not run its own verbs against whichever one the editor happens to be in.
        item.command = {
          command: node.verb.command,
          title: node.verb.label,
          arguments: [this.deps.scope.current],
        };
        return item;
      }
      case 'section': {
        const section = this.sections.get(node.id);
        if (!section) return new vscode.TreeItem('');
        // Remotes and tags are the long ones and start closed; the short
        // curated sections and Local are what someone opened this view for.
        const startsClosed = section.kind === 'remote' || section.kind === 'tags';
        const item = new vscode.TreeItem(
          sectionLabel(section),
          startsClosed
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(sectionIcon(section));
        item.description = String(section.refs.length);
        item.contextValue = `hub:section:${section.kind}`;
        return item;
      }
      case 'folder': {
        const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.description = vscode.l10n.t('{0} branches', node.count);
        item.contextValue = 'hub:folder';
        return item;
      }
      case 'branch': {
        const ref = node.ref;
        const shown = node.label.length > 0 ? node.label : ref.name;
        const label: vscode.TreeItemLabel = {
          label: shown,
          highlights: ref.isHead === true ? [[0, shown.length]] : [],
        };
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.description = trackDescription(ref, this.deps.showInOut());
        item.tooltip = new vscode.MarkdownString(
          `\`${ref.name}\`\n\n${ref.subject ?? ''}${
            ref.upstream !== undefined ? `\n\n${vscode.l10n.t('Tracks {0}', ref.upstream)}` : ''
          }`,
        );
        item.iconPath = new vscode.ThemeIcon(refIcon(node.sectionKind, ref));
        item.contextValue = branchContextValue(ref);
        return item;
      }
    }
  }

  // ---- Drag & drop ---------------------------------------------------------
  // The same gesture the legacy tree has, dispatched through that tree's own
  // handler rather than a second copy of the merge/rebase/compare menu.

  handleDrag(source: readonly HubNode[], dataTransfer: vscode.DataTransfer): void {
    const node = source.find((n) => n.kind === 'branch');
    if (node?.kind !== 'branch' || node.ref.type !== 'head') return;
    dataTransfer.set(DND_MIME, new vscode.DataTransferItem(JSON.stringify({ name: node.ref.name })));
  }

  async handleDrop(target: HubNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const repo = this.repo();
    if (!repo || target?.kind !== 'branch' || target.ref.type !== 'head') return;
    const raw = await dataTransfer.get(DND_MIME)?.asString();
    if (raw === undefined) return;
    const { name } = JSON.parse(raw) as { name: string };
    if (name === target.ref.name) return;
    await this.deps.onDrop(repo, name, target.ref.name);
  }

  dispose(): void {
    for (const sub of this.watches.values()) sub.dispose();
    this.watches.clear();
    this._onDidChange.dispose();
  }
}
