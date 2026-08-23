/**
 * Branch action registry (P12-T2, consumed further by P13-T5): one list of
 * ref actions shared by the log window's Branches pane, the branches tree
 * view and (P13-T5) the branches popup — three surfaces that must never
 * drift. Every action states where it applies and runs through the same
 * `BranchOps`/`RefService`/compare code paths the P2 commands use.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { BranchOps } from './branchOps';
import type { RefService } from './refService';

export type BranchRefType = 'local' | 'remote' | 'tag' | 'head';

export interface BranchActionContext {
  repo: RepoHandle;
  /** Ref name as displayed (`feature/f1`, `origin/main`, `v1.2`). */
  name: string;
  type: BranchRefType;
  /** True when `name` is the checked-out branch. */
  isCurrent: boolean;
}

export interface BranchAction {
  id: string;
  /** Interpolated label — what the popup (P13-T5) renders. */
  label(ctx: BranchActionContext, currentBranch: string | undefined): string;
  applies(ctx: BranchActionContext): boolean;
  run(ctx: BranchActionContext): Promise<void>;
  /**
   * Separator group, in the order the reference submenu shows them
   * (`docs/intellij-gap-analysis.md` §2A "Branch row submenu expanded"). The
   * popup inserts a divider whenever the group changes.
   */
  group?: 'checkout' | 'compare' | 'integrate' | 'worktree' | 'push' | 'manage';
  /** Right-aligned shortcut hint. */
  accelerator?: string;
}

export interface BranchActionDeps {
  ops: BranchOps;
  refServiceFor(repo: RepoHandle): RefService;
}

export function createBranchActions(deps: BranchActionDeps): BranchAction[] {
  const { ops } = deps;
  return [
    {
      id: 'checkout',
      group: 'checkout',
      label: (ctx) =>
        ctx.type === 'remote' ? vscode.l10n.t('Checkout') : vscode.l10n.t('Checkout'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'head',
      run: async (ctx) => {
        if (ctx.type === 'remote') await ops.checkoutRemote(ctx.repo, ctx.name);
        else await ops.checkout(ctx.repo, ctx.name);
      },
    },
    {
      id: 'newFrom',
      group: 'checkout',
      label: (ctx) => vscode.l10n.t("New Branch from '{0}'…", ctx.name),
      applies: () => true,
      run: (ctx) => deps.ops.newBranchFrom(ctx.repo, ctx.name),
    },
    {
      id: 'rebaseOntoCurrent',
      group: 'checkout',
      label: (ctx, current) =>
        vscode.l10n.t("Checkout and Rebase onto '{0}'", current ?? 'HEAD'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'tag',
      run: (ctx) => deps.ops.checkoutAndRebaseOntoCurrent(ctx.repo, ctx.name),
    },
    {
      id: 'compareWithCurrent',
      group: 'compare',
      label: (ctx, current) => vscode.l10n.t("Compare with '{0}'", current ?? 'HEAD'),
      applies: (ctx) => !ctx.isCurrent,
      run: async (ctx) => {
        await vscode.commands.executeCommand(
          'gittree.branches.compareWithCurrent',
          ctx.repo.root,
          ctx.name,
        );
      },
    },
    {
      id: 'diffWithWorkingTree',
      group: 'compare',
      label: () => vscode.l10n.t('Show Diff with Working Tree'),
      applies: (ctx) => !ctx.isCurrent,
      run: async (ctx) => {
        await vscode.commands.executeCommand(
          'gittree.branches.diffWithWorkingTree',
          ctx.repo.root,
          ctx.name,
        );
      },
    },
    {
      // P13-T5.3: `git rebase <sel>` — rebase the CURRENT branch onto the
      // selected one, the mirror of `rebaseOntoCurrent` and a separate verb in
      // the reference submenu.
      id: 'rebaseCurrentOnto',
      group: 'integrate',
      label: (ctx, current) =>
        vscode.l10n.t("Rebase '{0}' onto '{1}'", current ?? 'HEAD', ctx.name),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'tag',
      run: (ctx) => deps.ops.rebaseCurrentOnto(ctx.repo, ctx.name),
    },
    {
      /**
       * P13-T5.5, the real defect this task fixes: `mergeIntoCurrent` had
       * exactly ONE call site — the branches tree's drag-and-drop handler — so
       * merging a branch into the current one was reachable *only by dragging*.
       * It now has a registry entry, a menu row and a command.
       */
      id: 'mergeIntoCurrent',
      group: 'integrate',
      label: (ctx, current) =>
        vscode.l10n.t("Merge '{0}' into '{1}'", ctx.name, current ?? 'HEAD'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'head',
      run: (ctx) => deps.ops.mergeIntoCurrent(ctx.repo, ctx.name),
    },
    {
      id: 'pullIntoCurrent',
      group: 'integrate',
      label: (ctx, current) =>
        vscode.l10n.t("Pull into '{0}' Using Merge", current ?? 'HEAD'),
      applies: (ctx) => ctx.type === 'remote',
      run: (ctx) => deps.ops.pullRemoteIntoCurrent(ctx.repo, ctx.name),
    },
    {
      id: 'newWorktree',
      group: 'worktree',
      label: (ctx) => vscode.l10n.t("New Worktree from '{0}'…", ctx.name),
      applies: (ctx) => ctx.type !== 'head',
      run: async (ctx) => {
        await vscode.commands.executeCommand('gittree.worktree.add', ctx.name);
      },
    },
    {
      id: 'push',
      group: 'push',
      label: () => vscode.l10n.t('Push…'),
      applies: (ctx) => ctx.type === 'local',
      run: (ctx) => deps.ops.pushBranch(ctx.repo, ctx.name),
    },
    {
      id: 'rename',
      group: 'manage',
      accelerator: 'F2',
      label: () => vscode.l10n.t('Rename…'),
      applies: (ctx) => ctx.type === 'local',
      run: (ctx) => deps.ops.renameBranch(ctx.repo, ctx.name),
    },
    {
      id: 'delete',
      group: 'manage',
      label: () => vscode.l10n.t('Delete'),
      applies: (ctx) => ctx.type === 'local' && !ctx.isCurrent,
      run: (ctx) => deps.ops.deleteBranch(ctx.repo, ctx.name),
    },
    {
      id: 'deleteOnRemote',
      group: 'manage',
      label: (ctx) => vscode.l10n.t("Delete '{0}' on Remote", ctx.name),
      applies: (ctx) => ctx.type === 'remote',
      run: (ctx) => deps.ops.deleteRemoteBranch(ctx.repo, ctx.name),
    },
    {
      id: 'toggleFavorite',
      group: 'manage',
      label: () => vscode.l10n.t('Toggle Favorite'),
      applies: (ctx) => ctx.type === 'local',
      run: async (ctx) => {
        await deps.refServiceFor(ctx.repo).toggleFavorite(ctx.name);
      },
    },
  ];
}

/** Actions valid for one ref, in registry order — the submenu's contents. */
export function applicableBranchActions(
  actions: readonly BranchAction[],
  ctx: BranchActionContext,
): BranchAction[] {
  return actions.filter((a) => a.applies(ctx));
}

/** Lookup + dispatch used by commands and (later) the popup. */
export function findBranchAction(actions: readonly BranchAction[], id: string): BranchAction | undefined {
  return actions.find((a) => a.id === id);
}
