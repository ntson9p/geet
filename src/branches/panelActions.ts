/**
 * What the Branches panel offers (new-way-4): a branch's menu and the buttons
 * on its card, a repository's menu, and the dispatch that runs what was
 * picked.
 *
 * Nothing here is a second implementation of a branch operation. A branch's
 * entries are `branchActions.ts`'s, the registry every branch surface reads;
 * across several repositories they are `COMMON_ACTIONS`, run by the same
 * `runCommonAction` the branches popup uses; a repository's are
 * `repositoryMenu.ts`'s. This module only decides which of them to show, in
 * what order, under which words.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import { canonicalKey } from '../core/repoDiscovery';
import type {
  BranchPanelButtonDto,
  BranchPanelMenuItemDto,
  BranchPanelRefKind,
  BranchPanelRunDto,
  BranchPanelTargetDto,
} from '../shared/protocol';
import {
  applicableBranchActions,
  upstreamOf,
  type BranchAction,
  type BranchActionContext,
} from './branchActions';
import {
  applicableCommonActions,
  COMMON_ACTIONS,
  commonActionLabel,
  refTypeOf,
  runCommonAction,
} from './branchesPopup';
import { REPOSITORY_MENU } from './repositoryMenu';

export interface PanelActionDeps {
  readonly core: Core;
  readonly actions: readonly BranchAction[];
  /** The name the panel shows for a root. */
  readonly labelOf: (root: string) => string;
  /** Local branches whose work has reached the main branch, per root. */
  readonly mergedIn: (root: string) => ReadonlySet<string>;
  readonly isFavorite: (root: string, branch: string) => boolean;
}

/** The ref a target names, in one repository. */
export function refIn(repo: RepoHandle, kind: BranchPanelRefKind, name: string): RefInfo | undefined {
  const type = kind === 'local' ? 'head' : kind;
  return repo.model.snapshot.refs.find(
    (r) => r.type === type && r.name === name && r.symrefTarget === undefined,
  );
}

export function contextIn(
  repo: RepoHandle,
  target: Pick<BranchPanelTargetDto, 'kind' | 'name'>,
): BranchActionContext | undefined {
  const ref = refIn(repo, target.kind, target.name);
  if (!ref) return undefined;
  return {
    repo,
    name: ref.name,
    type: refTypeOf(ref),
    isCurrent: ref.type === 'head' && ref.isHead,
  };
}

/** The repositories `roots` name that are still open, once each, in the order given. */
export function reposOf(core: Core, roots: readonly string[]): RepoHandle[] {
  const seen = new Set<string>();
  const out: RepoHandle[] = [];
  for (const root of roots) {
    const repo = core.getRepo(root);
    if (!repo) continue;
    const key = canonicalKey(repo.root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
  }
  return out;
}

interface Pair {
  readonly repo: RepoHandle;
  readonly ctx: BranchActionContext;
}

function pairsOf(core: Core, target: BranchPanelTargetDto): Pair[] {
  const out: Pair[] = [];
  for (const repo of reposOf(core, target.roots)) {
    const ctx = contextIn(repo, target);
    if (ctx) out.push({ repo, ctx });
  }
  return out;
}

/** What HEAD is, in words: the branch, or the short sha when detached. */
export function headName(repo: RepoHandle): string {
  const snap = repo.model.snapshot;
  if (!snap.detached && snap.headRef !== undefined) return snap.headRef;
  return snap.headSha?.slice(0, 8) ?? 'HEAD';
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

/**
 * One repository's menu for one ref: the registry's applicable actions, in
 * its order, a rule wherever the group changes. Two entries become something
 * a webview can do better than the registry's QuickPick fallbacks:
 * `New Branch from…` opens the panel's own form, and `Tracked Branch` is a
 * real submenu holding the upstream's own actions, as in IntelliJ.
 */
function repoRefMenu(
  deps: PanelActionDeps,
  repo: RepoHandle,
  ctx: BranchActionContext,
  target: BranchPanelTargetDto,
  pinRoot: boolean,
): BranchPanelMenuItemDto[] {
  const head = repo.model.snapshot.headRef;
  const items: BranchPanelMenuItemDto[] = [];
  let lastGroup: string | undefined;
  const root = pinRoot ? repo.root : undefined;
  for (const action of applicableBranchActions(deps.actions, ctx)) {
    const group = action.group ?? 'manage';
    if (lastGroup !== undefined && group !== lastGroup) items.push({ kind: 'separator' });
    lastGroup = group;
    if (action.id === 'newFrom') {
      items.push({
        kind: 'item',
        label: action.label(ctx, head),
        icon: 'add',
        run: { type: 'newBranch', from: ctx.name, roots: [repo.root] },
      });
      continue;
    }
    if (action.id === 'trackedBranch') {
      const upstream = upstreamOf(ctx);
      if (upstream === undefined) continue;
      const upTarget: BranchPanelTargetDto = { kind: 'remote', name: upstream, roots: [repo.root] };
      const upCtx = contextIn(repo, upTarget);
      if (!upCtx) continue;
      items.push({
        kind: 'submenu',
        label: vscode.l10n.t("Tracked Branch '{0}'", upstream),
        icon: 'cloud',
        items: repoRefMenu(deps, repo, upCtx, upTarget, pinRoot),
      });
      continue;
    }
    const label =
      action.id === 'toggleFavorite'
        ? deps.isFavorite(repo.root, ctx.name)
          ? vscode.l10n.t('Remove from Favorites')
          : vscode.l10n.t('Add to Favorites')
        : action.label(ctx, head);
    items.push({
      kind: 'item',
      label,
      run: {
        type: 'action',
        target,
        action: action.id,
        ...(root !== undefined ? { root } : {}),
      },
      ...(action.accelerator !== undefined ? { accelerator: action.accelerator } : {}),
      ...(ACTION_ICON[action.id] !== undefined ? { icon: ACTION_ICON[action.id] } : {}),
    });
  }
  // Showing the branch's history needs no registry entry: it changes nothing.
  if (target.kind !== 'tag' || items.length > 0) {
    items.push({ kind: 'separator' });
    items.push({
      kind: 'item',
      label: vscode.l10n.t('Show in Git Log'),
      icon: 'git-commit',
      run: { type: 'command', command: 'gittree.branches.showInLog', root: repo.root, arg: ctx.name },
    });
  }
  return items;
}

/**
 * A branch row's menu. In one repository, that repository's menu. Across
 * several, the operations that run in all of them first — labelled with how
 * many they will touch — then one submenu per repository holding its own.
 */
export function branchMenu(deps: PanelActionDeps, target: BranchPanelTargetDto): BranchPanelMenuItemDto[] {
  const pairs = pairsOf(deps.core, target);
  const only = pairs[0];
  if (only === undefined) return [];
  if (pairs.length === 1) return repoRefMenu(deps, only.repo, only.ctx, target, false);
  const items: BranchPanelMenuItemDto[] = [];
  const offer = applicableCommonActions(
    COMMON_ACTIONS,
    deps.actions,
    { kind: target.kind, name: target.name },
    pairs.map((p) => p.ctx),
  );
  for (const { spec, appliesIn } of offer) {
    items.push({
      kind: 'item',
      label: commonActionLabel(spec.verb, appliesIn, pairs.length),
      run: { type: 'action', target, action: spec.id },
      ...(ACTION_ICON[spec.id] !== undefined ? { icon: ACTION_ICON[spec.id] } : {}),
    });
  }
  items.push({
    kind: 'item',
    label: vscode.l10n.t("New Branch from '{0}' in {1} Repositories…", target.name, pairs.length),
    icon: 'add',
    run: { type: 'newBranch', from: target.name, roots: pairs.map((p) => p.repo.root) },
  });
  items.push({ kind: 'separator' });
  items.push({ kind: 'header', label: vscode.l10n.t('In one repository') });
  for (const { repo, ctx } of pairs) {
    items.push({
      kind: 'submenu',
      label: deps.labelOf(repo.root),
      icon: 'repo',
      items: repoRefMenu(deps, repo, ctx, target, true),
    });
  }
  return items;
}

/**
 * A repository's menu: the Repositories section's entries, each run with that
 * repository's root. `New Branch…` opens the panel's form instead of the input
 * box, since the form is right there.
 */
export function repositoryMenu(root: string): BranchPanelMenuItemDto[] {
  const items: BranchPanelMenuItemDto[] = [];
  let lastGroup: string | undefined;
  for (const entry of REPOSITORY_MENU) {
    if (lastGroup !== undefined && entry.group !== lastGroup) items.push({ kind: 'separator' });
    lastGroup = entry.group;
    const run: BranchPanelRunDto =
      entry.command === 'gittree.branch.new'
        ? { type: 'newBranch', from: 'HEAD', roots: [root] }
        : { type: 'command', command: entry.command, root };
    items.push({ kind: 'item', label: entry.label, run });
  }
  return items;
}

// ---------------------------------------------------------------------------
// The card's buttons
// ---------------------------------------------------------------------------

const ACTION_ICON: Partial<Record<string, string>> = {
  checkout: 'arrow-swap',
  mergeIntoCurrent: 'git-merge',
  update: 'arrow-down',
  push: 'arrow-up',
  stopTracking: 'debug-disconnect',
  delete: 'trash',
  newFrom: 'add',
  compareWithCurrent: 'git-compare',
};

function shortLabel(id: string, head: string): string {
  switch (id) {
    case 'checkout':
      return vscode.l10n.t('Checkout');
    case 'mergeIntoCurrent':
      return vscode.l10n.t('Merge into {0}', head);
    case 'update':
      return vscode.l10n.t('Update');
    case 'push':
      return vscode.l10n.t('Push…');
    case 'delete':
      return vscode.l10n.t('Delete');
    case 'newFrom':
      return vscode.l10n.t('New Branch…');
    default:
      return id;
  }
}

/**
 * The few actions a branch's card puts on buttons — the ones its state makes
 * likely, so the menu is for everything else:
 * - the checked-out branch: Update (when it tracks something), Push;
 * - a branch merged into the main branch, or whose remote branch is gone:
 *   Checkout, and Delete — it is probably done with;
 * - any other branch: Checkout, and Merge it into what is checked out;
 * - a tag: Checkout, or start a branch from it.
 * Across several repositories, the same choice from the all-repositories
 * operations, each labelled with how many repositories it will touch.
 */
export function cardButtons(deps: PanelActionDeps, target: BranchPanelTargetDto): BranchPanelButtonDto[] {
  const pairs = pairsOf(deps.core, target);
  const only = pairs[0];
  if (only === undefined) return [];
  if (pairs.length === 1) {
    const { repo, ctx } = only;
    const head = headName(repo);
    const ref = refIn(repo, target.kind, target.name);
    const finished = deps.mergedIn(repo.root).has(ctx.name) || ref?.upstreamGone === true;
    const ids = ctx.isCurrent
      ? ['update', 'push']
      : ctx.type === 'tag'
        ? ['checkout', 'newFrom']
        : ctx.type === 'remote'
          ? ['checkout', 'mergeIntoCurrent']
          : finished
            ? ['checkout', 'delete']
            : ['checkout', 'mergeIntoCurrent'];
    const out: BranchPanelButtonDto[] = [];
    for (const id of ids) {
      const action = deps.actions.find((a) => a.id === id);
      if (!action?.applies(ctx)) continue;
      out.push({
        label: shortLabel(id, head),
        title: action.label(ctx, repo.model.snapshot.headRef),
        icon: ACTION_ICON[id] ?? 'circle-small',
        run:
          id === 'newFrom'
            ? { type: 'newBranch', from: ctx.name, roots: [repo.root] }
            : { type: 'action', target, action: id },
      });
    }
    // The checked-out branch's card still offers a new branch off it.
    if (ctx.isCurrent) {
      out.push({
        label: vscode.l10n.t('New Branch…'),
        title: vscode.l10n.t("New Branch from '{0}'…", ctx.name),
        icon: 'add',
        run: { type: 'newBranch', from: ctx.name, roots: [repo.root] },
      });
    }
    return out;
  }
  const contexts = pairs.map((p) => p.ctx);
  const everywhere = contexts.every((c) => c.isCurrent);
  const wanted = everywhere ? ['update', 'push'] : ['checkout', 'mergeIntoCurrent', 'update'];
  const offer = applicableCommonActions(
    COMMON_ACTIONS,
    deps.actions,
    { kind: target.kind, name: target.name },
    contexts,
  );
  const out: BranchPanelButtonDto[] = [];
  for (const id of wanted) {
    if (out.length === 2) break;
    const found = offer.find((o) => o.spec.id === id);
    if (!found) continue;
    out.push({
      label:
        id === 'push'
          ? vscode.l10n.t('Push…')
          : vscode.l10n.t('{0} in {1}', commonShort(id), found.appliesIn),
      title: commonActionLabel(found.spec.verb, found.appliesIn, pairs.length),
      icon: ACTION_ICON[id] ?? 'circle-small',
      run: { type: 'action', target, action: id },
    });
  }
  return out;
}

function commonShort(id: string): string {
  switch (id) {
    case 'checkout':
      return vscode.l10n.t('Checkout');
    case 'mergeIntoCurrent':
      return vscode.l10n.t('Merge');
    case 'update':
      return vscode.l10n.t('Update');
    default:
      return id;
  }
}

// ---------------------------------------------------------------------------
// Running what was picked
// ---------------------------------------------------------------------------

/**
 * Commands a panel row may run, with a root or without. Anything else is
 * refused: the webview names commands by string, and a string from a webview
 * is not a licence to run whatever it says.
 */
export const PANEL_COMMANDS: ReadonlySet<string> = new Set([
  ...REPOSITORY_MENU.map((e) => e.command),
  'gittree.fetch',
  'gittree.update.dialog',
  'gittree.push.dialog',
  'gittree.commit',
  'gittree.branches.checkoutRevision',
  'gittree.branches.showInLog',
  'gittree.branches.cleanup',
  'gittree.rebase.continue',
  'gittree.rebase.skip',
  'gittree.rebase.abort',
  'gittree.merge.continueOp',
  'gittree.merge.abortOp',
  'gittree.conflicts.focus',
]);

export async function runPanel(deps: PanelActionDeps, run: BranchPanelRunDto): Promise<void> {
  switch (run.type) {
    case 'action': {
      const roots = run.root !== undefined ? [run.root] : run.target.roots;
      const repos = reposOf(deps.core, roots);
      const first = repos[0];
      if (first === undefined) return;
      const action = deps.actions.find((a) => a.id === run.action);
      if (!action) return;
      if (repos.length === 1) {
        const ctx = contextIn(first, run.target);
        if (!ctx) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('{0} is no longer in {1}.', run.target.name, deps.labelOf(first.root)),
          );
          return;
        }
        if (!action.applies(ctx)) return;
        await action.run(ctx);
        return;
      }
      await runCommonAction(repos, { kind: run.target.kind, name: run.target.name }, deps.actions, run.action);
      return;
    }
    case 'command': {
      if (!PANEL_COMMANDS.has(run.command)) return;
      const args: unknown[] = [];
      if (run.root !== undefined) args.push(run.root);
      if (run.arg !== undefined) args.push(run.arg);
      await vscode.commands.executeCommand(run.command, ...args);
      return;
    }
    case 'newBranch':
      // The webview's own form; nothing for the host to do.
      return;
  }
}
