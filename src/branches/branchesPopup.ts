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
import * as path from 'node:path';
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
  /** POST-P14p: a repository row at the project level — picking it drills in. */
  repoRoot?: string;
  /** POST-P14p: a ref every root has, whose actions run on all of them. */
  common?: CommonRef;
}

/**
 * A ref name that exists in **every** root, which is what makes it actionable
 * across all of them. IntelliJ calls these `Common Local Branches` / `Common
 * Remote Branches` / `Common Tags`, and shows nothing else at the project
 * level — a branch only two of five roots have is reachable by drilling into
 * one of those two, not from here, because there is no coherent all-roots
 * operation to offer for it.
 */
export interface CommonRef {
  readonly name: string;
  readonly kind: 'local' | 'remote' | 'tag';
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
      items.push({
        label: `$(${v.icon}) ${v.label}`,
        ...(v.accelerator !== undefined ? { description: v.accelerator } : {}),
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
 * visible and selectable rather than inferred**. GitTree's popup used to be
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
      items.push({
        label: `$(${v.icon}) ${v.label}`,
        ...(v.accelerator !== undefined ? { description: v.accelerator } : {}),
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
 * Names carried by every one of `perRepo`, sorted. An empty workspace, or one
 * root with no refs of that kind, yields nothing — "common to all" of an empty
 * set would otherwise be "everything the others have", which is the opposite
 * of what the row promises.
 */
export function commonRefNames(perRepo: readonly (readonly string[])[]): string[] {
  const [first, ...rest] = perRepo;
  if (first === undefined || perRepo.length === 0) return [];
  const shared = new Set(first);
  for (const names of rest) {
    const here = new Set(names);
    for (const name of [...shared]) if (!here.has(name)) shared.delete(name);
  }
  return [...shared].sort((a, b) => a.localeCompare(b));
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
 * asks once and applies to all; GitTree's `BranchOps` takes its input inside
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
  { id: 'checkout', verb: 'Checkout', kinds: ['local', 'tag'] },
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

/** One popup level: the project (`repo` undefined) or one root at a prefix. */
interface PopupLevel {
  readonly repo?: RepoHandle;
  readonly prefix: string;
}

/**
 * The branches popup. With more than one root it opens at the **project
 * level** — repository rows plus the refs every root shares — and picking a
 * repository drills into that root's own popup, which is the popup that
 * existed before and is unchanged. With one root it opens straight there, so
 * nothing changes for a single-repository workspace.
 *
 * `entry` is the root the caller named (the status bar names its own). At the
 * project level it is not the popup's scope — it only decides which repository
 * row starts selected, so clicking the status-bar widget lands you on your
 * repository inside the whole project rather than alone inside it.
 */
export async function showBranchesPopup(
  core: Core,
  entry: RepoHandle,
  refServiceFor: (repo: RepoHandle) => RefService,
  ops: BranchOps,
  actions: readonly BranchAction[] = [],
): Promise<void> {
  const qp = vscode.window.createQuickPick<BranchItem>();
  const multiRoot = core.repos.length > 1;
  const stack: PopupLevel[] = [multiRoot ? { prefix: '' } : { repo: entry, prefix: '' }];
  let showInOut = vscode.workspace
    .getConfiguration('gittree')
    .get<boolean>('branches.showIncomingOutgoing', true);
  let filterText = '';

  const btnFetch = makeFetchButton(core.repos.length);

  qp.placeholder = vscode.l10n.t('Search for branches and actions');
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  /**
   * `New branch` acts on *a* repository, and at the project level there is not
   * one — `newBranchFrom` takes its name inside the per-repository call, so
   * fanning it out would ask seven times. It comes back the moment a
   * repository is in scope. (Fetch is the opposite case and stays: it is a
   * project operation everywhere.)
   */
  const buttonsFor = (at: PopupLevel): vscode.QuickInputButton[] =>
    at.repo === undefined
      ? [btnFetch, BTN_INOUT, BTN_GEAR, BTN_VIEW]
      : [BTN_NEW, btnFetch, BTN_INOUT, BTN_GEAR, BTN_VIEW];
  qp.busy = true;
  qp.show();

  const level = (): PopupLevel => stack[stack.length - 1] ?? { prefix: '' };
  /** The root in scope, or the entry root when the project level is showing. */
  const scopedOr = (): RepoHandle => level().repo ?? entry;

  const push = async (next: PopupLevel): Promise<void> => {
    stack.push(next);
    qp.value = '';
    filterText = '';
    await populate();
  };

  const repoRows = (): RepoRow[] =>
    core.repos.map((r) => {
      const snap = r.model.snapshot;
      return {
        root: r.root,
        name: path.basename(r.root),
        ...(snap.headRef !== undefined ? { currentBranch: snap.headRef } : {}),
        ...(snap.detached ? { detached: true } : {}),
        ...(snap.headSha !== undefined ? { headSha: snap.headSha } : {}),
        ...(snap.ahead !== undefined ? { ahead: snap.ahead } : {}),
        ...(snap.behind !== undefined ? { behind: snap.behind } : {}),
      };
    });

  const populateProject = (): void => {
    const services = core.repos.map((r) => refServiceFor(r));
    qp.title = vscode.l10n.t('{0} repositories', core.repos.length);
    qp.items = buildProjectPopupItems({
      repos: repoRows(),
      commonLocals: commonRefNames(services.map((s) => s.localBranches.map((b) => b.name))),
      commonRemotes: commonRefNames(services.map((s) => s.remoteBranches.map((b) => b.name))),
      commonTags: commonRefNames(services.map((s) => s.tags.map((t) => t.name))),
      filtering: filterText.trim().length > 0,
      showInOut,
    });
  };

  const populateRepo = async (repo: RepoHandle, prefix: string): Promise<void> => {
    const refService = refServiceFor(repo);
    const [recent, favorites] = await Promise.all([
      refService.getRecentBranches(),
      refService.getFavorites(),
    ]);
    const snap = repo.model.snapshot;
    // The repository is named whenever it is one of several — the popup used
    // to be scoped to a root it never identified.
    const crumbs = [
      ...(multiRoot ? [path.basename(repo.root)] : []),
      ...(prefix.length > 0 ? [prefix.replace(/\/$/u, '')] : []),
    ];
    qp.title = crumbs.length > 0 ? crumbs.join(' · ') : undefined;
    qp.items = buildPopupItems({
      current: refService.currentBranch,
      locals: refService.localBranches,
      remotes: refService.remoteBranches,
      tags: snap.refs.filter((r) => r.type === 'tag'),
      recent,
      favorites,
      prefix,
      // Typing searches flat across every level — drill-in never traps anyone.
      filtering: filterText.trim().length > 0,
      showInOut,
      // At the project level there is a level above this one to go back to.
      forceBack: multiRoot && prefix.length === 0,
    });
  };

  const populate = async (): Promise<void> => {
    const at = level();
    qp.buttons = buttonsFor(at);
    if (at.repo === undefined) populateProject();
    else await populateRepo(at.repo, at.prefix);
    qp.busy = false;
  };
  await populate();

  // Clicking the status-bar widget should land on that widget's repository.
  if (multiRoot) {
    const mine = qp.items.find((i) => i.repoRoot === entry.root);
    if (mine) qp.activeItems = [mine];
  }

  const openSubmenu = async (branch: RefInfo): Promise<void> => {
    qp.hide();
    await showBranchActions(core, scopedOr(), ops, branch, actions);
  };

  const openCommonSubmenu = async (common: CommonRef): Promise<void> => {
    qp.hide();
    await showCommonBranchActions(core, common, actions);
  };

  qp.onDidChangeValue(async (value) => {
    const wasFiltering = filterText.trim().length > 0;
    filterText = value;
    if (wasFiltering !== (value.trim().length > 0)) await populate();
  });

  qp.onDidTriggerItemButton(async (e) => {
    if (e.item.repoRoot !== undefined) {
      const repo = core.getRepo(e.item.repoRoot);
      if (repo) await push({ repo, prefix: '' });
      return;
    }
    if (e.item.common !== undefined) {
      await openCommonSubmenu(e.item.common);
      return;
    }
    const branch = e.item.branch;
    if (!branch) return;
    if (e.button === ACTIONS) {
      await openSubmenu(branch);
      return;
    }
    await refServiceFor(scopedOr()).toggleFavorite(branch.name);
    await populate();
  });

  qp.onDidTriggerButton(async (button) => {
    if (button === BTN_NEW) {
      qp.hide();
      await ops.newBranchFrom(scopedOr(), 'HEAD');
    } else if (button === btnFetch) {
      qp.busy = true;
      // No argument: every root, exactly as IntelliJ's popup Fetch does.
      await vscode.commands.executeCommand('gittree.fetch');
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
      // POST-P14u: the Branches view is contributed unconditionally now, so
      // the context key this used to arm first (D26's reveal-on-demand dance)
      // has nothing left to unlock.
      await vscode.commands.executeCommand('gittree.branches.focus');
    }
  });

  qp.onDidAccept(async () => {
    const item = qp.selectedItems[0];
    if (!item) return;
    const at = level();
    if (item.back === true) {
      if (stack.length > 1) stack.pop();
      qp.value = '';
      filterText = '';
      await populate();
      return;
    }
    if (item.repoRoot !== undefined) {
      const picked = core.getRepo(item.repoRoot);
      if (picked) await push({ repo: picked, prefix: '' });
      return;
    }
    if (item.folder !== undefined) {
      await push({ ...(at.repo ? { repo: at.repo } : {}), prefix: item.folder });
      return;
    }
    if (item.command !== undefined) {
      qp.hide();
      // The level decides the scope. Inside a repository the verbs carry its
      // root, as they always have; at the project level they carry none, so
      // `gittree.commit` spans every root and `gittree.fetch` fetches all of
      // them — which is what those verbs mean in IntelliJ's project popup.
      if (at.repo === undefined) await vscode.commands.executeCommand(item.command);
      else await vscode.commands.executeCommand(item.command, at.repo.root);
      return;
    }
    if (item.common !== undefined) {
      const defaultAction = vscode.workspace
        .getConfiguration('gittree')
        .get<string>('branches.defaultAction', 'checkout');
      if (defaultAction === 'showActions') {
        await openCommonSubmenu(item.common);
        return;
      }
      qp.hide();
      await runCommonAction(core.repos, item.common, actions, 'checkout');
      return;
    }
    if (!item.branch) return;
    const scoped = at.repo ?? entry;
    const defaultAction = vscode.workspace
      .getConfiguration('gittree')
      .get<string>('branches.defaultAction', 'checkout');
    if (defaultAction === 'showActions') {
      await openSubmenu(item.branch);
      return;
    }
    qp.hide();
    if (item.branch.isHead) return;
    if (item.isRemote) await ops.checkoutRemote(scoped, item.branch.name);
    else await ops.checkout(scoped, item.branch.name);
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
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Nothing to do: "{0}" already applies in every repository.', common.name),
    );
    return;
  }
  const done: string[] = [];
  for (const ctx of targets) {
    const name = path.basename(ctx.repo.root);
    try {
      await action.run(ctx);
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
      return;
    }
  }
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
    void vscode.window.showInformationMessage(
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
