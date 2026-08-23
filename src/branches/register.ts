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
import { refTypeOf, showBranchesPopup } from './branchesPopup';
import { BranchesViewProvider, type BranchNode } from './branchesView';
import { CompareService } from './compare';
import { RefService, type FavoritesStorage } from './refService';

export interface Phase02Registry {
  refServices: Map<string, RefService>;
  ops: BranchOps;
  viewProvider: BranchesViewProvider;
  compare: CompareService;
  /**
   * P13-T5: the single branch-action registry the popup, the branches tree and
   * the log's Branches pane all consume, so the three cannot drift.
   */
  actions: BranchAction[];
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

  const actions = createBranchActions({ ops, refServiceFor: serviceFor });

  // The real Branches popup replaces the P1 stub (same command id).
  setBranchesOpenHandler(async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    await showBranchesPopup(core, repo, serviceFor(repo), ops, actions);
  });

  // Branches TreeView + drag-and-drop.
  const viewProvider = new BranchesViewProvider(core, serviceFor, ops);
  const view = vscode.window.createTreeView('gittree.branches', {
    treeDataProvider: viewProvider,
    dragAndDropController: viewProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  // Compare view + commands.
  const compare = new CompareService(core);
  compare.register(context);

  // Branch commands (from view context menus and the palette).
  const branchArg = (node: unknown): { repo: RepoHandle; name: string } | undefined => {
    if (typeof node === 'object' && node !== null && 'kind' in node && node.kind === 'branch') {
      const b = node as Extract<BranchNode, { kind: 'branch' }>;
      return { repo: b.repo, name: b.ref.name };
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
  registerAction('gittree.branch.deleteOnRemote', 'deleteOnRemote');

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

  const registry: Phase02Registry = { refServices, ops, viewProvider, compare, actions };
  core.debugRegistry.set('phase02', registry);
  return registry;
}
