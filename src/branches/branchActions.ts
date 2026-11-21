/**
 * Branch action registry (P12-T2, consumed further by P13-T5): one list of
 * ref actions shared by the log window's Branches pane, the branches tree
 * view and (P13-T5) the branches popup — three surfaces that must never
 * drift. Every action states where it applies and runs through the same
 * `BranchOps`/`RefService`/compare code paths the P2 commands use.
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import type { BranchOps } from './branchOps';
import { branchOfRemote } from './checkoutAcrossModel';
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
  /**
   * Resolves `false` when the action did not complete and has already told
   * the user why (POST-P14ad). A fan-out across repositories stops there —
   * `runCommonAction` — while a single row's caller can ignore it: the
   * report is the action's own, so nobody has anything to add. Throwing would
   * have meant a second report from every one of the four single-row callers.
   */
  run(ctx: BranchActionContext): Promise<void | false>;
  /**
   * The all-repositories form, when it is one operation rather than one per
   * repository: a common branch's `Push…` opens one Push dialog listing every
   * repository, as IntelliJ's does, not a dialog each.
   */
  runAll?(ctxs: readonly BranchActionContext[]): Promise<void>;
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

/**
 * The upstream the branch is configured with, whether or not the remote branch
 * still exists: what `Stop Tracking` removes. A gone upstream is no use to
 * `Update`, but it is still a link the user may want rid of.
 */
export function configuredUpstream(ctx: BranchActionContext): string | undefined {
  return ctx.repo.model.snapshot.refs.find((r) => r.type === 'head' && r.name === ctx.name)?.upstream;
}

/**
 * The `viewItem` a branch row carries, which is what every `when` clause in
 * `view/item/context` matches against. Two tree views draw branch rows — the
 * POST-P14u Branches view and the legacy all-repositories tree — and both read
 * this, because a row that categorises itself differently in one of them gets a
 * different menu for the same ref, which is the POST-P14d defect exactly.
 *
 * The `:tracked` suffix exists because a `when` clause cannot read a node's
 * fields, and two rows — `Update` and the `Tracked Branch` submenu — are
 * meaningless without a live upstream. `upstreamOf` above is the definition this
 * projects; the two have to keep answering the same thing, so every clause
 * matches with `(:|$)` and never a bare `$`. `:gone` is an upstream the remote
 * has deleted: those two rows stay away, `Stop Tracking` (`configuredUpstream`)
 * does not.
 */
export function branchContextValue(ref: RefInfo): string {
  const kind =
    ref.isHead === true
      ? 'current'
      : ref.type === 'remote'
        ? 'remote'
        : ref.type === 'tag'
          ? 'tag'
          : 'local';
  if ((kind !== 'current' && kind !== 'local') || ref.upstream === undefined) return `branch:${kind}`;
  return ref.upstreamGone === true ? `branch:${kind}:gone` : `branch:${kind}:tracked`;
}

/** A remote branch's remote, `origin` for `origin/release/2.0`. */
function remoteOf(ctx: BranchActionContext): string | undefined {
  return ctx.repo.model.snapshot.refs.find((r) => r.type === 'remote' && r.name === ctx.name)?.remote;
}

/**
 * A remote branch whose local branch of the same name is the checked-out one:
 * `Checkout` on `origin/main` while on `main` would only land where it is.
 */
function checkedOutLocally(ctx: BranchActionContext): boolean {
  if (ctx.type !== 'remote') return false;
  const remote = remoteOf(ctx);
  if (remote === undefined) return false;
  const name = branchOfRemote(ctx.name, remote);
  return ctx.repo.model.snapshot.refs.some((r) => r.type === 'head' && r.name === name && r.isHead);
}

export function createBranchActions(deps: BranchActionDeps): BranchAction[] {
  const { ops } = deps;
  return [
    {
      id: 'checkout',
      group: 'checkout',
      label: (ctx) =>
        ctx.type === 'remote' ? vscode.l10n.t('Checkout') : vscode.l10n.t('Checkout'),
      applies: (ctx) => !ctx.isCurrent && ctx.type !== 'head' && !checkedOutLocally(ctx),
      run: async (ctx) => {
        if (ctx.type === 'remote') await ops.checkoutRemote(ctx.repo, ctx.name);
        else await ops.checkout(ctx.repo, ctx.name);
      },
      // POST-P14ax: across repositories, one run — each one's local branch, or a
      // new one tracking the remote branch, one question for local changes in
      // the way, one summary — rather than a Smart Checkout question each.
      runAll: async (ctxs) => {
        const first = ctxs[0];
        if (first === undefined) return;
        const repos = ctxs.map((c) => c.repo);
        if (first.type === 'tag') {
          await ops.checkoutAcross(repos, { kind: 'tag', name: first.name });
          return;
        }
        const remote = first.type === 'remote' ? remoteOf(first) : undefined;
        await ops.checkoutAcross(repos, {
          kind: 'branch',
          name: remote !== undefined ? branchOfRemote(first.name, remote) : first.name,
          ...(remote !== undefined ? { remote } : {}),
        });
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
          'geet.branches.compareWithCurrent',
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
          'geet.branches.diffWithWorkingTree',
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
        await vscode.commands.executeCommand('geet.worktree.add', ctx.name, ctx.repo.root);
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
      run: async (ctx) =>
        (await deps.ops.updateBranch(ctx.repo, ctx.name, ctx.isCurrent)) ? undefined : false,
    },
    {
      id: 'push',
      group: 'push',
      label: () => vscode.l10n.t('Push…'),
      applies: (ctx) => isLocalBranch(ctx),
      // The Push dialog for this branch (POST-P14ao), which reports for itself.
      run: async (ctx) => {
        await deps.ops.pushBranch(ctx.repo, ctx.name);
      },
      runAll: async (ctxs) => {
        const first = ctxs[0];
        if (first) await deps.ops.pushBranch(ctxs.map((c) => c.repo), first.name);
      },
    },
    {
      /**
       * IntelliJ's nested `Tracked Branch 'origin/x'` menu: the remote-branch
       * actions, aimed at the upstream instead of the row. Nothing new runs —
       * the upstream's own action list is opened, so the two can never offer
       * different verbs for the same ref. The Branches tree contributes this
       * as a real submenu (`geet.branches.trackedSubmenu`); here, where the
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
      /**
       * A step past IntelliJ, whose only way to do this is a checkbox in the
       * Rename dialog (D35): nobody looks for it there, and a branch tracking the
       * wrong remote branch pushes onto it.
       */
      id: 'stopTracking',
      group: 'tracked',
      label: (ctx) => vscode.l10n.t("Stop Tracking '{0}'", configuredUpstream(ctx) ?? ''),
      applies: (ctx) => isLocalBranch(ctx) && configuredUpstream(ctx) !== undefined,
      run: (ctx) => deps.ops.stopTracking(ctx.repo, ctx.name),
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
