/**
 * Branches popup as an **action hub** (P13-T5, gap analysis S3 · §2A
 * "Branches popup" / "Branch row submenu expanded").
 *
 * Still a native `QuickPick` — master §6 chose it over a webview for real focus,
 * search and keyboard parity, and the reference screenshot vindicates that: its
 * field reads *"Search for branches **and actions**"*. The gap was content and
 * structure, not the widget. What changed here:
 *
 *   - **top-level verbs first** (Update Project · Commit · Push · New Branch ·
 *     Checkout Tag or Revision), so typing `merge` or `push` finds an action and
 *     the popup is a hub rather than a branch list;
 *   - **folder rows** built from the ref names: picking `feature` drills into a
 *     scoped popup with a `‹ Back` row and a breadcrumb title (deviation D5 —
 *     `QuickPick` cannot render a collapsible tree), while typing searches flat
 *     across every level so drill-in never traps anyone;
 *   - a **`›` submenu per row**, built from `branchActions.ts` so the popup, the
 *     branches tree view and the log's Branches pane cannot drift.
 */
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import {
  applicableBranchActions,
  type BranchAction,
  type BranchActionContext,
  type BranchRefType,
} from './branchActions';
import type { BranchOps } from './branchOps';
import type { RefService } from './refService';

interface BranchItem extends vscode.QuickPickItem {
  branch?: RefInfo;
  isRemote?: boolean;
  /** A folder row: picking it drills into that prefix. */
  folder?: string;
  /** The `‹ Back` row. */
  back?: boolean;
  /** A top-level verb: a command to run. */
  command?: string;
  /** Search text the flat filter matches against, beyond label/description. */
  searchText?: string;
}

const STAR_ON: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('star-full'),
  tooltip: vscode.l10n.t('Remove from favorites'),
};
const STAR_OFF: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('star-empty'),
  tooltip: vscode.l10n.t('Add to favorites'),
};
/** The `›` affordance the reference shows on every branch row. */
const ACTIONS: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('chevron-right'),
  tooltip: vscode.l10n.t('Branch actions (→)'),
};
const BTN_NEW: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('add'),
  tooltip: vscode.l10n.t('New branch…'),
};
const BTN_FETCH: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('sync'),
  tooltip: vscode.l10n.t('Fetch'),
};
/** §2A header: the incoming/outgoing toggle. */
const BTN_INOUT: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('arrow-swap'),
  tooltip: vscode.l10n.t('Show incoming/outgoing counts'),
};
/** §2A header: the gear (branch settings). */
const BTN_GEAR: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('gear'),
  tooltip: vscode.l10n.t('Branch settings'),
};
const BTN_VIEW: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('list-tree'),
  tooltip: vscode.l10n.t('Open Branches view'),
};

function trackDescription(ref: RefInfo, showInOut: boolean): string {
  const parts: string[] = [];
  if (showInOut) {
    if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
    if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
  } else {
    if ((ref.ahead ?? 0) > 0) parts.push(`↑${ref.ahead}`);
    if ((ref.behind ?? 0) > 0) parts.push(`↓${ref.behind}`);
  }
  if (ref.upstreamGone) parts.push(vscode.l10n.t('upstream gone'));
  parts.push(ref.sha.slice(0, 7));
  if (ref.subject !== undefined) parts.push(ref.subject);
  return parts.join(' · ');
}

/** The top-level verbs, before any branch (§2A step 2). */
export interface HubVerb {
  readonly command: string;
  readonly label: string;
  readonly accelerator?: string;
  readonly icon: string;
  /** Extra words the flat search should match (`merge` finding Update Project). */
  readonly keywords?: string;
}

export const HUB_VERBS: readonly HubVerb[] = [
  {
    command: 'gittree.update.dialog',
    label: 'Update Project…',
    accelerator: 'Ctrl+T',
    icon: 'sync',
    keywords: 'pull fetch merge rebase update',
  },
  {
    command: 'gittree.commit',
    label: 'Commit…',
    accelerator: 'Ctrl+K',
    icon: 'check',
    keywords: 'commit stage',
  },
  {
    command: 'gittree.push.dialog',
    label: 'Push…',
    accelerator: 'Ctrl+Shift+K',
    icon: 'repo-push',
    keywords: 'push upload',
  },
  {
    command: 'gittree.branch.new',
    label: 'New Branch…',
    accelerator: 'Ctrl+Alt+N',
    icon: 'add',
    keywords: 'branch create new',
  },
  {
    command: 'gittree.branches.checkoutRevision',
    label: 'Checkout Tag or Revision…',
    icon: 'tag',
    keywords: 'checkout tag revision detach',
  },
];

/** `RefInfo.type` → the registry's ref kind, distinguishing the current branch. */
export function refTypeOf(ref: RefInfo): BranchRefType {
  if (ref.type !== 'head') return ref.type;
  return ref.isHead === true ? 'head' : 'local';
}

/** Everything before the first `/`, for the folder rows. */
export function folderOf(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const slash = rest.indexOf('/');
  return slash === -1 ? undefined : rest.slice(0, slash);
}

export interface PopupInput {
  current: RefInfo | undefined;
  locals: RefInfo[];
  remotes: RefInfo[];
  tags: RefInfo[];
  recent: string[];
  favorites: ReadonlySet<string>;
  /** Drill-in prefix, `''` at the top level (`feature/` when scoped). */
  prefix: string;
  /** Hide the verbs and folder rows: the flat search across every level. */
  filtering: boolean;
  showInOut: boolean;
}

/**
 * Pure item assembly — unit-testable ordering, sections, folders and verbs.
 * With `filtering` set, folders collapse away and every ref is listed flat, so
 * typing always searches the whole tree regardless of how deep the drill-in is.
 */
export function buildPopupItems(input: PopupInput): BranchItem[] {
  const items: BranchItem[] = [];
  const sep = (label: string): BranchItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const branchItem = (ref: RefInfo, icon: string): BranchItem => ({
    label: `$(${icon}) ${input.filtering || input.prefix.length === 0 ? ref.name : ref.name.slice(input.prefix.length)}`,
    description: trackDescription(ref, input.showInOut),
    branch: ref,
    isRemote: ref.type === 'remote',
    searchText: ref.name,
    buttons:
      ref.type === 'head'
        ? [input.favorites.has(ref.name) ? STAR_ON : STAR_OFF, ACTIONS]
        : [ACTIONS],
  });

  // ---- top-level verbs, first ----------------------------------------------
  if (!input.filtering && input.prefix.length === 0) {
    items.push(sep(vscode.l10n.t('Actions')));
    for (const v of HUB_VERBS) {
      items.push({
        label: `$(${v.icon}) ${v.label}`,
        ...(v.accelerator !== undefined ? { description: v.accelerator } : {}),
        command: v.command,
        searchText: `${v.label} ${v.keywords ?? ''}`,
      });
    }
  }
  if (!input.filtering && input.prefix.length > 0) {
    items.push({ label: `$(arrow-left) ${vscode.l10n.t('Back')}`, back: true, alwaysShow: true });
  }

  const inScope = (ref: RefInfo): boolean =>
    input.filtering || input.prefix.length === 0 || ref.name.startsWith(input.prefix);

  /**
   * Folder rows for one section, plus the refs that sit directly in it.
   * `flat` sections (Favorites, Recent) never folderize: they are short curated
   * lists where a folder row would hide the very branch the user pinned.
   */
  const section = (label: string, refs: RefInfo[], icon: string, flat = false): void => {
    const scoped = refs.filter(inScope);
    if (scoped.length === 0) return;
    items.push(sep(label));
    if (input.filtering || flat) {
      for (const r of scoped) items.push(branchItem(r, icon));
      return;
    }
    const folders = new Map<string, number>();
    const direct: RefInfo[] = [];
    for (const r of scoped) {
      const folder = folderOf(r.name, input.prefix);
      if (folder === undefined) direct.push(r);
      else folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
    for (const [folder, count] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      items.push({
        label: `$(folder) ${folder}`,
        description: vscode.l10n.t('{0} branches', count),
        folder: `${input.prefix}${folder}/`,
        searchText: `${input.prefix}${folder}`,
      });
    }
    for (const r of direct) items.push(branchItem(r, icon));
  };

  if (input.current && inScope(input.current)) {
    items.push(sep(vscode.l10n.t('Current')));
    const cur = branchItem(input.current, 'check');
    cur.detail = input.current.upstream
      ? vscode.l10n.t('Tracks {0}', input.current.upstream)
      : vscode.l10n.t('No upstream');
    items.push(cur);
  }

  const favoriteRefs = input.locals.filter((b) => input.favorites.has(b.name) && !b.isHead);
  if (favoriteRefs.length > 0) section(vscode.l10n.t('Favorites'), favoriteRefs, 'star-full', true);

  const recentRefs = input.recent
    .map((name) => input.locals.find((b) => b.name === name))
    .filter((b): b is RefInfo => b !== undefined && !b.isHead && !input.favorites.has(b.name));
  if (recentRefs.length > 0) section(vscode.l10n.t('Recent'), recentRefs, 'history', true);

  section(
    vscode.l10n.t('Local'),
    input.locals.filter((b) => !b.isHead),
    'git-branch',
  );

  const byRemote = new Map<string, RefInfo[]>();
  for (const r of input.remotes) {
    const list = byRemote.get(r.remote ?? '') ?? [];
    list.push(r);
    byRemote.set(r.remote ?? '', list);
  }
  for (const [remote, refs] of [...byRemote.entries()].sort()) {
    section(vscode.l10n.t('Remote: {0}', remote), refs, 'cloud');
  }

  if (input.tags.length > 0) section(vscode.l10n.t('Tags'), input.tags, 'tag');
  return items;
}

export interface BranchesPopupDeps {
  core: Core;
  refService: RefService;
  ops: BranchOps;
  actions: readonly BranchAction[];
}

export async function showBranchesPopup(
  core: Core,
  repo: RepoHandle,
  refService: RefService,
  ops: BranchOps,
  actions: readonly BranchAction[] = [],
): Promise<void> {
  const qp = vscode.window.createQuickPick<BranchItem>();
  const stack: string[] = ['']; // breadcrumb of drill-in prefixes
  let showInOut = vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>('branches.showIncomingOutgoing', true);
  let filterText = '';

  qp.placeholder = vscode.l10n.t('Search for branches and actions');
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.buttons = [BTN_NEW, BTN_FETCH, BTN_INOUT, BTN_GEAR, BTN_VIEW];
  qp.busy = true;
  qp.show();

  const prefix = (): string => stack[stack.length - 1] ?? '';

  const populate = async (): Promise<void> => {
    const [recent, favorites] = await Promise.all([
      refService.getRecentBranches(),
      refService.getFavorites(),
    ]);
    const snap = repo.model.snapshot;
    qp.title =
      prefix().length > 0
        ? vscode.l10n.t('Branches · {0}', prefix().replace(/\/$/u, ''))
        : undefined;
    qp.items = buildPopupItems({
      current: refService.currentBranch,
      locals: refService.localBranches,
      remotes: refService.remoteBranches,
      tags: snap.refs.filter((r) => r.type === 'tag'),
      recent,
      favorites,
      prefix: prefix(),
      // Typing searches flat across every level — drill-in never traps anyone.
      filtering: filterText.trim().length > 0,
      showInOut,
    });
    qp.busy = false;
  };
  await populate();

  const openSubmenu = async (branch: RefInfo): Promise<void> => {
    qp.hide();
    await showBranchActions(core, repo, ops, branch, actions);
  };

  qp.onDidChangeValue(async (value) => {
    const wasFiltering = filterText.trim().length > 0;
    filterText = value;
    if (wasFiltering !== (value.trim().length > 0)) await populate();
  });

  qp.onDidTriggerItemButton(async (e) => {
    const branch = e.item.branch;
    if (!branch) return;
    if (e.button === ACTIONS) {
      await openSubmenu(branch);
      return;
    }
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
    } else if (button === BTN_INOUT) {
      showInOut = !showInOut;
      await vscode.workspace
        .getConfiguration('gittree')
        .update('branches.showIncomingOutgoing', showInOut, vscode.ConfigurationTarget.Workspace);
      await populate();
    } else if (button === BTN_GEAR) {
      qp.hide();
      await vscode.commands.executeCommand('workbench.action.openSettings', 'gittree.branches');
    } else {
      qp.hide();
      await vscode.commands.executeCommand('gittree.branches.focus');
    }
  });

  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    if (item.back === true) {
      stack.pop();
      qp.value = '';
      filterText = '';
      await populate();
      return;
    }
    if (item.folder !== undefined) {
      stack.push(item.folder);
      qp.value = '';
      filterText = '';
      await populate();
      return;
    }
    if (item.command !== undefined) {
      qp.hide();
      await vscode.commands.executeCommand(item.command, repo.root);
      return;
    }
    if (!item.branch) return;
    const defaultAction = vscode.workspace
      .getConfiguration('gittree')
      .get<string>('branches.defaultAction', 'checkout');
    if (defaultAction === 'showActions') {
      await openSubmenu(item.branch);
      return;
    }
    qp.hide();
    if (item.branch.isHead) return;
    if (item.isRemote) await ops.checkoutRemote(repo, item.branch.name);
    else await ops.checkout(repo, item.branch.name);
  });

  qp.onDidHide(() => qp.dispose());
}

interface ActionItem extends vscode.QuickPickItem {
  action?: BranchAction;
}

/**
 * The `›` submenu: exactly the reference list for this ref, with the labels
 * interpolated with the real branch names and separators between the groups.
 * Irrelevant items are **hidden, not disabled** — the acceptance criterion.
 */
export function buildBranchActionItems(
  actions: readonly BranchAction[],
  ctx: BranchActionContext,
  currentBranch: string | undefined,
): ActionItem[] {
  const applicable = applicableBranchActions(actions, ctx);
  const items: ActionItem[] = [];
  let lastGroup: string | undefined;
  for (const action of applicable) {
    const group = action.group ?? 'manage';
    if (lastGroup !== undefined && group !== lastGroup) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    lastGroup = group;
    items.push({
      label: action.label(ctx, currentBranch),
      ...(action.accelerator !== undefined ? { description: action.accelerator } : {}),
      action,
    });
  }
  return items;
}

/** Per-branch actions QuickPick (the `›` button, `→`, or Enter with showActions). */
export async function showBranchActions(
  core: Core,
  repo: RepoHandle,
  ops: BranchOps,
  branch: RefInfo,
  actions: readonly BranchAction[] = [],
): Promise<void> {
  const ctx: BranchActionContext = {
    repo,
    name: branch.name,
    type: refTypeOf(branch),
    isCurrent: branch.isHead === true,
  };
  const items = buildBranchActionItems(actions, ctx, repo.model.snapshot.headRef);
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('No actions available for {0}.', branch.name),
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: vscode.l10n.t('Actions for {0}', branch.name),
  });
  await picked?.action?.run(ctx);
  void ops;
  void core;
}
