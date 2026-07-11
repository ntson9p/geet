/**
 * Phase 2 registration: RefService per repo, Branches popup (replaces the
 * P1 stub over the same command id), branch op commands, Branches TreeView,
 * Compare view.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { canonicalKey } from '../core/repoDiscovery';
import { setBranchesOpenHandler } from '../scm/syncOps';
import { BranchOps } from './branchOps';
import { showBranchesPopup } from './branchesPopup';
import { BranchesViewProvider, type BranchNode } from './branchesView';
import { CompareService } from './compare';
import { RefService, type FavoritesStorage } from './refService';

export interface Phase02Registry {
  refServices: Map<string, RefService>;
  ops: BranchOps;
  viewProvider: BranchesViewProvider;
  compare: CompareService;
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

  // The real Branches popup replaces the P1 stub (same command id).
  setBranchesOpenHandler(async (repoRoot) => {
    const repo = pickRepo(repoRoot);
    if (!repo) return;
    await showBranchesPopup(core, repo, serviceFor(repo), ops);
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

  const registry: Phase02Registry = { refServices, ops, viewProvider, compare };
  core.debugRegistry.set('phase02', registry);
  return registry;
}
