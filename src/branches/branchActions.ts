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
      label: () => vscode.l10n.t('Checkout'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'head',
      run: async (ctx) => {
        if (ctx.type === 'remote') await ops.checkoutRemote(ctx.repo, ctx.name);
        else await ops.checkout(ctx.repo, ctx.name);
      },
    },
    {
      id: 'newFrom',
      label: (ctx) => vscode.l10n.t("New Branch from '{0}'…", ctx.name),
      applies: () => true,
      run: (ctx) => deps.ops.newBranchFrom(ctx.repo, ctx.name),
    },
    {
      id: 'compareWithCurrent',
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
      id: 'rebaseOntoCurrent',
      label: (ctx, current) =>
        vscode.l10n.t("Checkout and Rebase onto '{0}'", current ?? 'HEAD'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'tag',
      run: (ctx) => deps.ops.checkoutAndRebaseOntoCurrent(ctx.repo, ctx.name),
    },
    {
      id: 'push',
      label: () => vscode.l10n.t('Push…'),
      applies: (ctx) => ctx.type === 'local',
      run: (ctx) => deps.ops.pushBranch(ctx.repo, ctx.name),
    },
    {
      id: 'rename',
      label: () => vscode.l10n.t('Rename…'),
      applies: (ctx) => ctx.type === 'local',
      run: (ctx) => deps.ops.renameBranch(ctx.repo, ctx.name),
    },
    {
      id: 'delete',
      label: () => vscode.l10n.t('Delete'),
      applies: (ctx) => ctx.type === 'local' && !ctx.isCurrent,
      run: (ctx) => deps.ops.deleteBranch(ctx.repo, ctx.name),
    },
    {
      id: 'toggleFavorite',
      label: () => vscode.l10n.t('Toggle Favorite'),
      applies: (ctx) => ctx.type === 'local',
      run: async (ctx) => {
        await deps.refServiceFor(ctx.repo).toggleFavorite(ctx.name);
      },
    },
  ];
}

/** Lookup + dispatch used by commands and (later) the popup. */
export function findBranchAction(actions: readonly BranchAction[], id: string): BranchAction | undefined {
  return actions.find((a) => a.id === id);
}
