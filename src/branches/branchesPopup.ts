/**
 * Branches popup as an **action hub** (P13-T5, gap analysis S3 · §2A
 * "Branches popup" / "Branch row submenu expanded").
 *
 * Still a native `QuickPick` — master §6 chose it over a webview for real focus,
 * search and keyboard parity, and the reference screenshot vindicates that: its
 * field reads *"Search for branches, actions, repositories"*.
 *
 * **new-way-2 reshaped how it goes deeper.** It used to *drill in*: picking a
 * repository or a folder replaced the list and added a `‹ Back` row, so every
 * step threw away what you were looking at. IntelliJ opens its levels as a tree,
 * in place, and so does this now — repositories, sections and folders carry
 * `˅`/`›` and expand underneath themselves. `popupTree.ts` holds that shape, and
 * the sidebar's Branches view renders the same rows, so the two surfaces cannot
 * come to disagree about what the tree contains.
 *
 * The one step that still changes surface is a ref's `›` action menu, because
 * that is a menu rather than a level: VS Code has no way to float a cascading
 * submenu beside a `QuickPick`, which is what deviation D5 records. That menu is
 * built from `branchActions.ts`, shared with both trees.
 *
 * Because that step is a surface swap, **it is on the `›` button alone**: a
 * click on a branch row does nothing at all. See `onDidAccept`.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { INTELLIJ_KEYMAP_SETTING, shownAccelerator } from '../ui/accelerators';
import { writeSetting } from '../ui/writeSetting';
import { collectNotifications, showCollected } from '../ui/notify';
import type { Core, RepoHandle } from '../core/core';
import type { RefInfo } from '../core/model/refs';
import { canonicalKey } from '../core/repoDiscovery';
import { repoLabels } from '../core/util/repoLabels';
import {
  applicableBranchActions,
  type BranchAction,
  type BranchActionContext,
  type BranchRefType,
} from './branchActions';
import type { BranchOps } from './branchOps';
import {
  applyShowTags,
  commonRefNames,
  flattenTree,
  HUB_VERBS,
  nodeIds,
  type CommonRef,
  type RepoRefs,
  type TreeRow,
} from './popupTree';
import type { RefService } from './refService';
import { showTagsSetting } from './showTags';
import { showInfo } from '../ui/notices';

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
  /** POST-P14p: a repository row at the project level — picking it drills in. */
  repoRoot?: string;
  /** POST-P14p: a ref every root has, whose actions run on all of them. */
  common?: CommonRef;
}

export { HUB_VERBS, commonRefNames } from './popupTree';
export type { CommonRef, HubVerb, RepoRefs, TreeRow } from './popupTree';

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
/**
 * §2A header: Fetch. It is **project-wide**, as IntelliJ's is — the one button
 * in this header fetches every root, which is why the tooltip says so whenever
 * there is more than one.
 */
export function fetchButtonTooltip(repoCount: number): string {
  return repoCount > 1 ? vscode.l10n.t('Fetch all repositories') : vscode.l10n.t('Fetch');
}

function makeFetchButton(repoCount: number): vscode.QuickInputButton {
  return { iconPath: new vscode.ThemeIcon('sync'), tooltip: fetchButtonTooltip(repoCount) };
}
/** §2A header: the incoming/outgoing toggle. */
const BTN_INOUT: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('arrow-swap'),
  tooltip: vscode.l10n.t('Show incoming/outgoing counts'),
};
/**
 * Shown only while a search is confined to one repository: widens it back to
 * every repository without closing the one you are in.
 */
const BTN_UNSCOPE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('close'),
  tooltip: vscode.l10n.t('Search all repositories'),
};
/** §2A header: collapse every open level back to the top. */
const BTN_COLLAPSE: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('collapse-all'),
  tooltip: vscode.l10n.t('Collapse all'),
};
/** §2A header: the gear (branch settings). */
const BTN_GEAR: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon('gear'),
  tooltip: vscode.l10n.t('Branch settings'),
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

/** `RefInfo.type` → the registry's ref kind, distinguishing the current branch. */
export function refTypeOf(ref: RefInfo): BranchRefType {
  if (ref.type !== 'head') return ref.type;
  return ref.isHead === true ? 'head' : 'local';
}

// ===========================================================================
// SUPERSEDED by `popupTree.ts` (new-way-2). Nothing in the product calls the
// four exports below any more — the drill-in popup they shaped is gone. They
// stay only because `phase02`, `phase13branches` and `projectPopup` still
// assert against them, and those suites are being left alone while the new
// shape settles. Delete all of this together with those assertions.
// ===========================================================================

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
  /** `gittree.keymap.intellij`: the verbs' accelerators are bound, so shown. */
  intellijKeymap?: boolean;
  /**
   * POST-P14p: show `‹ Back` even at prefix `''`. In a multi-root workspace a
   * repository's own popup sits one level below the project popup, so there is
   * somewhere to go back *to* before any folder has been drilled into.
   */
  forceBack?: boolean;
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
      const accelerator = shownAccelerator(v.accelerator, input.intellijKeymap === true);
      items.push({
        label: `$(${v.icon}) ${v.label}`,
        ...(accelerator !== undefined ? { description: accelerator } : {}),
        command: v.command,
        searchText: `${v.label} ${v.keywords ?? ''}`,
      });
    }
  }
  if (!input.filtering && (input.prefix.length > 0 || input.forceBack === true)) {
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

// ---------------------------------------------------------------------------
// POST-P14p — the project level, for a workspace with more than one root
// ---------------------------------------------------------------------------

/** One root, as the project level lists it. */
export interface RepoRow {
  readonly root: string;
  /** Folder name, which is what IntelliJ shows and what the log's picker uses. */
  readonly name: string;
  /** Current branch short name, or undefined when detached/unborn. */
  readonly currentBranch?: string;
  readonly detached?: boolean;
  readonly headSha?: string;
  /** Counts for the current branch, when the toggle is on. */
  readonly ahead?: number;
  readonly behind?: number;
}

export interface ProjectPopupInput {
  readonly repos: readonly RepoRow[];
  /** Ref names present in **every** root, already intersected. */
  readonly commonLocals: readonly string[];
  readonly commonRemotes: readonly string[];
  readonly commonTags: readonly string[];
  readonly filtering: boolean;
  readonly showInOut: boolean;
  /** `gittree.keymap.intellij`: the verbs' accelerators are bound, so shown. */
  readonly intellijKeymap?: boolean;
}

/** `develop · ↑2 ↓1` — the dim half of a repository row. */
export function repoRowDescription(repo: RepoRow, showInOut: boolean): string {
  const parts: string[] = [];
  if (repo.detached === true) {
    parts.push(vscode.l10n.t('detached at {0}', (repo.headSha ?? '').slice(0, 7)));
  } else {
    parts.push(repo.currentBranch ?? vscode.l10n.t('no branch'));
  }
  if (showInOut) {
    if ((repo.behind ?? 0) > 0) parts.push(`↓${repo.behind}`);
    if ((repo.ahead ?? 0) > 0) parts.push(`↑${repo.ahead}`);
  }
  return parts.join(' · ');
}

/**
 * The project level: the verbs, then one row per repository, then the refs
 * every root shares. This is the shape IntelliJ shows in a multi-root project,
 * and the reason it matters is not decoration — it is that **the repository is
 * visible and selectable rather than inferred**. Geet's popup used to be
 * bound to whichever root `pickRepo` guessed from the active editor and never
 * named it, so a scoped action could land in a repository the user was not
 * looking at with nothing on screen to say so.
 *
 * Only refs present in *every* root appear here (see `CommonRef`). Common
 * sections are flat: a folder row would have to fold a name that means a
 * different ref in each root, and drill-in already has one axis (the
 * repository) at this level.
 */
export function buildProjectPopupItems(input: ProjectPopupInput): BranchItem[] {
  const items: BranchItem[] = [];
  const sep = (label: string): BranchItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

  if (!input.filtering) {
    items.push(sep(vscode.l10n.t('Actions')));
    for (const v of HUB_VERBS) {
      const accelerator = shownAccelerator(v.accelerator, input.intellijKeymap === true);
      items.push({
        label: `$(${v.icon}) ${v.label}`,
        ...(accelerator !== undefined ? { description: accelerator } : {}),
        command: v.command,
        searchText: `${v.label} ${v.keywords ?? ''}`,
      });
    }
  }

  if (input.repos.length > 0) {
    items.push(sep(vscode.l10n.t('Repositories')));
    for (const repo of input.repos) {
      items.push({
        label: `$(repo) ${repo.name}`,
        description: repoRowDescription(repo, input.showInOut),
        repoRoot: repo.root,
        searchText: `${repo.name} ${repo.currentBranch ?? ''}`,
        buttons: [ACTIONS],
      });
    }
  }

  const commonSection = (
    label: string,
    names: readonly string[],
    kind: CommonRef['kind'],
    icon: string,
  ): void => {
    if (names.length === 0) return;
    items.push(sep(label));
    for (const name of names) {
      items.push({
        label: `$(${icon}) ${name}`,
        description: vscode.l10n.t('in all {0} repositories', input.repos.length),
        common: { name, kind },
        searchText: name,
        buttons: [ACTIONS],
      });
    }
  };

  commonSection(vscode.l10n.t('Common Local Branches'), input.commonLocals, 'local', 'git-branch');
  commonSection(vscode.l10n.t('Common Remote Branches'), input.commonRemotes, 'remote', 'cloud');
  commonSection(vscode.l10n.t('Common Tags'), input.commonTags, 'tag', 'tag');
  return items;
}

/**
 * An operation a common ref can carry out on **every** root at once — the
 * gap-analysis §3.10 row "Multi-repo, *Execute branch operations on all roots*".
 *
 * These are registry actions by id, so nothing here is a second implementation
 * of anything; only the *label* is rewritten, because the registry's labels
 * interpolate the current branch ("Merge 'x' into 'main'") and at the project
 * level the roots need not share one. A label that named the first root's
 * branch would be a lie about the other six.
 *
 * What is deliberately **not** here is everything that would prompt once per
 * root — `newFrom`, `rename`, `delete`, `deleteOnRemote`, `newWorktree` — or
 * open a view per root (`compareWithCurrent`, `diffWithWorkingTree`). IntelliJ
 * asks once and applies to all; Geet's `BranchOps` takes its input inside
 * the per-repository call, so offering them here would mean seven dialogs.
 * They stay reachable by drilling into a repository. Recorded as D27.
 */
export interface CommonActionSpec {
  /** `branchActions.ts` id — the behaviour is that action's, per root. */
  readonly id: string;
  /** Verb only; the "in all N repositories" half is one shared formatter. */
  readonly verb: string;
  readonly kinds: readonly CommonRef['kind'][];
}

export const COMMON_ACTIONS: readonly CommonActionSpec[] = [
  // POST-P14ax: a common remote branch too, as a local branch tracking it in each.
  { id: 'checkout', verb: 'Checkout', kinds: ['local', 'remote', 'tag'] },
  { id: 'update', verb: 'Update', kinds: ['local'] },
  {
    id: 'mergeIntoCurrent',
    verb: 'Merge into the current branch',
    kinds: ['local', 'remote', 'tag'],
  },
  {
    id: 'rebaseCurrentOnto',
    verb: 'Rebase the current branch onto it',
    kinds: ['local', 'remote'],
  },
  {
    id: 'pullIntoCurrent',
    verb: 'Pull into the current branch using Merge',
    kinds: ['remote'],
  },
  {
    id: 'pullIntoCurrentRebase',
    verb: 'Pull into the current branch using Rebase',
    kinds: ['remote'],
  },
  { id: 'push', verb: 'Push', kinds: ['local'] },
  { id: 'stopTracking', verb: 'Stop tracking', kinds: ['local'] },
];

/**
 * `Checkout in all 7 repositories` / `Checkout in 5 of 7 repositories`. The
 * partial form is not a hedge, it is the honest count: a branch three roots are
 * already on can be checked out in the other four, and a row that claimed all
 * seven would be wrong about three of them.
 */
export function commonActionLabel(verb: string, appliesIn: number, total: number): string {
  return appliesIn === total
    ? vscode.l10n.t('{0} in all {1} repositories', verb, total)
    : vscode.l10n.t('{0} in {1} of {2} repositories', verb, appliesIn, total);
}

export interface OfferableCommonAction {
  readonly spec: CommonActionSpec;
  readonly action: BranchAction;
  /** Roots where the action's own precondition holds right now. */
  readonly appliesIn: number;
}

/**
 * The all-roots actions offerable for `common`: the kind matches, the registry
 * has the action, and it applies in **at least one** root.
 *
 * "At least one", not "all", and the difference is the whole usability of the
 * row: requiring every root would hide `Checkout` the moment a single root was
 * already on that branch — which is the ordinary state of a project whose
 * repositories track one branch, and exactly when you want to bring the
 * stragglers across. `runCommonAction` skips the roots where it does not
 * apply, and the label says how many it will actually touch.
 */
export function applicableCommonActions(
  specs: readonly CommonActionSpec[],
  actions: readonly BranchAction[],
  common: CommonRef,
  contexts: readonly BranchActionContext[],
): OfferableCommonAction[] {
  if (contexts.length === 0) return [];
  const out: OfferableCommonAction[] = [];
  for (const spec of specs) {
    if (!spec.kinds.includes(common.kind)) continue;
    const action = actions.find((a) => a.id === spec.id);
    if (!action) continue;
    const appliesIn = contexts.filter((ctx) => action.applies(ctx)).length;
    if (appliesIn === 0) continue;
    out.push({ spec, action, appliesIn });
  }
  return out;
}

export interface BranchesPopupDeps {
  core: Core;
  refService: RefService;
  ops: BranchOps;
  actions: readonly BranchAction[];
}

/** Three non-breaking spaces per level — a `QuickPick` collapses plain ones. */
const INDENT = '   ';

interface TreeItem extends vscode.QuickPickItem {
  row?: TreeRow;
}

/**
 * One row → one `QuickPickItem`. `alwaysShow` is set on every item because the
 * filtering is ours: `buildTree` decides what matches, against the *ref names*
 * rather than against a label carrying indentation and disclosure glyphs.
 */
export function toQuickPickItems(
  rows: readonly TreeRow[],
  open: ReadonlySet<string>,
  intellijKeymap = false,
): TreeItem[] {
  const items: TreeItem[] = [];
  for (const row of rows) {
    if (row.separator !== undefined) {
      items.push({ label: row.separator, kind: vscode.QuickPickItemKind.Separator });
    }
    const disclosure = row.expandable
      ? open.has(row.id)
        ? '$(chevron-down) '
        : '$(chevron-right) '
      : '';
    const buttons: vscode.QuickInputButton[] = [];
    if (row.kind === 'ref' && row.ref?.type !== 'tag') {
      buttons.push(row.favorite === true ? STAR_ON : STAR_OFF);
    }
    if (row.actions) buttons.push(ACTIONS);
    const description = row.description ?? shownAccelerator(row.verb?.accelerator, intellijKeymap);
    items.push({
      label: `${INDENT.repeat(row.depth)}${disclosure}$(${row.icon}) ${row.label}`,
      ...(description !== undefined ? { description } : {}),
      alwaysShow: true,
      ...(buttons.length > 0 ? { buttons } : {}),
      row,
    });
  }
  return items;
}

/**
 * The branches popup: **one list that opens in place**.
 *
 * It used to drill in — picking a repository or a folder replaced the whole
 * list and added a `‹ Back` row — so going deeper threw away what you were
 * looking at and every step changed the surface under your cursor. IntelliJ
 * opens levels as a tree instead, and so does this now: repositories, sections
 * and folders carry `˅`/`›` and expand underneath themselves.
 *
 * The one step that still changes surface is a ref's action menu, because that
 * is a menu rather than a level, and VS Code has no way to float a cascading
 * submenu beside a `QuickPick` (deviation D5).
 *
 * `entry` is the repository the caller came from: it decides what starts open,
 * so clicking the status-bar widget lands you inside your own repository rather
 * than at a closed list of seven.
 */
export async function showBranchesPopup(
  core: Core,
  entry: RepoHandle,
  refServiceFor: (repo: RepoHandle) => RefService,
  ops: BranchOps,
  actions: readonly BranchAction[] = [],
): Promise<void> {
  const qp = vscode.window.createQuickPick<TreeItem>();
  const multiRoot = core.repos.length > 1;
  const expanded = new Set<string>();
  let showInOut = vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>('branches.showIncomingOutgoing', true);

  /**
   * The repository a search is confined to: the one the user last opened by
   * clicking its row. IntelliJ gives a repository its own panel with its own
   * search box; a `QuickPick` has one box, so the box follows the repository
   * you went into. Unset, a search covers every repository.
   *
   * It is deliberately *not* preset from `entry`, even though that repository
   * starts open: someone who opens the popup and types at once is searching
   * the project, which is what IntelliJ's first panel does too.
   */
  let searchScope: string | undefined;
  /** Nodes shut inside the current results; forgotten whenever the query changes. */
  const searchCollapsed = new Set<string>();
  const searching = (): boolean => qp.value.trim().length > 0;
  const sameRoot = (a: string, b: string): boolean => canonicalKey(a) === canonicalKey(b);

  // What is open when the popup appears: the repository you came from, and its
  // local branches, which is the list anyone opening this is looking for.
  if (multiRoot) expanded.add(nodeIds.repo(entry.root));
  expanded.add(nodeIds.locals(entry.root));

  const btnFetch = makeFetchButton(core.repos.length);
  // Our own filter owns the matching; see `toQuickPickItems`.
  qp.matchOnDescription = false;
  qp.matchOnDetail = false;
  qp.busy = true;
  qp.show();

  const repoRefs = async (repo: RepoHandle, labels: Map<string, string>): Promise<RepoRefs> => {
    const service = refServiceFor(repo);
    const snap = repo.model.snapshot;
    const favorites = await service.getFavorites();
    return {
      root: repo.root,
      // The same naming rule the sidebar's two lists use, so a repository reads
      // the same in all three (`core/util/repoLabels`).
      name: labels.get(repo.root) ?? path.basename(repo.root),
      ...(snap.headRef !== undefined ? { currentBranch: snap.headRef } : {}),
      ...(snap.detached ? { detached: true } : {}),
      ...(snap.headSha !== undefined ? { headSha: snap.headSha } : {}),
      ...(snap.ahead !== undefined ? { ahead: snap.ahead } : {}),
      ...(snap.behind !== undefined ? { behind: snap.behind } : {}),
      locals: service.localBranches,
      remotes: service.remoteBranches,
      tags: service.tags,
      favorites,
    };
  };

  /**
   * Rebuild, keeping the cursor on `keepId` so opening a node never scrolls
   * away. `generation` drops a build whose favourites resolved after a newer
   * one started — typing quickly starts several, and the last to *finish* is
   * not necessarily the one that matches what is in the box.
   */
  let generation = 0;
  const populate = async (keepId?: string): Promise<void> => {
    const mine = ++generation;
    // A repository that left while it was the scope takes the scope with it.
    if (searchScope !== undefined && !core.repos.some((r) => sameRoot(r.root, searchScope!))) {
      searchScope = undefined;
    }
    const labels = repoLabels(core.repos.map((r) => r.root));
    const repos = await Promise.all(core.repos.map((r) => repoRefs(r, labels)));
    const ctx = applyShowTags(
      {
        repos,
        commonLocals: commonRefNames(repos.map((r) => r.locals.map((b) => b.name))),
        commonRemotes: commonRefNames(repos.map((r) => r.remotes.map((b) => b.name))),
        commonTags: commonRefNames(repos.map((r) => r.tags.map((t) => t.name))),
        showInOut,
      },
      showTagsSetting(),
    );
    if (mine !== generation) return;

    const scopeRoot =
      searchScope !== undefined ? repos.find((r) => sameRoot(r.root, searchScope!))?.root : undefined;
    const scopeName = scopeRoot !== undefined ? labels.get(scopeRoot) : undefined;

    // The box says what it searches. Once someone is typing the placeholder is
    // gone, but by then the results name the repository in every section title.
    qp.placeholder =
      scopeName !== undefined
        ? vscode.l10n.t('Search branches in {0}', scopeName)
        : vscode.l10n.t('Search for branches, actions, repositories');
    qp.buttons =
      scopeName !== undefined
        ? [BTN_UNSCOPE, BTN_COLLAPSE, btnFetch, BTN_INOUT, BTN_GEAR]
        : [BTN_COLLAPSE, btnFetch, BTN_INOUT, BTN_GEAR];

    const flat = flattenTree(ctx, expanded, qp.value, {
      ...(scopeRoot !== undefined ? { scope: scopeRoot } : {}),
      searchCollapsed,
    });
    qp.items = toQuickPickItems(
      flat.rows,
      flat.open,
      vscode.workspace.getConfiguration('gittree').get<boolean>(INTELLIJ_KEYMAP_SETTING, false),
    );
    if (keepId !== undefined) {
      const found = qp.items.find((i) => i.row?.id === keepId);
      if (found) qp.activeItems = [found];
    }
    qp.busy = false;
  };
  await populate();

  /** The repository a row belongs to, or the entry root for rows that have none. */
  const repoOf = (row: TreeRow): RepoHandle =>
    (row.repoRoot !== undefined ? core.getRepo(row.repoRoot) : undefined) ?? entry;

  const openRefActions = async (row: TreeRow): Promise<void> => {
    if (!row.ref) return;
    qp.hide();
    await showBranchActions(core, repoOf(row), ops, row.ref, actions);
  };

  const toggle = async (row: TreeRow): Promise<void> => {
    if (expanded.has(row.id)) expanded.delete(row.id);
    else expanded.add(row.id);
    await populate(row.id);
  };

  /**
   * A repository row: **the first click goes in, the next one comes out.**
   *
   * Going in opens the repository and makes it what the search box searches.
   * Clicking the repository you are already in closes it and widens the search
   * back to the whole project. A repository that was merely open — the one the
   * popup started on — is gone *into* by its first click, not closed by it,
   * because nobody clicks a repository to make it disappear.
   *
   * Picked from search results, it is gone into with an empty box: the words
   * that found the repository are not words that will find its branches.
   */
  const openRepository = async (row: TreeRow): Promise<void> => {
    const root = row.repoRoot;
    if (root === undefined) return;
    searchCollapsed.clear();
    if (searching()) {
      searchScope = root;
      expanded.add(row.id);
      expanded.add(nodeIds.locals(root));
      qp.value = '';
      await populate(row.id);
      return;
    }
    const inside = searchScope !== undefined && sameRoot(searchScope, root);
    if (inside && expanded.has(row.id)) {
      expanded.delete(row.id);
      searchScope = undefined;
    } else {
      expanded.add(row.id);
      searchScope = root;
    }
    await populate(row.id);
  };

  /** A section or folder inside search results opens and shuts on its own set. */
  const toggleInSearch = async (row: TreeRow): Promise<void> => {
    if (searchCollapsed.has(row.id)) searchCollapsed.delete(row.id);
    else searchCollapsed.add(row.id);
    await populate(row.id);
  };

  const runVerb = async (row: TreeRow): Promise<void> => {
    if (!row.verb) return;
    qp.hide();
    // A repository's own copy of a verb runs there. The project-level ones take
    // no argument: `gittree.commit` spans every root, and so does
    // `gittree.update.dialog` (POST-P14ae) — one question, every repository.
    if (row.repoRoot !== undefined) {
      await vscode.commands.executeCommand(row.verb.command, row.repoRoot);
    } else {
      await vscode.commands.executeCommand(row.verb.command);
    }
  };

  qp.onDidChangeValue(async () => {
    searchCollapsed.clear();
    await populate();
  });

  qp.onDidTriggerItemButton(async (e) => {
    const row = e.item.row;
    if (!row) return;
    if (e.button === ACTIONS) {
      if (row.kind === 'ref') await openRefActions(row);
      else if (row.kind === 'repo') await openRepository(row);
      else if (row.common !== undefined) {
        qp.hide();
        await showCommonBranchActions(core, row.common, actions);
      } else if (row.expandable) await toggle(row);
      return;
    }
    // The star.
    if (row.ref === undefined) return;
    await refServiceFor(repoOf(row)).toggleFavorite(row.ref.name);
    await populate(row.id);
  });

  qp.onDidTriggerButton(async (button) => {
    if (button === btnFetch) {
      qp.busy = true;
      // No argument: every root, exactly as IntelliJ's popup Fetch does.
      await vscode.commands.executeCommand('gittree.fetch');
      await populate();
    } else if (button === BTN_INOUT) {
      showInOut = !showInOut;
      await writeSetting('gittree', 'branches.showIncomingOutgoing', showInOut);
      await populate();
    } else if (button === BTN_COLLAPSE) {
      expanded.clear();
      searchCollapsed.clear();
      await populate();
    } else if (button === BTN_UNSCOPE) {
      searchScope = undefined;
      searchCollapsed.clear();
      await populate();
    } else if (button === BTN_GEAR) {
      qp.hide();
      await vscode.commands.executeCommand('workbench.action.openSettings', 'gittree.branches');
    }
  });

  qp.onDidAccept(async () => {
    const row = qp.selectedItems[0]?.row;
    if (!row || row.kind === 'info') return;
    if (row.kind === 'repo') {
      await openRepository(row);
      return;
    }
    // A node with children opens where it stands. This is the whole point:
    // nothing is replaced, so the row you clicked is still under your cursor.
    if (row.expandable) {
      if (searching()) await toggleInSearch(row);
      else await toggle(row);
      return;
    }
    if (row.verb !== undefined) {
      await runVerb(row);
      return;
    }
    /**
     * **A branch row is inert.** Clicking one neither checks it out nor opens
     * its menu; it lands the cursor there and nothing else. Its `›` button
     * opens the menu.
     *
     * The reason is that the menu cannot be what IntelliJ's is. IntelliJ floats
     * a submenu *beside* the row and leaves the branch list standing; VS Code
     * has no way to float anything next to a `QuickPick` (D5), so opening a menu
     * here means replacing the whole list with a second `QuickPick`. That is a
     * surface swap, and a surface swap bound to the one gesture people use to
     * move around a list means the list cannot be read without being thrown out
     * of it. On the `›` button the same swap is fine: pressing a button that
     * says "menu" is a request for one, not a side effect of pointing at a row.
     *
     * Enter goes the same way, not because Enter deserves to be inert but
     * because `onDidAccept` is the whole of what a `QuickPick` reports — a click
     * and Enter arrive here indistinguishable. The sidebar can tell them apart
     * and keeps Enter as its keyboard path to the menu.
     */
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
    // No accelerator here: an action's (F2, Delete) is the Repositories
    // panel's own key, and a QuickPick, its input focused, never sees it
    // (POST-QA: Rename… said F2, and F2 did nothing).
    items.push({ label: action.label(ctx, currentBranch), action });
  }
  return items;
}

/** Per-branch actions QuickPick — the `›` button on a row, never a click on it. */
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
    showInfo(
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

// ---------------------------------------------------------------------------
// POST-P14p — running one operation on every root
// ---------------------------------------------------------------------------

/** The per-root context for a common ref. `isCurrent` is read per root. */
export function commonContexts(
  repos: readonly RepoHandle[],
  common: CommonRef,
): BranchActionContext[] {
  return repos.map((repo) => ({
    repo,
    name: common.name,
    type: common.kind === 'local' && repo.model.snapshot.headRef === common.name
      ? ('head' as const)
      : common.kind,
    isCurrent: common.kind === 'local' && repo.model.snapshot.headRef === common.name,
  }));
}

/**
 * Runs one registry action once per root, **in order, stopping at the first
 * failure** — the idiom `runCommitAcross` established. Carrying on past a
 * refusal would start a merge in roots 3…7 while root 2 sits in conflict, and
 * the report would have to describe a half-applied operation.
 *
 * A failure is a thrown error, or (POST-P14ad) an action resolving `false`:
 * one that reported its own failure and returned, as `Update` does. Before
 * that was honoured, only exceptions stopped the fan-out, and `Update in all
 * N repositories` ran on past a conflicted root.
 */
export async function runCommonAction(
  repos: readonly RepoHandle[],
  common: CommonRef,
  actions: readonly BranchAction[],
  actionId: string,
): Promise<void> {
  const action = actions.find((a) => a.id === actionId);
  if (!action) return;
  const contexts = commonContexts(repos, common);
  const targets = contexts.filter((ctx) => action.applies(ctx));
  if (targets.length === 0) {
    // Every root is already there (or none can) — say so rather than appear
    // to do nothing, which is what an empty loop would have looked like.
    showInfo(
      vscode.l10n.t('Nothing to do: "{0}" already applies in every repository.', common.name),
    );
    return;
  }
  if (action.runAll) {
    await action.runAll(targets);
    return;
  }
  // One notification for all of them, as IntelliJ's multi-root operations
  // say it — not `Checked out develop` once per repository.
  const { result: finished, collected } = await collectNotifications(() => runEach(targets, action));
  if (finished) showCollected(collected);
}

/**
 * The fan-out itself: each repository in turn, stopping at the first that
 * fails and saying which ones were already done. Resolves `true` when every
 * one went through.
 */
async function runEach(
  targets: readonly BranchActionContext[],
  action: BranchAction,
): Promise<boolean> {
  const done: string[] = [];
  for (const ctx of targets) {
    const name = path.basename(ctx.repo.root);
    try {
      if ((await action.run(ctx)) === false) {
        // The action has said what went wrong; what it cannot know is that it
        // was one of several, and which of the others already happened.
        void vscode.window.showWarningMessage(
          done.length > 0
            ? vscode.l10n.t('Stopped at {0}. Already done in: {1}.', name, done.join(', '))
            : vscode.l10n.t('Stopped at {0}. Nothing was changed.', name),
        );
        return false;
      }
      done.push(name);
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split('\n', 1)[0] ?? '';
      void vscode.window.showErrorMessage(
        done.length > 0
          ? vscode.l10n.t(
              'Stopped at {0}: {1}. Already done in: {2}.',
              name,
              reason,
              done.join(', '),
            )
          : vscode.l10n.t('Stopped at {0}: {1}. Nothing was changed.', name, reason),
      );
      return false;
    }
  }
  return true;
}

interface CommonActionItem extends vscode.QuickPickItem {
  spec?: CommonActionSpec;
}

/** The `›` submenu of a common ref: the all-roots operations, and only those. */
export function buildCommonActionItems(
  offerable: readonly OfferableCommonAction[],
  repoCount: number,
): CommonActionItem[] {
  return offerable.map(({ spec, appliesIn }) => ({
    label: commonActionLabel(spec.verb, appliesIn, repoCount),
    spec,
  }));
}

export async function showCommonBranchActions(
  core: Core,
  common: CommonRef,
  actions: readonly BranchAction[] = [],
): Promise<void> {
  const contexts = commonContexts(core.repos, common);
  const offerable = applicableCommonActions(COMMON_ACTIONS, actions, common, contexts);
  if (offerable.length === 0) {
    showInfo(
      vscode.l10n.t(
        'No operation applies to "{0}" in all {1} repositories. Open a repository to act on it there.',
        common.name,
        core.repos.length,
      ),
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    buildCommonActionItems(offerable, core.repos.length),
    { placeHolder: vscode.l10n.t('Actions for {0} across every repository', common.name) },
  );
  if (!picked?.spec) return;
  await runCommonAction(core.repos, common, actions, picked.spec.id);
}
