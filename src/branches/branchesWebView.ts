/**
 * Branches sidebar view, as a webview (new-way-2).
 *
 * It replaces the `TreeView` that drew the same rows. The reason is narrow and
 * worth stating, because a webview is otherwise the wrong default: a `TreeView`
 * cannot hold an `<input>`, and IntelliJ's branch UI has **two search fields
 * live at once** — one for the project, one for the repository you opened. That
 * is not a nicety; with 400 refs in a repository it is the difference between a
 * list you can use and one you cannot. A webview can also draw a real cascading
 * `›` menu over its own rows, which is the other thing IntelliJ does and a tree
 * row cannot.
 *
 * **The host owns the shape.** Expansion, both queries and the rows themselves
 * are computed here by `popupTree`, the very functions the popup flattens, and
 * pushed over. The webview renders and reports gestures; it decides nothing
 * about what the tree contains, so the two surfaces cannot drift.
 *
 * Every action still runs through `branchActions` and the `gittree.*` commands,
 * so the menus here, the popup's `›` menu and the legacy tree's right-click
 * menu are one implementation — POST-P14d's lesson, which is the standing risk
 * whenever a surface is added.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { repoLabels } from '../core/util/repoLabels';
import {
  BRANCHES_METHODS,
  type BranchesActionDto,
  type BranchesTreeDto,
} from '../shared/protocol';
import { buildWebviewHtml, webviewResourceRoots, WebviewRpcHost } from '../ui/webviewHost';
import {
  applicableBranchActions,
  type BranchAction,
  type BranchActionContext,
} from './branchActions';
import { refTypeOf } from './branchesPopup';
import {
  applyShowTags,
  buildSidebarRows,
  commonRefNames,
  nodeIds,
  type RepoRefs,
  type TreeContext,
  type TreeRow,
} from './popupTree';
import type { RefService } from './refService';
import type { RepoScope } from './repoScope';
import { showTagsSetting } from './showTags';

export interface BranchesWebViewDeps {
  readonly core: Core;
  readonly scope: RepoScope;
  readonly context: vscode.ExtensionContext;
  readonly refServiceFor: (repo: RepoHandle) => RefService;
  readonly actions: readonly BranchAction[];
}

export class BranchesWebViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'gittree.branches';

  private view: vscode.WebviewView | undefined;
  private rpc: WebviewRpcHost | undefined;
  private readonly watches = new Map<string, vscode.Disposable>();

  // ---- the state the rows are built from ----------------------------------
  private readonly expanded = new Set<string>();
  private topQuery = '';
  private readonly repoQueries = new Map<string, string>();
  private readonly searchCollapsed = new Set<string>();
  /** Rows of the last push, so a gesture can be resolved back to its row. */
  private rows: readonly TreeRow[] = [];
  private seeded = false;

  constructor(private readonly deps: BranchesWebViewDeps) {
    this.rewatch();
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
    this.rewatch();
    void this.push();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: webviewResourceRoots(this.deps.context.extensionUri),
    };
    view.webview.html = buildWebviewHtml({
      app: 'branches',
      webview: view.webview,
      extensionUri: this.deps.context.extensionUri,
      title: vscode.l10n.t('Branches'),
    });

    const rpc = new WebviewRpcHost(view.webview, (l) =>
      this.deps.core.output.appendLine(`[branches] ${l}`),
    );
    this.rpc = rpc;
    this.wire(rpc);

    view.onDidDispose(() => {
      rpc.dispose();
      this.rpc = undefined;
      this.view = undefined;
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        rpc.rehydrate();
        void this.push();
      }
    });
  }

  // ---- state -------------------------------------------------------------

  /**
   * What is open the first time the view paints: the repository the
   * Repositories section points at, and its local branches. Seeded once, so a
   * later focus change never reaches in and reopens what the user closed.
   */
  private seed(): void {
    if (this.seeded) return;
    this.seeded = true;
    const root = this.deps.scope.current;
    if (root === undefined) return;
    if (this.deps.core.repos.length > 1) this.expanded.add(nodeIds.repo(root));
    this.expanded.add(nodeIds.locals(root));
  }

  private async repoRefs(repo: RepoHandle, labels: Map<string, string>): Promise<RepoRefs> {
    const service = this.deps.refServiceFor(repo);
    const snap = repo.model.snapshot;
    const favorites = await service.getFavorites();
    return {
      root: repo.root,
      name: labels.get(repo.root) ?? repo.root,
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

  private showInOut(): boolean {
    return vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('branches.showIncomingOutgoing', true);
  }

  private async context(): Promise<TreeContext> {
    const labels = repoLabels(this.deps.core.repos.map((r) => r.root));
    const repos = await Promise.all(this.deps.core.repos.map((r) => this.repoRefs(r, labels)));
    return applyShowTags(
      {
        repos,
        commonLocals: commonRefNames(repos.map((r) => r.locals.map((b) => b.name))),
        commonRemotes: commonRefNames(repos.map((r) => r.remotes.map((b) => b.name))),
        commonTags: commonRefNames(repos.map((r) => r.tags.map((t) => t.name))),
        showInOut: this.showInOut(),
      },
      showTagsSetting(),
    );
  }

  /**
   * `generation` drops a build whose favourites resolved after a newer one
   * started: typing starts several, and the last to *finish* is not necessarily
   * the one that matches what is in the field.
   */
  private generation = 0;
  private async tree(): Promise<BranchesTreeDto | undefined> {
    const mine = ++this.generation;
    this.seed();
    const ctx = await this.context();
    if (mine !== this.generation) return undefined;
    const built = buildSidebarRows(ctx, {
      expanded: this.expanded,
      topQuery: this.topQuery,
      repoQueries: this.repoQueries,
      searchCollapsed: this.searchCollapsed,
    });
    this.rows = built.rows;
    return {
      rows: built.rows,
      open: [...built.open],
      topQuery: this.topQuery,
      repoQueries: [...this.repoQueries].filter(([, q]) => q.length > 0),
      repoCount: ctx.repos.length,
      showInOut: ctx.showInOut,
    };
  }

  private async push(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || this.view?.visible !== true) return;
    const dto = await this.tree();
    if (dto) rpc.notify(BRANCHES_METHODS.evtTree, dto);
  }

  // ---- gestures ----------------------------------------------------------

  private rowById(id: unknown): TreeRow | undefined {
    return typeof id === 'string' ? this.rows.find((r) => r.id === id) : undefined;
  }

  private repoOf(row: TreeRow): RepoHandle | undefined {
    return row.repoRoot === undefined ? undefined : this.deps.core.getRepo(row.repoRoot);
  }

  private contextFor(row: TreeRow): BranchActionContext | undefined {
    const repo = this.repoOf(row);
    if (!repo || !row.ref) return undefined;
    return {
      repo,
      name: row.ref.name,
      type: refTypeOf(row.ref),
      isCurrent: row.ref.isHead === true,
    };
  }

  /** Whether a search is live over `row` — which decides which set a toggle writes to. */
  private searchingOver(row: TreeRow): boolean {
    if (this.topQuery.trim().length > 0) return true;
    if (row.repoRoot === undefined) return false;
    return (this.repoQueries.get(row.repoRoot) ?? '').trim().length > 0;
  }

  private wire(rpc: WebviewRpcHost): void {
    rpc.on(BRANCHES_METHODS.init, async () => (await this.tree()) ?? null);

    rpc.on(BRANCHES_METHODS.toggle, async (params) => {
      const row = this.rowById((params as { id?: unknown } | undefined)?.id);
      if (!row?.expandable) return null;
      // A node shut inside search results is remembered separately, so clearing
      // the query never leaves the unfiltered tree rearranged behind your back.
      const set = this.searchingOver(row) ? this.searchCollapsed : this.expanded;
      if (set.has(row.id)) set.delete(row.id);
      else set.add(row.id);
      return (await this.tree()) ?? null;
    });

    rpc.on(BRANCHES_METHODS.setTopQuery, async (params) => {
      const raw = (params as { query?: unknown } | undefined)?.query;
      this.topQuery = typeof raw === 'string' ? raw : '';
      this.searchCollapsed.clear();
      return (await this.tree()) ?? null;
    });

    rpc.on(BRANCHES_METHODS.setRepoQuery, async (params) => {
      const p = params as { root?: unknown; query?: unknown } | undefined;
      if (typeof p?.root !== 'string') return null;
      const query = typeof p.query === 'string' ? p.query : '';
      if (query.length > 0) this.repoQueries.set(p.root, query);
      else this.repoQueries.delete(p.root);
      this.searchCollapsed.clear();
      return (await this.tree()) ?? null;
    });

    rpc.on(BRANCHES_METHODS.toggleFavorite, async (params) => {
      const row = this.rowById((params as { id?: unknown } | undefined)?.id);
      const repo = row ? this.repoOf(row) : undefined;
      if (!row?.ref || !repo) return null;
      await this.deps.refServiceFor(repo).toggleFavorite(row.ref.name);
      return (await this.tree()) ?? null;
    });

    /**
     * The `›` menu, built from the shared registry for this exact ref. It is
     * requested rather than pushed with the rows because the labels interpolate
     * live branch names and the applicable set depends on the snapshot at the
     * moment the menu opens, not at the moment the tree was drawn.
     */
    rpc.on(BRANCHES_METHODS.actions, (params) => {
      const row = this.rowById((params as { id?: unknown } | undefined)?.id);
      if (!row) return [];
      const ctx = this.contextFor(row);
      if (!ctx) return [];
      const head = ctx.repo.model.snapshot.headRef;
      const out: BranchesActionDto[] = [];
      let lastGroup: string | undefined;
      for (const action of applicableBranchActions(this.deps.actions, ctx)) {
        const group = action.group ?? 'manage';
        out.push({
          id: action.id,
          label: action.label(ctx, head),
          ...(action.accelerator !== undefined ? { accelerator: action.accelerator } : {}),
          ...(lastGroup !== undefined && group !== lastGroup ? { separator: true } : {}),
        });
        lastGroup = group;
      }
      return out;
    });

    rpc.on(BRANCHES_METHODS.runAction, async (params) => {
      const p = params as { id?: unknown; action?: unknown } | undefined;
      const row = this.rowById(p?.id);
      const ctx = row ? this.contextFor(row) : undefined;
      if (!ctx || typeof p?.action !== 'string') return null;
      const action = this.deps.actions.find((a) => a.id === p.action);
      if (!action || !action.applies(ctx)) return null;
      await action.run(ctx);
      return null;
    });

    /**
     * Verbs, and a common ref's all-roots menu. **A branch row never arrives
     * here**: a click on one does nothing and Enter opens the `›` menu in the
     * view, which asks for `actions` instead. The gesture is the view's to
     * judge — the host cannot see whether a click or a key caused this — so the
     * rule lives there and this handler only needs to not grow a ref branch.
     */
    rpc.on(BRANCHES_METHODS.activate, async (params) => {
      const row = this.rowById((params as { id?: unknown } | undefined)?.id);
      if (!row) return null;
      if (row.verb !== undefined) {
        // A repository's own copy of a verb runs there; the project's take no
        // argument, so `gittree.commit` spans every root.
        if (row.repoRoot !== undefined) {
          await vscode.commands.executeCommand(row.verb.command, row.repoRoot);
        } else {
          await vscode.commands.executeCommand(row.verb.command);
        }
        return null;
      }
      if (row.common !== undefined) {
        await vscode.commands.executeCommand(
          'gittree.branches.showCommonActions',
          row.common.name,
          row.common.kind,
        );
      }
      return null;
    });

    rpc.on(BRANCHES_METHODS.header, async (params) => {
      const raw = (params as { id?: unknown } | undefined)?.id;
      const what = typeof raw === 'string' ? raw : '';
      if (what === 'fetch') {
        // No argument: every root, exactly as IntelliJ's popup Fetch does.
        await vscode.commands.executeCommand('gittree.fetch');
      } else if (what === 'collapse') {
        this.expanded.clear();
        this.searchCollapsed.clear();
      } else if (what === 'inout') {
        await vscode.workspace
          .getConfiguration('gittree')
          .update(
            'branches.showIncomingOutgoing',
            !this.showInOut(),
            vscode.ConfigurationTarget.Workspace,
          );
      } else if (what === 'settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gittree.branches');
      }
      return (await this.tree()) ?? null;
    });
  }

  /** The repository the Repositories section points at, for the title strip. */
  repo(): RepoHandle | undefined {
    const root = this.deps.scope.current;
    return root === undefined ? undefined : this.deps.core.getRepo(root);
  }

  /** Opens a repository and reveals it — how the Repositories section drives this view. */
  revealRepository(root: string): void {
    const match = this.deps.core.repos.find((r) => canonicalKey(r.root) === canonicalKey(root));
    if (!match) return;
    this.expanded.add(nodeIds.repo(match.root));
    void this.push();
  }

  dispose(): void {
    for (const sub of this.watches.values()) sub.dispose();
    this.watches.clear();
  }
}
