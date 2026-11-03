/**
 * Phase 2 registration: RefService per repo, Branches popup (replaces the
 * P1 stub over the same command id), branch op commands, Branches TreeView,
 * Compare view.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { setBranchesOpenHandler } from '../scm/syncOps';
import { createBranchActions, findBranchAction, type BranchAction } from './branchActions';
import { BranchOps } from './branchOps';
import {
  refTypeOf,
  runCommonAction,
  showBranchActions,
  showBranchesPopup,
  showCommonBranchActions,
} from './branchesPopup';
import type { CommonRef, TreeRow } from './popupTree';
import { cleanUpBranches } from './branchCleanup';
import { lastLocalChangesQuestion, pickAndCheckoutAcross } from './checkoutAcross';
import { reposOf } from './panelActions';
import { BranchPanelProvider } from './branchPanel';
import { BranchHubViewProvider } from './branchHubView';
import { BranchesViewProvider, type BranchNode } from './branchesView';
import { CompareService } from './compare';
import { RefService, type FavoritesStorage } from './refService';
import { RepoScope } from './repoScope';
import { RepositoriesViewProvider } from './repositoriesView';

const SCOPE_MEMENTO_KEY = 'gittree.sidebar.focusedRepo';

export interface Phase02Registry {
  refServices: Map<string, RefService>;
  ops: BranchOps;
  viewProvider: BranchesViewProvider;
  compare: CompareService;
  /** POST-P14u: which repository the sidebar's two sections are showing. */
  scope: RepoScope;
  repositories: RepositoriesViewProvider;
  /** Exposed so an integration test can drive the real view, not just the provider. */
  reposView: vscode.TreeView<string>;
  hub: BranchHubViewProvider;
  /** new-way-4: the sidebar's Repositories panel (`gittree.branches`). */
  panel: BranchPanelProvider;
  /**
   * P13-T5: the single branch-action registry the popup, the branches tree and
   * the log's Branches pane all consume, so the three cannot drift.
   */
  actions: BranchAction[];
  /**
   * POST-P14ap: an all-repositories branch action, run by the extension's own
   * module — a test importing `runCommonAction` gets a second copy of the
   * notification module, so it could not see what the run said.
   */
  runCommonAction: (repos: readonly RepoHandle[], common: CommonRef, actionId: string) => Promise<void>;
  /** POST-P14ax: what the one local-changes question of a checkout across repositories last said. */
  lastLocalChangesQuestion: typeof lastLocalChangesQuestion;
}

export function registerPhase02(context: vscode.ExtensionContext, core: Core): Phase02Registry {
  const storage: FavoritesStorage = {
    get: (key) => context.globalState.get<string[]>(key),
    update: async (key, value) => {
      await context.globalState.update(key, [...value]);
    },
  };
  const refServices = new Map<string, RefService>();
  const serviceFor = (repo: RepoHandle): RefService => {
    const key = canonicalKey(repo.root);
    let service = refServices.get(key);
    if (!service) {
      service = new RefService(repo, storage, () =>
        vscode.workspace.getConfiguration('gittree').get<number>('branches.recentCount', 5),
      );
      refServices.set(key, service);
      repo.disposables.add(service);
      repo.disposables.add({ dispose: () => refServices.delete(key) });
    }
    return service;
  };
  for (const repo of core.repos) serviceFor(repo);
  const addSub = core.onDidAddRepo((repo) => void serviceFor(repo));
  context.subscriptions.push(new vscode.Disposable(() => addSub.dispose()));

  const ops = new BranchOps(core);

  const pickRepo = (repoRoot?: unknown): RepoHandle | undefined => {
    if (typeof repoRoot === 'string') return core.getRepo(repoRoot);
    const uri = vscode.window.activeTextEditor?.document.uri;
    return (uri && core.repoForUri(uri)) ?? core.repos[0];
  };

  const actions: BranchAction[] = createBranchActions({
    ops,
    refServiceFor: serviceFor,
    // How the popup's `Tracked Branch 'origin/x'…` row drills in: the upstream
    // gets the very same action list, built from this very same registry, so
    // the two rows can never come to disagree about what a remote ref affords.
    showActionsFor: async (repo, refName) => {
      const ref = repo.model.snapshot.refs.find((r) => r.name === refName);
      if (!ref) return;
      await showBranchActions(core, repo, ops, ref, actions);
    },
  });

  // The real Branches popup replaces the P1 stub (same command id).
  // POST-P14p: the root passed here is the *entry* repository, not the scope —
  // with more than one root the popup opens at the project level and only
  // starts with that repository's row selected.
  setBranchesOpenHandler(async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    await showBranchesPopup(core, repo, serviceFor, ops, actions);
  });

  // ---- POST-P14u: the sidebar's repository scope, and the Repositories view -
  const scope = new RepoScope({
    get: () => context.workspaceState.get<string>(SCOPE_MEMENTO_KEY),
    set: (value) => void context.workspaceState.update(SCOPE_MEMENTO_KEY, value),
  });
  scope.setRoots(core.repos.map((r) => r.root));
  context.subscriptions.push({ dispose: () => scope.dispose() });

  const repositories = new RepositoriesViewProvider(core, scope, () =>
    vscode.workspace
      .getConfiguration('gittree')
      .get<boolean>('branches.showIncomingOutgoing', true),
  );
  context.subscriptions.push({ dispose: () => repositories.dispose() });

  const reposView = vscode.window.createTreeView('gittree.repositories', {
    treeDataProvider: repositories,
  });
  context.subscriptions.push(reposView);

  /**
   * The focused row stays *selected*, which is where its background comes
   * from — a `TreeItem` cannot colour itself. `focus: false` because the
   * selection is a statement about the list, not a request for the keyboard.
   */
  const syncSelection = (): void => {
    const current = scope.current;
    if (current === undefined || !reposView.visible) return;
    void reposView.reveal(current, { select: true, focus: false }).then(undefined, () => undefined);
  };
  const paintRepositories = (): void => {
    // The section exists only where it means something. A single-root
    // workspace has nothing to choose between, and the Branches view below
    // names its repository anyway.
    void vscode.commands.executeCommand('setContext', 'gittree.multiRepo', core.repos.length > 1);
    // `REPOSITORIES  7` — the section is collapsed by default, so the count is
    // the only thing it says until someone opens it.
    reposView.description = core.repos.length > 1 ? String(core.repos.length) : undefined;
    repositories.refresh();
    syncSelection();
  };
  paintRepositories();
  const onRoots = (): void => {
    scope.setRoots(core.repos.map((r) => r.root));
    paintRepositories();
  };
  const joinSub = core.onDidAddRepo(onRoots);
  const leaveSub = core.onDidRemoveRepo(onRoots);
  const scopeSub = scope.onDidChange(() => {
    repositories.refresh();
    syncSelection();
  });
  context.subscriptions.push(
    new vscode.Disposable(() => joinSub.dispose()),
    new vscode.Disposable(() => leaveSub.dispose()),
    new vscode.Disposable(() => scopeSub.dispose()),
    reposView.onDidChangeVisibility(() => syncSelection()),
    /**
     * `select`, not `focus`: VS Code auto-registers `<viewId>.focus` for every
     * contributed view, so `gittree.repositories.focus` is already taken by the
     * command that reveals this very section — the one the branches popup's
     * last header button uses for `gittree.branches`. Squatting on it would
     * shadow one of the two depending on which registry answered first.
     */
    vscode.commands.registerCommand('gittree.repositories.select', (arg?: unknown) => {
      const root =
        typeof arg === 'string'
          ? arg
          : typeof arg === 'object' && arg !== null && 'root' in arg
            ? String(arg.root)
            : undefined;
      if (root !== undefined) scope.focus(root);
    }),
  );

  /**
   * The legacy Branches tree, under its own id and gated on
   * `gittree.sidebar.extraViews`. POST-P14u replaced what `gittree.branches`
   * draws; this keeps the all-repositories tree one setting away, and keeps the
   * provider constructed unconditionally because `phase02` and
   * `phase14branchmenu` assert against it directly.
   */
  const viewProvider = new BranchesViewProvider(core, serviceFor, ops);
  const view = vscode.window.createTreeView('gittree.branchesLegacy', {
    treeDataProvider: viewProvider,
    dragAndDropController: viewProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  // ---- The Branches view proper --------------------------------------------
  const hub = new BranchHubViewProvider({
    core,
    scope,
    refServiceFor: serviceFor,
    showInOut: () =>
      vscode.workspace
        .getConfiguration('gittree')
        .get<boolean>('branches.showIncomingOutgoing', true),
    // The legacy tree's own drop handler: one merge/rebase/compare prompt.
    onDrop: (repo, source, target) => viewProvider.showDropActions(repo, source, target),
  });
  context.subscriptions.push({ dispose: () => hub.dispose() });

  const hubView = vscode.window.createTreeView('gittree.branchesTree', {
    treeDataProvider: hub,
    dragAndDropController: hub,
    showCollapseAll: true,
  });
  context.subscriptions.push(hubView);

  /**
   * The Repositories panel (new-way-4; once titled Branches): every repository's
   * status, then its branches under Recent, Local, Remote and Tags tabs, a card
   * per branch with the actions its state calls for. A webview, because what it
   * draws — a branch's card under its row, the repository markers, the inline
   * New Branch form — is more than a tree row can hold. The trees above draw the
   * plain tree, one setting away.
   */
  const panel = new BranchPanelProvider({
    core,
    context,
    refServiceFor: serviceFor,
    actions,
    // The branch trees' own drop prompt, so the gesture has one implementation.
    onDrop: (repo, source, target) => viewProvider.showDropActions(repo, source, target),
  });
  context.subscriptions.push({ dispose: () => panel.dispose() });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(BranchPanelProvider.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('gittree.branches.newBranchInPanel', (from?: unknown, roots?: unknown) =>
      panel.openNewBranchForm(
        typeof from === 'string' ? from : undefined,
        Array.isArray(roots) ? roots.filter((r): r is string => typeof r === 'string') : undefined,
      ),
    ),
    vscode.commands.registerCommand('gittree.branches.filterPanel', () => panel.focusFilter()),
  );

  /**
   * new-way-2: the view is project-level, exactly as the popup is, so its
   * header no longer names one repository — naming one would be a lie about
   * what the tree contains. The scope decides only which repository node opens
   * first, which is what the Repositories section above it is now for.
   */
  const paintHub = (): void => {
    hubView.description = undefined;
    hub.refresh();
  };
  paintHub();
  const hubScopeSub = scope.onDidChange(paintHub);
  // A repository joining or leaving can change whether the name is shown at
  // all (it appears only when there is more than one) without moving the scope.
  const hubJoinSub = core.onDidAddRepo(paintHub);
  const hubLeaveSub = core.onDidRemoveRepo(paintHub);
  context.subscriptions.push(
    new vscode.Disposable(() => hubScopeSub.dispose()),
    new vscode.Disposable(() => hubJoinSub.dispose()),
    new vscode.Disposable(() => hubLeaveSub.dispose()),
    // Show Tags is toggled from the log's Branches pane as often as from the
    // Settings editor, so the sidebar trees cannot wait for the next ref change
    // to drop or regain their Tags node. The popup reads it each time it opens.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gittree.branches.showTags')) return;
      hub.refresh();
    }),
  );

  // Compare view + commands.
  const compare = new CompareService(core);
  compare.register(context);

  // Branch commands (from view context menus and the palette).
  // The two trees hand their menus different elements for the same menu: the
  // legacy tree a `BranchNode`, the hub a `TreeRow`. Accepting only the first
  // left every right-click on the hub doing nothing.
  const branchArg = (node: unknown): { repo: RepoHandle; name: string } | undefined => {
    if (typeof node !== 'object' || node === null || !('kind' in node)) return undefined;
    if (node.kind === 'branch') {
      const b = node as Extract<BranchNode, { kind: 'branch' }>;
      return { repo: b.repo, name: b.ref.name };
    }
    if (node.kind === 'ref') {
      const row = node as TreeRow;
      const repo = row.repoRoot !== undefined ? core.getRepo(row.repoRoot) : undefined;
      if (repo !== undefined && row.ref !== undefined) return { repo, name: row.ref.name };
    }
    return undefined;
  };
  const register = (id: string, fn: (...args: unknown[]) => Promise<void> | void): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('gittree.branches.new', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (repo) await ops.newBranchFrom(repo, 'HEAD');
  });
  register('gittree.branches.checkout', async (node) => {
    const arg = branchArg(node);
    if (!arg) return;
    const isRemote =
      (node as Extract<BranchNode, { kind: 'branch' }>).ref.type === 'remote';
    if (isRemote) await ops.checkoutRemote(arg.repo, arg.name);
    else await ops.checkout(arg.repo, arg.name);
  });
  register('gittree.branches.rename', async (node) => {
    const arg = branchArg(node);
    if (arg) await ops.renameBranch(arg.repo, arg.name);
  });
  register('gittree.branches.delete', async (node) => {
    const arg = branchArg(node);
    if (arg) await ops.deleteBranch(arg.repo, arg.name);
  });
  register('gittree.branches.push', async (node) => {
    const arg = branchArg(node);
    if (arg) await ops.pushBranch(arg.repo, arg.name);
  });
  register('gittree.branches.rebaseOntoCurrent', async (node) => {
    const arg = branchArg(node);
    if (arg) await ops.checkoutAndRebaseOntoCurrent(arg.repo, arg.name);
  });
  register('gittree.branches.newFrom', async (node) => {
    const arg = branchArg(node);
    if (arg) await ops.newBranchFrom(arg.repo, arg.name);
  });
  register('gittree.branches.toggleFavorite', async (node) => {
    const arg = branchArg(node);
    if (!arg) return;
    await serviceFor(arg.repo).toggleFavorite(arg.name);
  });
  register('gittree.branches.compareWithCurrentNode', async (node) => {
    const arg = branchArg(node);
    if (arg) {
      await vscode.commands.executeCommand(
        'gittree.branches.compareWithCurrent',
        arg.repo.root,
        arg.name,
      );
    }
  });
  register('gittree.branches.diffWithWorkingTreeNode', async (node) => {
    const arg = branchArg(node);
    if (arg) {
      await vscode.commands.executeCommand(
        'gittree.branches.diffWithWorkingTree',
        arg.repo.root,
        arg.name,
      );
    }
  });

  // ---- P13-T5: the registry's actions as first-class commands ---------------
  // `Merge 'X' into '<current>'` is the headline: `mergeIntoCurrent` had ONE
  // call site — the tree's drag-and-drop handler — so it was reachable only by
  // dragging. Every registry action now dispatches by id from any surface.
  const runAction = async (id: string, repo: RepoHandle, name: string): Promise<void> => {
    const action = findBranchAction(actions, id);
    if (!action) return;
    const ref = repo.model.snapshot.refs.find((r) => r.name === name);
    const ctx = {
      repo,
      name,
      type: ref !== undefined ? refTypeOf(ref) : ('local' as const),
      isCurrent: repo.model.snapshot.headRef === name,
    };
    if (!action.applies(ctx)) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('"{0}" does not apply to {1}.', action.label(ctx, ctx.repo.model.snapshot.headRef), name),
      );
      return;
    }
    await action.run(ctx);
  };
  /** `(node | repoRoot, name)` — both the tree rows and the palette. */
  const actionArgs = (
    a: unknown,
    b: unknown,
  ): { repo: RepoHandle; name: string } | undefined => {
    const fromNode = branchArg(a);
    if (fromNode) return fromNode;
    const repo = pickRepo(a);
    if (repo && typeof b === 'string' && b.length > 0) return { repo, name: b };
    return undefined;
  };
  const registerAction = (commandId: string, actionId: string): void => {
    register(commandId, async (a, b) => {
      const arg = actionArgs(a, b);
      if (arg) await runAction(actionId, arg.repo, arg.name);
    });
  };
  registerAction('gittree.branch.mergeIntoCurrent', 'mergeIntoCurrent');
  registerAction('gittree.branch.checkoutAndRebase', 'rebaseOntoCurrent');
  registerAction('gittree.branch.rebaseCurrentOnto', 'rebaseCurrentOnto');
  registerAction('gittree.branch.newWorktree', 'newWorktree');
  registerAction('gittree.branch.pullIntoCurrent', 'pullIntoCurrent');
  registerAction('gittree.branch.pullIntoCurrentRebase', 'pullIntoCurrentRebase');
  registerAction('gittree.branch.update', 'update');
  registerAction('gittree.branch.stopTracking', 'stopTracking');
  registerAction('gittree.branch.deleteOnRemote', 'deleteOnRemote');

  // ---- The `Tracked Branch` submenu ----------------------------------------
  // Each row is the corresponding registry action re-aimed at the row's
  // upstream, so nothing here is a second implementation of anything — the
  // rows behave exactly as they do on the remote branch itself, which is what
  // IntelliJ's nested menu promises. The submenu is gated on the `:tracked`
  // contextValue, so an absent upstream normally means an absent menu; the
  // guard below is for the window between a fetch dropping the upstream and
  // the tree redrawing.
  const runTrackedAction = async (
    actionId: string,
    repo: RepoHandle,
    branch: string,
  ): Promise<void> => {
    const ref = repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === branch);
    const upstream = ref?.upstreamGone === true ? undefined : ref?.upstream;
    if (upstream === undefined) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('"{0}" no longer tracks a remote branch.', branch),
      );
      return;
    }
    await runAction(actionId, repo, upstream);
  };
  const registerTracked = (commandId: string, actionId: string): void => {
    register(commandId, async (a, b) => {
      const arg = actionArgs(a, b);
      if (arg) await runTrackedAction(actionId, arg.repo, arg.name);
    });
  };
  registerTracked('gittree.branch.tracked.checkout', 'checkout');
  registerTracked('gittree.branch.tracked.newFrom', 'newFrom');
  registerTracked('gittree.branch.tracked.compareWithCurrent', 'compareWithCurrent');
  registerTracked('gittree.branch.tracked.diffWithWorkingTree', 'diffWithWorkingTree');
  registerTracked('gittree.branch.tracked.pullIntoCurrent', 'pullIntoCurrent');
  registerTracked('gittree.branch.tracked.pullIntoCurrentRebase', 'pullIntoCurrentRebase');
  registerTracked('gittree.branch.tracked.mergeIntoCurrent', 'mergeIntoCurrent');
  registerTracked('gittree.branch.tracked.rebaseCurrentOnto', 'rebaseCurrentOnto');
  registerTracked('gittree.branch.tracked.newWorktree', 'newWorktree');
  registerTracked('gittree.branch.tracked.deleteOnRemote', 'deleteOnRemote');

  /**
   * A branch's own menu, by repository and ref name.
   *
   * **Nothing dispatches this on a click any more** — that was the tree row's
   * command until branch rows were made inert, and the menu is now reached by
   * the `›` button or a right-click. It stays registered because it is the one
   * addressable way in: a keybinding, another view, or a palette entry can open
   * a named branch's menu without owning a row.
   *
   * The ref is re-resolved from the live snapshot on every dispatch, so a call
   * made after a fetch moved the refs underneath it acts on what is there now or
   * does nothing, rather than on a stale copy. `type` disambiguates: a tag and a
   * local branch can carry the same name.
   */
  register('gittree.branches.showActions', async (repoRoot, name, type) => {
    const repo = pickRepo(repoRoot);
    if (!repo || typeof name !== 'string') return;
    const ref = repo.model.snapshot.refs.find(
      (r) => r.name === name && (typeof type !== 'string' || r.type === type),
    );
    if (!ref) return;
    await showBranchActions(core, repo, ops, ref, actions);
  });
  register('gittree.branches.showCommonActions', async (name, kind) => {
    if (typeof name !== 'string') return;
    if (kind !== 'local' && kind !== 'remote' && kind !== 'tag') return;
    await showCommonBranchActions(core, { name, kind }, actions);
  });

  // The hub verbs the popup lists need real command ids of their own.
  register('gittree.branch.new', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (repo) await ops.newBranchFrom(repo, 'HEAD');
  });
  register('gittree.branches.checkoutRevision', async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    const seeded = process.env['GITTREE_TEST_CHECKOUT_REVISION'];
    const value =
      seeded !== undefined && seeded.length > 0
        ? seeded
        : await vscode.window.showInputBox({
            prompt: vscode.l10n.t('Tag, branch or revision to check out'),
            placeHolder: vscode.l10n.t('e.g. v1.2 or 1a2b3c4'),
            ignoreFocusOut: true,
          });
    if (value === undefined || value.trim().length === 0) return;
    await ops.checkout(repo, value.trim());
  });

  // POST-P14ax: one branch checked out in every repository, from a picker of all of them.
  // The panel's `⋯` passes the repositories in view; the palette, every repository.
  register('gittree.branches.checkoutEverywhere', async (roots) => {
    const named =
      typeof roots === 'string'
        ? [roots]
        : Array.isArray(roots)
          ? roots.filter((r): r is string => typeof r === 'string')
          : [];
    const repos = named.length > 0 ? reposOf(core, named) : core.repos;
    await pickAndCheckoutAcross(core, repos);
  });

  // new-way-4: the finished branches — merged, or their remote branch gone — in one pick.
  register('gittree.branches.cleanup', async (root) => {
    await cleanUpBranches(core, typeof root === 'string' ? [root] : undefined);
  });

  const registry: Phase02Registry = {
    refServices,
    ops,
    viewProvider,
    compare,
    scope,
    repositories,
    reposView,
    hub,
    panel,
    actions,
    runCommonAction: (repos, common, actionId) => runCommonAction(repos, common, actions, actionId),
    lastLocalChangesQuestion,
  };
  core.debugRegistry.set('phase02', registry);
  return registry;
}
