/**
 * Branches QuickPick popup (P2-T2): the IntelliJ branches popup rebuilt on
 * native QuickPick — separator sections (Current / Favorites / Recent /
 * Local / Remote per remote), star + actions item buttons, type-to-filter
 * across name, sha and subject.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import type { BranchOps } from './branchOps';
import type { RefService } from './refService';

interface BranchItem extends vscode.QuickPickItem {
  branch?: RefInfo;
  isRemote?: boolean;
}

const STAR_ON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('star-full'),
  tooltip: vscode.l10n.t('Remove from favorites'),
};
const STAR_OFF: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('star-empty'),
  tooltip: vscode.l10n.t('Add to favorites'),
};
const ACTIONS: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('ellipsis'),
  tooltip: vscode.l10n.t('Branch actions…'),
};
const BTN_NEW: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('add'),
  tooltip: vscode.l10n.t('New branch…'),
};
const BTN_FETCH: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('sync'),
  tooltip: vscode.l10n.t('Fetch'),
};
const BTN_VIEW: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('list-tree'),
  tooltip: vscode.l10n.t('Open Branches view'),
};

function trackDescription(ref: RefInfo): string {
  const parts: string[] = [];
  if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
  if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
  if (ref.upstreamGone) parts.push(vscode.l10n.t('upstream gone'));
  parts.push(ref.sha.slice(0, 7));
  if (ref.subject !== undefined) parts.push(ref.subject);
  return parts.join(' · ');
}

/** Pure item assembly — unit-testable ordering/sections. */
export function buildPopupItems(input: {
  current: RefInfo | undefined;
  locals: RefInfo[];
  remotes: RefInfo[];
  recent: string[];
  favorites: ReadonlySet<string>;
}): BranchItem[] {
  const items: BranchItem[] = [];
  const sep = (label: string): BranchItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const branchItem = (ref: RefInfo, icon: string): BranchItem => ({
    label: `$(${icon}) ${ref.name}`,
    description: trackDescription(ref),
    branch: ref,
    isRemote: ref.type === 'remote',
    buttons:
      ref.type === 'head'
        ? [input.favorites.has(ref.name) ? STAR_ON : STAR_OFF, ACTIONS]
        : [ACTIONS],
  });

  if (input.current) {
    items.push(sep(vscode.l10n.t('Current')));
    const cur = branchItem(input.current, 'check');
    cur.detail = input.current.upstream
      ? vscode.l10n.t('Tracks {0}', input.current.upstream)
      : vscode.l10n.t('No upstream');
    items.push(cur);
  }

  const favoriteRefs = input.locals.filter(
    (b) => input.favorites.has(b.name) && !b.isHead,
  );
  if (favoriteRefs.length > 0) {
    items.push(sep(vscode.l10n.t('Favorites')));
    for (const b of favoriteRefs) items.push(branchItem(b, 'star-full'));
  }

  const recentRefs = input.recent
    .map((name) => input.locals.find((b) => b.name === name))
    .filter((b): b is RefInfo => b !== undefined && !b.isHead && !input.favorites.has(b.name));
  if (recentRefs.length > 0) {
    items.push(sep(vscode.l10n.t('Recent')));
    for (const b of recentRefs) items.push(branchItem(b, 'history'));
  }

  const plainLocals = input.locals.filter((b) => !b.isHead);
  if (plainLocals.length > 0) {
    items.push(sep(vscode.l10n.t('Local')));
    for (const b of plainLocals) items.push(branchItem(b, 'git-branch'));
  }

  const byRemote = new Map<string, RefInfo[]>();
  for (const r of input.remotes) {
    const list = byRemote.get(r.remote ?? '') ?? [];
    list.push(r);
    byRemote.set(r.remote ?? '', list);
  }
  for (const [remote, refs] of [...byRemote.entries()].sort()) {
    items.push(sep(vscode.l10n.t('Remote: {0}', remote)));
    for (const b of refs) items.push(branchItem(b, 'cloud'));
  }
  return items;
}

export async function showBranchesPopup(
  core: Core,
  repo: RepoHandle,
  refService: RefService,
  ops: BranchOps,
): Promise<void> {
  const qp = vscode.window.createQuickPick<BranchItem>();
  qp.placeholder = vscode.l10n.t('Search branches ({0})', repo.model.snapshot.headRef ?? '');
  qp.matchOnDescription = true;
  qp.buttons = [BTN_NEW, BTN_FETCH, BTN_VIEW];
  qp.busy = true;
  qp.show();

  const populate = async (): Promise<void> => {
    const [recent, favorites] = await Promise.all([
      refService.getRecentBranches(),
      refService.getFavorites(),
    ]);
    qp.items = buildPopupItems({
      current: refService.currentBranch,
      locals: refService.localBranches,
      remotes: refService.remoteBranches,
      recent,
      favorites,
    });
    qp.busy = false;
  };
  await populate();

  qp.onDidTriggerItemButton(async (e) => {
    const branch = e.item.branch;
    if (!branch) return;
    if (e.button === ACTIONS) {
      qp.hide();
      await showBranchActions(core, repo, ops, branch);
      return;
    }
    // Star toggle: refresh in place.
    await refService.toggleFavorite(branch.name);
    await populate();
  });

  qp.onDidTriggerButton(async (button) => {
    if (button === BTN_NEW) {
      qp.hide();
      await ops.newBranchFrom(repo, 'HEAD');
    } else if (button === BTN_FETCH) {
      qp.busy = true;
      await vscode.commands.executeCommand('gittree.fetch', repo.root);
      await populate();
    } else {
      qp.hide();
      await vscode.commands.executeCommand('gittree.branches.focus');
    }
  });

  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item?.branch) return;
    qp.hide();
    const defaultAction = vscode.workspace
      .getConfiguration('gittree')
      .get<string>('branches.defaultAction', 'checkout');
    if (defaultAction === 'showActions') {
      await showBranchActions(core, repo, ops, item.branch);
      return;
    }
    if (item.branch.isHead) return;
    if (item.isRemote) {
      await ops.checkoutRemote(repo, item.branch.name);
    } else {
      await ops.checkout(repo, item.branch.name);
    }
  });

  qp.onDidHide(() => qp.dispose());
}

/** Per-branch actions QuickPick (the `…` button / Enter with showActions). */
export async function showBranchActions(
  core: Core,
  repo: RepoHandle,
  ops: BranchOps,
  branch: RefInfo,
): Promise<void> {
  interface ActionItem extends vscode.QuickPickItem {
    run?: () => Promise<void>;
  }
  const isRemote = branch.type === 'remote';
  const isCurrent = branch.isHead;
  const items: ActionItem[] = [];
  const add = (label: string, run: () => Promise<void>): void => {
    items.push({ label, run });
  };

  if (!isCurrent) {
    if (isRemote) {
      add(vscode.l10n.t('$(arrow-right) Checkout as new local branch'), () =>
        ops.checkoutRemote(repo, branch.name),
      );
    } else {
      add(vscode.l10n.t('$(arrow-right) Checkout'), () => ops.checkout(repo, branch.name));
      add(vscode.l10n.t('$(git-merge) Checkout and Rebase onto Current'), () =>
        ops.checkoutAndRebaseOntoCurrent(repo, branch.name),
      );
    }
    add(vscode.l10n.t('$(diff) Compare with Current'), () =>
      Promise.resolve(
        vscode.commands.executeCommand('gittree.branches.compareWithCurrent', repo.root, branch.name),
      ).then(() => undefined),
    );
    add(vscode.l10n.t('$(diff-multiple) Show Diff with Working Tree'), () =>
      Promise.resolve(
        vscode.commands.executeCommand('gittree.branches.diffWithWorkingTree', repo.root, branch.name),
      ).then(() => undefined),
    );
  }
  add(vscode.l10n.t('$(add) New Branch from "{0}"', branch.name), () =>
    ops.newBranchFrom(repo, branch.name),
  );
  if (!isRemote) {
    add(vscode.l10n.t('$(edit) Rename…'), () => ops.renameBranch(repo, branch.name));
    add(vscode.l10n.t('$(cloud-upload) Push'), () => ops.pushBranch(repo, branch.name));
    if (!isCurrent) {
      add(vscode.l10n.t('$(trash) Delete'), () => ops.deleteBranch(repo, branch.name));
    }
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Actions for {0}', branch.name),
  });
  await picked?.run?.();
  void core; // reserved for P4 log integration (reveal branch in log)
}
