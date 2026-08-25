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
  group?: 'checkout' | 'compare' | 'integrate' | 'worktree' | 'push' | 'tracked' | 'manage';
  /** Right-aligned shortcut hint. */
  accelerator?: string;
}

export interface BranchActionDeps {
  ops: BranchOps;
  refServiceFor(repo: RepoHandle): RefService;
  /**
   * Opens the action list for another ref — how `trackedBranch` drills into the
   * upstream. Injected because the popup that renders that list is itself built
   * from this registry; importing it here would close the cycle.
   */
  showActionsFor?(repo: RepoHandle, refName: string): Promise<void>;
}

/**
 * True for any branch under `refs/heads/`, checked out or not.
 *
 * `BranchRefType` carries both `local` and `head`, and the two are *not*
 * alternatives: `refTypeOf` narrows a local branch to `head` the moment it
 * becomes the checked-out one, while the log's Branches pane sends plain
 * `local` for the same ref and marks it with `isCurrent`. Predicates that
 * spelled only `type === 'local'` therefore evaporated on the current branch
 * from one surface and survived on another — the reason the branches popup
 * offered a single row for HEAD while the tree offered four. Say it once.
 */
export function isLocalBranch(ctx: BranchActionContext): boolean {
  return ctx.type === 'local' || ctx.type === 'head';
}

/**
 * The ref's live upstream, or undefined when it has none or the remote branch
 * is gone. Read from the snapshot rather than carried on the context: tracking
 * is repository state, and a menu built from a stale copy of it would offer
 * `Update` for a branch whose upstream was deleted two fetches ago.
 *
 * `branchesView.ts` spells the same predicate into its `contextValue` as a
 * `:tracked` suffix, because `when` clauses cannot read a node's fields. The
 * two must agree — this is the definition, that is the projection of it.
 */
export function upstreamOf(ctx: BranchActionContext): string | undefined {
  const ref = ctx.repo.model.snapshot.refs.find(
    (r) => r.type === 'head' && r.name === ctx.name,
  );
  if (!ref || ref.upstream === undefined || ref.upstreamGone === true) return undefined;
  return ref.upstream;
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
      // Applies to the checked-out branch too, where `git diff HEAD` is the
      // uncommitted work — IntelliJ offers it there for exactly that reason.
      // `compareWithCurrent` above is the one that genuinely cannot: comparing
      // the current branch with itself has no two sides.
      applies: () => true,
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
      run: (ctx) => deps.ops.pullRemoteIntoCurrent(ctx.repo, ctx.name, 'merge'),
    },
    {
      // IntelliJ offers both integrations on a remote row and names each one;
      // shipping only the merge half left `Pull … Using Rebase` unreachable.
      id: 'pullIntoCurrentRebase',
      group: 'integrate',
      label: (ctx, current) =>
        vscode.l10n.t("Pull into '{0}' Using Rebase", current ?? 'HEAD'),
      applies: (ctx) => ctx.type === 'remote',
      run: (ctx) => deps.ops.pullRemoteIntoCurrent(ctx.repo, ctx.name, 'rebase'),
    },
    {
      id: 'newWorktree',
      group: 'worktree',
      label: (ctx) => vscode.l10n.t("New Worktree from '{0}'…", ctx.name),
      // The checked-out branch is not excluded: git refuses only to *check out*
      // a branch a second time, and the dialog answers that by opening in
      // "create a new branch" mode when the seed is already in use (or by the
      // explicit `--force` under Modify Options). Hiding the row instead made
      // "branch off the branch I am on into a worktree" — the common case —
      // unreachable from the branch it starts at.
      applies: () => true,
      run: async (ctx) => {
        await vscode.commands.executeCommand('gittree.worktree.add', ctx.name, ctx.repo.root);
      },
    },
    {
      /**
       * IntelliJ's `Update`: bring the branch level with the remote branch it
       * tracks. Local branches only, and only while that upstream still
       * exists — an update with nothing to update from is not a disabled row
       * in IntelliJ, it is an absent one.
       */
      id: 'update',
      group: 'push',
      label: () => vscode.l10n.t('Update'),
      applies: (ctx) => isLocalBranch(ctx) && upstreamOf(ctx) !== undefined,
      run: (ctx) => deps.ops.updateBranch(ctx.repo, ctx.name, ctx.isCurrent),
    },
    {
      id: 'push',
      group: 'push',
      label: () => vscode.l10n.t('Push…'),
      applies: (ctx) => isLocalBranch(ctx),
      run: (ctx) => deps.ops.pushBranch(ctx.repo, ctx.name),
    },
    {
      /**
       * IntelliJ's nested `Tracked Branch 'origin/x'` menu: the remote-branch
       * actions, aimed at the upstream instead of the row. Nothing new runs —
       * the upstream's own action list is opened, so the two can never offer
       * different verbs for the same ref. The Branches tree contributes this
       * as a real submenu (`gittree.branches.trackedSubmenu`); here, where the
       * surface is a QuickPick, drilling in is the equivalent gesture.
       */
      id: 'trackedBranch',
      group: 'tracked',
      label: (ctx) => vscode.l10n.t("Tracked Branch '{0}'…", upstreamOf(ctx) ?? ''),
      applies: (ctx) =>
        deps.showActionsFor !== undefined &&
        isLocalBranch(ctx) &&
        upstreamOf(ctx) !== undefined,
      run: async (ctx) => {
        const upstream = upstreamOf(ctx);
        if (upstream === undefined) return;
        await deps.showActionsFor?.(ctx.repo, upstream);
      },
    },
    {
      id: 'rename',
      group: 'manage',
      accelerator: 'F2',
      label: () => vscode.l10n.t('Rename…'),
      applies: (ctx) => isLocalBranch(ctx),
      run: (ctx) => deps.ops.renameBranch(ctx.repo, ctx.name),
    },
    {
      id: 'delete',
      group: 'manage',
      label: () => vscode.l10n.t('Delete'),
      applies: (ctx) => isLocalBranch(ctx) && !ctx.isCurrent,
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
      applies: (ctx) => isLocalBranch(ctx),
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
