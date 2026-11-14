/**
 * commitTree (P11-T2): turns a `CommitStateDto` into the tree the commit
 * window renders — one group row per changelist (plus Unversioned Files),
 * IntelliJ folder rows beneath, files at the leaves.
 *
 * **The same changelist across repositories is ONE row.** IntelliJ's changelist
 * is a project-level object: one `Changes` node holding every VCS root, with
 * repository rows beneath it. GitTree stores a changelist per repository, so
 * this is where the two are reconciled — the storage stays per repo, the tree
 * reads as IntelliJ's.
 *
 * **Or repositories first** (`gittree.commit.groupBy: repository`, GitTree's
 * own, D37): one row per repository with changes, its own changelists beneath.
 * Only a workspace of several repositories has the choice; one repository has
 * no repository rows to arrange.
 *
 * **Or no changelist rows at all** (`none`, the default since POST-P14cb, D44):
 * every changed file under its repository, as VS Code's Source Control view
 * lists them; with one repository, at the top. With changelists a repository's
 * files are one list, each still in its own changelist; with staging its halves
 * (Staged, Unstaged, Unversioned) stay rows of their own. Merge Conflicts is a
 * row first in both, as it blocks the commit.
 *
 * **Folders or a list** (`gittree.commit.groupByDirectory`, POST-P14cb): IntelliJ's
 * Group By › Directory, in every grouping. Off, the files are one list in path
 * order and each row names its folder; a file's path is the same either way.
 *
 * Pure so the identity rules are unit-tested rather than discovered in the UI:
 *   - node paths are namespaced per group and per repo, because two changelists
 *     may both contain `api/` and must not share an expansion key or a checkbox
 *     rollup, and neither may two repositories inside one group;
 *   - the two groupings never share a path (`@g:` first or `@r:` first), so
 *     each keeps its own folders open or shut;
 *   - the returned `files` map is the only way back from a tree path to
 *     `(repoRoot, relPath)`, so a folder toggle can be split into one host call
 *     per repository; `folders` and `groups` do the same for the other rows, so
 *     a selection survives a change of grouping (`twinRow`).
 */
import {
  commitGroupByOf,
  stagingSideOf,
  CONFLICTS_GROUP_ID,
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitDiffFileDto,
  type CommitGroupBy,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitRepoHeadDto,
  type CommitRevealParamsDto,
  type CommitStateDto,
  type StagingSide,
} from '../../../src/shared/protocol';
import { statusColor, statusIcon, type StatusColorOverrides, type StatusKind } from '../lib/status';
import {
  buildList,
  buildTree,
  collectFiles,
  countFiles,
  diffWalk,
  selectedFiles,
  type CheckState,
  type ToggleDelta,
  type TreeNode,
} from '../lib/treeModel';

export interface CommitFileRef {
  readonly repoRoot: string;
  readonly relPath: string;
  readonly change: CommitChangeDto;
  /**
   * With staging only (POST-QA F5): the node the row is in — Staged, Unstaged,
   * Unversioned or Merge Conflicts — which decides its diff and Stage/Unstage.
   */
  readonly side?: StagingSide;
}

/** A row's half of the index with staging (POST-QA F5): what its diff compares, what Stage does. */
export function fileSide(ref: CommitFileRef): StagingSide | undefined {
  return ref.side;
}

/** A diff request for a row: the file, and with staging, which of its rows. */
function diffFileOf(ref: CommitFileRef): CommitDiffFileDto {
  const side = fileSide(ref);
  return { repoRoot: ref.repoRoot, path: ref.relPath, ...(side !== undefined ? { side } : {}) };
}

/** One repository's copy of a changelist — what a scoped action acts on. */
export interface CommitListTarget {
  readonly repoRoot: string;
  readonly listId: string;
}

/**
 * P14-T2: a group row's identity, so the native context menu can name the
 * changelist it was opened on. Derivable from the node path in principle, but
 * the key joins with `:` and a Windows repo root contains one — parsing it back
 * would be guesswork.
 *
 * A `group` row may stand for the same changelist in several repositories, so
 * `targets` is the general shape; `repoRoot`/`listId` are set only when the row
 * means exactly one of them, which is every row in a single-root workspace and
 * every `repo` row in a multi-root one.
 */
export interface CommitGroupRef {
  /**
   * `group`: a changelist, of one repository or merged across several.
   * `repo`: one repository's copy of a changelist, which is the repository row
   * under a list (Changelist › Repository) and the list row under a repository
   * (Repository › Changelist) alike: the same scope, so the same menu.
   * `repository`: every change of one repository (Repository › Changelist).
   */
  readonly kind: 'group' | 'repo' | 'repository';
  /**
   * What the row draws: a changelist (a folder in its files' status colour) or
   * a repository (its colour, its name in plain text, its branch).
   */
  readonly shows: 'list' | 'repository';
  readonly targets: readonly CommitListTarget[];
  readonly isDefault: boolean;
  readonly checkable: boolean;
  readonly repoRoot?: string;
  readonly listId?: string;
  /**
   * A row showing a repository: its palette slot. It wears its repository's
   * colour, as IntelliJ's repository node wears the log's root colour, not its
   * files' status.
   */
  readonly colorIdx?: number;
  /** A row showing a repository: what it has checked out, which its label names. */
  readonly head?: CommitRepoHeadDto;
  /** A `repository` row: whether any of its changes is tracked, which Rollback needs. */
  readonly hasTracked?: boolean;
  /** A `repository` row: whether any of its files is unversioned, which Add to VCS needs. */
  readonly hasUnversioned?: boolean;
}

/** A folder row's identity whatever the grouping: a folder of one repository's list. */
export interface CommitFolderRef {
  readonly repoRoot: string;
  readonly listId: string;
  /** The folder's path inside the repository, chains joined as the row shows them. */
  readonly rel: string;
}

export interface CommitTreeModel {
  /**
   * The grouping the tree is in: `repository` only when the setting asks for it
   * and there are several repositories to arrange.
   */
  readonly groupBy: CommitGroupBy;
  readonly nodes: TreeNode[];
  /** Tree paths of the ticked files. */
  readonly checked: Set<string>;
  /** Node paths that must render no checkbox at all (Unversioned until T3). */
  readonly checkboxless: Set<string>;
  /** Tree path → the change it stands for. Directories are absent. */
  readonly files: Map<string, CommitFileRef>;
  /** Top-level row paths (changelists, or repositories), so callers can default them to expanded. */
  readonly groupPaths: string[];
  /** Every changelist and repository row's path → what it stands for. */
  readonly groups: Map<string, CommitGroupRef>;
  /** Folder row paths → what they are whatever the grouping. */
  readonly folders: Map<string, CommitFolderRef>;
  /**
   * P11-T8: dir/group node path → the statuses of its descendants. One status
   * colors the folder with it; mixed folders read as plain modified (IntelliJ).
   */
  readonly dirKinds: Map<string, ReadonlySet<StatusKind>>;
  /** The staging paradigm (POST-QA F5): rows stand for Staged/Unstaged halves, not changelists. */
  readonly staging: boolean;
  /**
   * POST-P14cb: folder rows over the files (`tree`), or the files as one list in
   * path order (`list`), each naming its folder (`gittree.commit.groupByDirectory`).
   */
  readonly layout: CommitLayout;
  /**
   * POST-P14ce: the repositories the list leaves out while the Repositories
   * panel's pick narrows it. Their rows keep their state for when they are back.
   */
  readonly hiddenRoots: readonly string[];
  /** POST-P14ce: the repositories the list shows, every one when it is not narrowed. */
  readonly shownRoots: readonly string[];
  /** POST-P14ce: the one repository the list is narrowed to, when it is one. */
  readonly onlyRepo?: string;
}

/**
 * POST-P14ce: the workspace has several repositories, whether or not the list
 * shows them all. Narrowed to one, the list keeps its repository row and its
 * grouping: a pick changes which repositories are listed, never how.
 */
export function multiRepoOf(state: CommitStateDto): boolean {
  return state.repos.length + (state.filter?.hidden.length ?? 0) > 1;
}

/** POST-P14cb: folder rows, or none. */
export type CommitLayout = 'tree' | 'list';

/** The layout a state is drawn in: folder rows only when `gittree.commit.groupByDirectory` asks. */
export function layoutOf(state: CommitStateDto): CommitLayout {
  return state.groupByDirectory === true ? 'tree' : 'list';
}

/**
 * Which rows are the same changelist.
 *
 * The default list and Unversioned Files carry the same id in every repository
 * (they are module constants), so they merge by id and the merge is exact — a
 * repository always has exactly those two. A user-created list gets a random
 * per-repo id, so the only thing two repositories can agree on is its name.
 * Keying the default by `isDefault` rather than by name keeps it merged even if
 * it has been renamed in one repository but not another.
 */
function mergeKeyOf(group: CommitGroupDto): string {
  if (group.isDefault) return '@default';
  if (group.id === UNVERSIONED_GROUP_ID) return '@unversioned';
  if (group.id === CONFLICTS_GROUP_ID) return '@conflicts';
  return `name:${group.name}`;
}

/** Group row path. Repo rows hang off it, and files off those. */
function groupKey(mergeKey: string): string {
  return `@g:${mergeKey}`;
}

/** Repository row path (Repository › Changelist). Its lists hang off it, and files off those. */
function repositoryKey(root: string): string {
  return `@r:${root}`;
}

/**
 * POST-P14cb: a repository's path in the grouping without changelists. Its files
 * hang off it, and any row of its own (Merge Conflicts, a staging half); with
 * one repository the row itself is not drawn, but its files keep the paths.
 */
function plainKey(root: string): string {
  return `@n:${root}`;
}

/** POST-P14cb: the one list a repository's changelists make without their rows; no changelist has this id. */
export const ALL_CHANGES_ID = '@changes';

/** IntelliJ's order of lists: the default first, the user's in their order, Unversioned Files last. */
function listRank(group: CommitGroupDto): number {
  // IntelliJ's Merge Conflicts node comes before every list (POST-QA).
  if (group.id === CONFLICTS_GROUP_ID) return -2;
  if (group.isDefault) return -1;
  return group.id === UNVERSIONED_GROUP_ID ? 1 : 0;
}

/**
 * The grouping a state is drawn in. One repository has no repository rows to
 * put first, so with changelists it is always drawn by changelist, whatever the
 * setting says; without them (`none`) it is drawn so whatever the count.
 */
export function groupByOf(state: CommitStateDto): CommitGroupBy {
  const set = commitGroupByOf(state.groupBy);
  if (set === 'none') return 'none';
  return multiRepoOf(state) ? set : 'changelist';
}

interface MergedGroup {
  readonly key: string;
  /** First contributing repository's name for the list — one row, one name. */
  name: string;
  isDefault: boolean;
  checkable: boolean;
  readonly order: number;
  readonly entries: Array<{ repo: CommitRepoDto; group: CommitGroupDto }>;
}

export function assembleCommitTree(state: CommitStateDto): CommitTreeModel {
  const nodes: TreeNode[] = [];
  const checked = new Set<string>();
  const checkboxless = new Set<string>();
  const files = new Map<string, CommitFileRef>();
  const groupPaths: string[] = [];
  const groups = new Map<string, CommitGroupRef>();
  const folders = new Map<string, CommitFolderRef>();
  const dirKinds = new Map<string, ReadonlySet<StatusKind>>();
  const multiRepo = multiRepoOf(state);
  const groupBy = groupByOf(state);
  const staging = state.paradigm === 'staging';
  const layout = layoutOf(state);
  // POST-P14ce: what the Repositories panel's pick leaves out, and the one it shows.
  const hiddenRoots = (state.filter?.hidden ?? []).map((repo) => repo.root);
  const only = state.filter !== undefined && state.filter.shown.length === 1 ? state.filter.shown[0]?.root : undefined;
  const narrowing = {
    hiddenRoots,
    shownRoots: state.repos.map((repo) => repo.root),
    ...(only !== undefined ? { onlyRepo: only } : {}),
  };

  /** Bottom-up status rollup for the directory highlighting (P11-T8). */
  const annotate = (node: TreeNode): ReadonlySet<StatusKind> => {
    if (node.kind === 'file') {
      const ref = files.get(node.path);
      return new Set(ref ? [ref.change.kind] : []);
    }
    const out = new Set<StatusKind>();
    for (const child of node.children) {
      for (const k of annotate(child)) out.add(k);
    }
    dirKinds.set(node.path, out);
    return out;
  };

  // Collect the same changelist from every repository into one row. Order is
  // IntelliJ's: Merge Conflicts, the default list, user lists in
  // first-appearance order, Unversioned Files last.
  const merged = new Map<string, MergedGroup>();
  let seq = 0;
  for (const repo of state.repos) {
    for (const group of repo.groups) {
      const key = mergeKeyOf(group);
      let m = merged.get(key);
      if (!m) {
        m = {
          key,
          name: group.name,
          isDefault: group.isDefault,
          checkable: group.checkable,
          // Merge Conflicts above all (POST-QA), as IntelliJ's node is.
          order:
            key === '@conflicts'
              ? -2
              : key === '@default'
                ? -1
                : key === '@unversioned'
                  ? Number.MAX_SAFE_INTEGER
                  : seq++,
          entries: [],
        };
        merged.set(key, m);
      }
      // A row is only tickable if every repository behind it is.
      m.checkable &&= group.checkable;
      m.entries.push({ repo, group });
    }
  }

  /** Files of one repository, under `parent`. Returns its node, if any. */
  const buildRepoSubtree = (
    parent: string,
    label: string,
    repo: CommitRepoDto,
    group: CommitGroupDto,
    checkable: boolean,
  ): TreeNode | undefined => {
    // Built with its own root rather than by prefixing paths with the repo
    // name: buildTree collapses single-child chains, so `demo/docs/x.md` would
    // render as one row reading `demo/docs` and the repository row would
    // silently disappear exactly when there is least on screen to infer it from.
    // POST-P14cb: or one list, its files in path order, as VS Code lists them.
    const build = layout === 'tree' ? buildTree : buildList;
    const built = build(
      group.changes.map((c) => c.path),
      { root: { path: parent, name: label }, pathPrefix: parent },
    );
    const root = built[0];
    if (!root) return undefined;
    if (!checkable) checkboxless.add(parent);

    // buildTree sorts and may collapse chains, so re-derive the leaf order from
    // the built tree rather than assuming it matches `group.changes`.
    const byPath = new Map(group.changes.map((c) => [c.path, c]));
    for (const leaf of collectFiles(root)) {
      const change = byPath.get(leaf.slice(parent.length + 1));
      if (!change) continue;
      const side = staging ? stagingSideOf(group.id) : undefined;
      files.set(leaf, { repoRoot: repo.root, relPath: change.path, change, ...(side !== undefined ? { side } : {}) });
      if (change.checked) checked.add(leaf);
      if (!checkable) checkboxless.add(leaf);
    }
    // The same list's folders come out the same under either grouping, only
    // the prefix differs: what lets an open or selected folder be found again.
    const recordFolders = (node: TreeNode): void => {
      if (node.kind !== 'dir') return;
      for (const child of node.children) {
        if (child.kind !== 'dir') continue;
        // A list that cannot be ticked has no box on its folders either: with
        // staging (POST-QA F5) no row of the tree has one.
        if (!checkable) checkboxless.add(child.path);
        folders.set(child.path, {
          repoRoot: repo.root,
          listId: group.id,
          rel: child.path.slice(parent.length + 1),
        });
        recordFolders(child);
      }
    };
    recordFolders(root);
    return root;
  };

  // POST-P14cb: no changelist rows. One row per repository with changes (none
  // with one repository), its files beneath: with changelists every list's and
  // the unversioned ones as one list, with staging under its halves' rows.
  // Merge Conflicts is a row first, either way.
  if (groupBy === 'none') {
    for (const repo of state.repos) {
      const rKey = plainKey(repo.root);
      const withChanges = repo.groups.filter((g) => g.changes.length > 0);
      const conflicts = withChanges.filter((g) => g.id === CONFLICTS_GROUP_ID);
      const rest = withChanges.filter((g) => g.id !== CONFLICTS_GROUP_ID);
      const sections: Array<{ readonly group: CommitGroupDto; readonly row: boolean }> = [
        ...conflicts.map((group) => ({ group, row: true })),
        ...(staging
          ? [...rest].sort((a, b) => listRank(a) - listRank(b)).map((group) => ({ group, row: true }))
          : rest.length > 0
            ? [{ group: allChangesOf(rest), row: false }]
            : []),
      ];
      // Under a repository's row, or at the top with one repository.
      const depth = multiRepo ? 1 : 0;
      const children: TreeNode[] = [];
      for (const { group, row } of sections) {
        if (row) {
          const sKey = `${rKey}@g:${mergeKeyOf(group)}`;
          const sub = buildRepoSubtree(sKey, group.name, repo, group, group.checkable);
          if (!sub) continue;
          children.push(reDepth(sub, depth));
          groups.set(sKey, {
            kind: 'repo',
            shows: 'list',
            targets: [{ repoRoot: repo.root, listId: group.id }],
            isDefault: group.isDefault,
            checkable: group.checkable,
            repoRoot: repo.root,
            listId: group.id,
          });
          if (!multiRepo) groupPaths.push(sKey);
          continue;
        }
        // The files hang off the repository itself.
        const sub = buildRepoSubtree(rKey, repo.label, repo, group, group.checkable);
        if (sub?.kind === 'dir') children.push(...sub.children.map((c) => reDepth(c, depth)));
      }
      if (children.length === 0) continue;
      if (!multiRepo) {
        nodes.push(...children);
        for (const child of children) if (child.kind === 'dir') annotate(child);
        continue;
      }
      const node: TreeNode = {
        kind: 'dir',
        path: rKey,
        name: repo.label,
        depth: 0,
        children,
        fileCount: children.reduce((n, c) => n + countFiles(c), 0),
      };
      const checkable = withChanges.some((g) => g.checkable);
      nodes.push(node);
      groupPaths.push(rKey);
      groups.set(rKey, {
        kind: 'repository',
        shows: 'repository',
        targets: withChanges.map((g) => ({ repoRoot: repo.root, listId: g.id })),
        isDefault: false,
        checkable,
        repoRoot: repo.root,
        // Defensive: it crosses postMessage, where nothing checks the DTO.
        colorIdx: repo.colorIdx ?? 0,
        ...(repo.head !== undefined ? { head: repo.head } : {}),
        hasTracked: withChanges.some((g) => g.changes.some((c) => c.kind !== 'untracked')),
        hasUnversioned: withChanges.some((g) => g.changes.some((c) => c.kind === 'untracked')),
      });
      if (!checkable) checkboxless.add(rKey);
      annotate(node);
    }
    return {
      groupBy,
      nodes,
      checked,
      checkboxless,
      files,
      groupPaths,
      groups,
      folders,
      dirKinds,
      staging,
      layout,
      ...narrowing,
    };
  }

  // Repository › Changelist: one row per repository with changes, in the order
  // the host sends them (by name, as the Repositories panel lists them), and
  // its own lists beneath in IntelliJ's order.
  if (groupBy === 'repository') {
    for (const repo of state.repos) {
      const rKey = repositoryKey(repo.root);
      const lists = [...repo.groups].sort((a, b) => listRank(a) - listRank(b));
      const children: TreeNode[] = [];
      const targets: CommitListTarget[] = [];
      for (const group of lists) {
        // A repository row says what it holds; an empty list under it says nothing.
        if (group.changes.length === 0) continue;
        const lKey = `${rKey}@g:${mergeKeyOf(group)}`;
        const sub = buildRepoSubtree(lKey, group.name, repo, group, group.checkable);
        if (!sub) continue;
        children.push(reDepth(sub, 1));
        targets.push({ repoRoot: repo.root, listId: group.id });
        groups.set(lKey, {
          kind: 'repo',
          shows: 'list',
          targets: [{ repoRoot: repo.root, listId: group.id }],
          isDefault: group.isDefault,
          checkable: group.checkable,
          repoRoot: repo.root,
          listId: group.id,
        });
      }
      if (children.length === 0) continue;
      const node: TreeNode = {
        kind: 'dir',
        path: rKey,
        name: repo.label,
        depth: 0,
        children,
        fileCount: children.reduce((n, c) => n + countFiles(c), 0),
      };
      const checkable = lists.some((g) => g.checkable && g.changes.length > 0);
      nodes.push(node);
      groupPaths.push(rKey);
      groups.set(rKey, {
        kind: 'repository',
        shows: 'repository',
        targets,
        isDefault: false,
        checkable,
        repoRoot: repo.root,
        // Defensive: it crosses postMessage, where nothing checks the DTO.
        colorIdx: repo.colorIdx ?? 0,
        ...(repo.head !== undefined ? { head: repo.head } : {}),
        hasTracked: lists.some((g) => g.changes.some((c) => c.kind !== 'untracked')),
        hasUnversioned: lists.some((g) => g.changes.some((c) => c.kind === 'untracked')),
      });
      if (!checkable) checkboxless.add(rKey);
      annotate(node);
    }
    if (nodes.length > 0) {
      return {
        groupBy,
        nodes,
        checked,
        checkboxless,
        files,
        groupPaths,
        groups,
        folders,
        dirKinds,
        staging,
        layout,
        ...narrowing,
      };
    }
    // Nothing changed anywhere: the one empty Changes row both groupings show.
  }

  for (const m of [...merged.values()].sort((a, b) => a.order - b.order)) {
    // An empty default list is the "nothing ticked yet" anchor, and there is
    // exactly one of it now however many repositories are open. Every other
    // empty group is noise.
    const total = m.entries.reduce((n, e) => n + e.group.changes.length, 0);
    if (total === 0 && !m.isDefault) continue;

    const gKey = groupKey(m.key);
    const targets = m.entries.map((e) => ({ repoRoot: e.repo.root, listId: e.group.id }));

    let node: TreeNode | undefined;
    if (multiRepo) {
      // One repository row per contributing repository — IntelliJ's shape.
      // Repositories with nothing in this list contribute no row.
      const children: TreeNode[] = [];
      for (const { repo, group } of m.entries) {
        if (group.changes.length === 0) continue;
        const rKey = `${gKey}@r:${repo.root}`;
        const sub = buildRepoSubtree(rKey, repo.label, repo, group, m.checkable);
        if (!sub) continue;
        // buildTree roots at depth 0; under a group row it starts one deeper.
        children.push(reDepth(sub, 1));
        groups.set(rKey, {
          kind: 'repo',
          shows: 'repository',
          targets: [{ repoRoot: repo.root, listId: group.id }],
          isDefault: m.isDefault,
          checkable: m.checkable,
          repoRoot: repo.root,
          listId: group.id,
          // Defensive: it crosses postMessage, where nothing checks the DTO.
          colorIdx: repo.colorIdx ?? 0,
          ...(repo.head !== undefined ? { head: repo.head } : {}),
        });
      }
      node = {
        kind: 'dir',
        path: gKey,
        name: m.name,
        depth: 0,
        children,
        fileCount: children.reduce((n, c) => n + countFiles(c), 0),
      };
    } else {
      const only = m.entries[0];
      if (!only) continue;
      node =
        total === 0
          ? { kind: 'dir', path: gKey, name: m.name, depth: 0, children: [], fileCount: 0 }
          : buildRepoSubtree(gKey, m.name, only.repo, only.group, m.checkable);
    }
    if (!node) continue;

    nodes.push(node);
    groupPaths.push(gKey);
    groups.set(gKey, {
      kind: 'group',
      shows: 'list',
      targets,
      isDefault: m.isDefault,
      checkable: m.checkable,
      // A single-root workspace has no repository rows, so this row *is* the
      // one repository's list and every scoped action still applies to it.
      ...(targets.length === 1 && targets[0] !== undefined
        ? { repoRoot: targets[0].repoRoot, listId: targets[0].listId }
        : {}),
    });
    if (!m.checkable) checkboxless.add(gKey);
    annotate(node);
  }

  return {
    groupBy,
    nodes,
    checked,
    checkboxless,
    files,
    groupPaths,
    groups,
    folders,
    dirKinds,
    staging,
    layout,
    ...narrowing,
  };
}

/**
 * POST-P14cb: a repository's changelists, and its unversioned files, as the one
 * list the grouping without changelists draws. Each file is still in its own
 * changelist: a tick, a rollback or Move to Another Changelist acts on the file.
 * Tickable when any of them is, as a repository row is.
 */
function allChangesOf(lists: readonly CommitGroupDto[]): CommitGroupDto {
  return {
    id: ALL_CHANGES_ID,
    name: 'Changes',
    isActive: false,
    isDefault: false,
    checkable: lists.some((g) => g.checkable),
    changes: lists.flatMap((g) => g.changes),
  };
}

/**
 * Re-stamps `depth` after a subtree is re-parented under a new row. Rebuilds
 * rather than mutates — `TreeNode` is readonly, and paths (the identity every
 * map is keyed by) are untouched either way.
 */
function reDepth(node: TreeNode, depth: number): TreeNode {
  if (node.kind === 'file') return { ...node, depth };
  return { ...node, depth, children: node.children.map((c) => reDepth(c, depth + 1)) };
}

/**
 * What a diff opened from the row at `treePath` walks through, and whether that
 * is the selection rather than the whole list. The list spans every repository
 * and changelist, with Unversioned Files last: IntelliJ's `iterateAllChanges`.
 */
export function commitDiffWalk(
  model: CommitTreeModel,
  selection: ReadonlySet<string>,
  treePath: string,
): { files: CommitDiffFileDto[]; explicit: boolean } {
  const walk = diffWalk(model.nodes, selection, treePath);
  const files: CommitDiffFileDto[] = [];
  for (const path of walk.files) {
    const ref = model.files.get(path);
    if (ref) files.push(diffFileOf(ref));
  }
  return { files, explicit: walk.explicit };
}

/** Every file in the list, in tree order. `model.files` is populated in that order. */
export function allDiffFiles(model: CommitTreeModel): CommitDiffFileDto[] {
  return [...model.files.values()].map(diffFileOf);
}

/**
 * The row showing a file. A file sits in one changelist, so there is one —
 * except with staging, where a file staged in part has a Staged and an
 * Unstaged row, and `file.side` says which.
 */
export function treePathOf(model: CommitTreeModel, file: CommitDiffFileDto): string | undefined {
  let any: string | undefined;
  for (const [treePath, ref] of model.files) {
    if (ref.repoRoot !== file.repoRoot || ref.relPath !== file.path) continue;
    if (file.side === undefined || fileSide(ref) === file.side) return treePath;
    any ??= treePath;
  }
  return any;
}

/**
 * The first row of `to` that stands for one repository's copy of a list and that
 * `wanted` accepts, in tree order: `groups` is filled in the order rows are drawn.
 */
function firstListRow(
  to: CommitTreeModel,
  wanted: (ref: CommitGroupRef) => boolean,
): string | undefined {
  for (const [path, ref] of to.groups) {
    if (ref.kind === 'repo' && wanted(ref)) return path;
  }
  return undefined;
}

/**
 * The row of `to` that stands for what `path` stood for in `from`, the same
 * changes drawn in the other grouping: a file is the same file, a folder the
 * same folder of the same repository's list, and one repository's copy of a
 * list the same copy, a row under a list in one grouping and over its files in
 * the other. A row with no twin hands over to its nearest one: a changelist
 * spanning repositories to its first repository's copy, a repository to its
 * first list. `undefined` when the row is gone.
 */
export function twinRow(from: CommitTreeModel, to: CommitTreeModel, path: string): string | undefined {
  const file = from.files.get(path);
  if (file !== undefined) return treePathOf(to, { repoRoot: file.repoRoot, path: file.relPath });

  const folder = from.folders.get(path);
  if (folder !== undefined) {
    for (const [p, f] of to.folders) {
      if (f.repoRoot === folder.repoRoot && f.listId === folder.listId && f.rel === folder.rel) return p;
    }
    return undefined;
  }

  const group = from.groups.get(path);
  if (group !== undefined) {
    // The same row in both, such as the empty Changes row nothing changed leaves.
    if (to.groups.has(path)) return path;
    if (group.kind === 'repo') {
      return firstListRow(to, (r) => r.repoRoot === group.repoRoot && r.listId === group.listId);
    }
    if (group.kind === 'repository') {
      return firstListRow(to, (r) => r.repoRoot === group.repoRoot);
    }
    for (const target of group.targets) {
      const twin = firstListRow(to, (r) => r.repoRoot === target.repoRoot && r.listId === target.listId);
      if (twin !== undefined) return twin;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The open rows once Collapse All has shut this grouping's. The other
 * grouping's stay as they were, to be found again when it comes back: its
 * paths are its own (`@g:` first or `@r:` first). POST-P14ce: so do the rows of
 * repositories the list leaves out, as they were when it is widened again.
 */
export function collapsedAll(model: CommitTreeModel, expanded: ReadonlySet<string>): Set<string> {
  const own = model.groupBy === 'repository' ? '@r:' : model.groupBy === 'none' ? '@n:' : '@g:';
  const roots = [...model.hiddenRoots, ...model.shownRoots];
  const outOfView = (path: string): boolean => {
    if (model.hiddenRoots.length === 0) return false;
    const owner = repositoryOfRow(path, roots);
    return owner !== undefined && model.hiddenRoots.includes(owner);
  };
  return new Set([...expanded].filter((path) => !path.startsWith(own) || outOfView(path)));
}

/**
 * POST-P14ce: whether a row is one of a repository's own: its row, or one under
 * it, in any grouping (`@n:<root>`, `@r:<root>`, `@g:<list>@r:<root>`). The
 * root must end there, so `/w/api` is not `/w/api-docs`. A changelist's row
 * spanning repositories is none of theirs.
 */
export function isRowOfRepository(path: string, root: string): boolean {
  for (const mark of [`@n:${root}`, `@r:${root}`]) {
    for (let at = path.indexOf(mark); at >= 0; at = path.indexOf(mark, at + 1)) {
      const next = path.charAt(at + mark.length);
      if (next === '' || next === '/' || next === '@') return true;
    }
  }
  return false;
}

/**
 * POST-P14ce: the repository of `roots` a row is one of. A repository can sit
 * inside another's folder, and its rows then name the outer one's root too:
 * the longest root it names is its own.
 */
export function repositoryOfRow(path: string, roots: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const root of roots) {
    if (isRowOfRepository(path, root) && (owner === undefined || root.length > owner.length)) owner = root;
  }
  return owner;
}

/** `twinRow` for every row of a selection, each twin once, in the order given. */
export function twinRows(from: CommitTreeModel, to: CommitTreeModel, paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const path of paths) {
    const twin = twinRow(from, to, path);
    if (twin !== undefined) out.add(twin);
  }
  return [...out];
}

/**
 * The label on a repository's row: its branch, or the commit a detached HEAD
 * is at, with a hover saying which and what it tracks. IntelliJ's repository
 * row shows the branch the same way, after its file count.
 */
/**
 * Where a renamed file came from, in IntelliJ's words (`ChangesBrowserFilePathNode`):
 * `renamed from old.ts` within its folder, `moved from src/old/old.ts` out of
 * another. The folder rows already say where a file is, so this is all its
 * row adds (POST-QA: it read `src/utils/math.ts ->`, an arrow at nothing).
 */
export function originText(relPath: string, origPath: string | undefined): string | undefined {
  if (origPath === undefined) return undefined;
  const parent = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  if (parent(relPath) !== parent(origPath)) return `moved from ${origPath}`;
  return name(relPath) !== name(origPath) ? `renamed from ${name(origPath)}` : undefined;
}

/**
 * POST-P14cb: what a file's row says after its name when the files are one list,
 * with no folder rows to say where they are: its folder, then where a renamed or
 * moved file came from. `docs ← setup.md` within its folder, `src ← lib/old.ts`
 * from another, `← old.md` at the top of the repository.
 */
export function listDescription(relPath: string, origPath: string | undefined): string | undefined {
  const parent = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
  const folder = parent(relPath);
  const from =
    origPath === undefined || origPath === relPath
      ? undefined
      : parent(origPath) === folder
        ? name(origPath)
        : origPath;
  const text = [folder, ...(from !== undefined ? [`← ${from}`] : [])].filter((t) => t.length > 0).join(' ');
  return text.length > 0 ? text : undefined;
}

/**
 * POST-P14cb: a file's status as VS Code's Source Control view writes it, for the
 * grouping without changelists: the letter at the end of its row, what the
 * letter means, and how its name is drawn. A file Git does not track yet looks
 * like the added file it will become, in its colour and icon, and is told apart
 * by its italic name and its `U` (D44); a deleted one is struck through.
 */
export interface StatusLook {
  readonly letter: string;
  readonly title: string;
  readonly italic: boolean;
  readonly strike: boolean;
}

const STATUS_LETTERS: Record<CommitChangeDto['kind'], { readonly letter: string; readonly title: string }> = {
  added: { letter: 'A', title: 'Added' },
  modified: { letter: 'M', title: 'Modified' },
  deleted: { letter: 'D', title: 'Deleted' },
  renamed: { letter: 'R', title: 'Renamed' },
  untracked: { letter: 'U', title: 'Untracked' },
  conflicted: { letter: '!', title: 'Conflicted' },
};

export function statusLook(change: CommitChangeDto): StatusLook {
  const { letter, title } = STATUS_LETTERS[change.kind] ?? STATUS_LETTERS.modified;
  return { letter, title, italic: change.kind === 'untracked', strike: change.kind === 'deleted' };
}

export function headLabel(head: CommitRepoHeadDto | undefined): { text: string; title: string } | undefined {
  if (head === undefined) return undefined;
  if (head.branch !== undefined) {
    if (head.unborn === true) return { text: head.branch, title: `Branch ${head.branch}, no commits yet` };
    return {
      text: head.branch,
      title:
        head.upstream !== undefined
          ? `Branch ${head.branch}, tracking ${head.upstream}`
          : `Branch ${head.branch}`,
    };
  }
  if (head.sha !== undefined) {
    const short = head.sha.slice(0, 7);
    return { text: short, title: `HEAD detached at ${short}` };
  }
  return undefined;
}

/**
 * The native context payload for a changelist or repository row. A `repo` row
 * is one repository's copy of a list in either grouping, so it carries the
 * scoped list actions; a `group` row may be several, so scoped-only actions
 * live on the repository row; a `repository` row carries what acts on all of
 * one repository's changes.
 */
/** The Merge Conflicts row: no changelist, so none of a changelist's actions — Resolve. */
export function isConflictsRow(model: CommitTreeModel, nodePath: string): boolean {
  const group = model.groups.get(nodePath);
  return (
    group !== undefined &&
    group.kind !== 'repository' &&
    group.targets.length > 0 &&
    group.targets.every((t) => t.listId === CONFLICTS_GROUP_ID)
  );
}

export function groupRowContext(model: CommitTreeModel, nodePath: string): Record<string, unknown> | undefined {
  const group = model.groups.get(nodePath);
  if (group === undefined) return undefined;
  if (isConflictsRow(model, nodePath)) {
    // POST-QA: a changelist's Commit, Set Active, Rename and Delete were
    // offered here; the row's one action is IntelliJ's Resolve.
    return {
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitConflicts',
      ...(group.repoRoot !== undefined ? { repoRoot: group.repoRoot } : {}),
    };
  }
  if (group.kind === 'repository') {
    return {
      preventDefaultContextMenuItems: true,
      webviewSection: 'commitRepository',
      ...(group.repoRoot !== undefined ? { repoRoot: group.repoRoot } : {}),
      repoHasTracked: group.hasTracked === true,
      repoHasUnversioned: group.hasUnversioned === true,
      // POST-P14ce: the list shows this repository alone: its menu offers Show
      // All Repositories where Show Only This Repository would do nothing.
      repoShownAlone: group.repoRoot !== undefined && group.repoRoot === model.onlyRepo,
    };
  }
  return {
    preventDefaultContextMenuItems: true,
    webviewSection: group.kind === 'repo' ? 'commitRepo' : 'commitGroup',
    ...(group.repoRoot !== undefined ? { repoRoot: group.repoRoot } : {}),
    ...(group.listId !== undefined ? { listId: group.listId } : {}),
    targets: group.targets,
    listIsDefault: group.isDefault,
    listCheckable: group.checkable,
    listSpansRepos: group.targets.length > 1,
    // POST-P14bf: Unversioned Files is no changelist. It offers Add to VCS and
    // Move to Another Changelist…, never a list's Rename, Delete or Set Active.
    listIsUnversioned: group.targets.length > 0 && group.targets.every((t) => t.listId === UNVERSIONED_GROUP_ID),
    // POST-QA F5: with staging, Stage or Unstage, by the node the row stands for.
    ...sideContext(model.staging ? stagingSideOf(group.listId ?? group.targets[0]?.listId) : undefined),
  };
}

function sideContext(side: StagingSide | undefined): Record<string, unknown> {
  return side !== undefined ? { stagingSide: side } : {};
}

/**
 * POST-P14bf: the native context payload for a folder row: the files under it,
 * which IntelliJ's actions act on when a folder node is selected (until
 * P14-T2a folder rows carried nothing, and VS Code showed its own Cut, Copy and
 * Paste). Within a multi-selection it carries every selected file of the
 * folder's repository, as a file row does; `relPath` is the first, where Show
 * Diff starts. `folder` is the folder itself, which lets Add to .gitignore
 * write one rule for it.
 */
export function folderRowContext(
  model: CommitTreeModel,
  node: TreeNode,
  selection: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const folder = model.folders.get(node.path);
  if (folder === undefined || node.kind !== 'dir') return undefined;
  const paths = selection.has(node.path) ? selectedFiles(model.nodes, selection) : collectFiles(node);
  const refs = paths
    .map((p) => model.files.get(p))
    .filter((ref): ref is CommitFileRef => ref !== undefined && ref.repoRoot === folder.repoRoot);
  const first = refs[0];
  if (first === undefined) return undefined;
  return {
    preventDefaultContextMenuItems: true,
    webviewSection: 'commitFolder',
    repoRoot: folder.repoRoot,
    relPath: first.relPath,
    relPaths: refs.map((r) => r.relPath),
    folder: folder.rel,
    // Add to .gitignore wants every file new; Add to VCS, any.
    fileUnversioned: refs.every((r) => r.change.kind === 'untracked'),
    folderHasUnversioned: refs.some((r) => r.change.kind === 'untracked'),
    // POST-P14bq: Reveal shows the folder itself, whatever is selected. With
    // every file under it gone, so most likely is the folder.
    ...(folderGoneFromDisk(model, node) ? { folderDeleted: true } : {}),
    ...sideContext(model.staging ? stagingSideOf(folder.listId) : undefined),
  };
}

/**
 * POST-P14bq: whether a change leaves nothing on disk at its path, by its
 * status: a deletion, or a file deleted from the working tree after its other
 * change was staged (`AD`, `MD`). What Reveal in File Explorer is hidden on: the
 * OS would open nothing. A staging-mode Staged row knows only the index's
 * letter, so its `MD` reads `M.`; the host finds the file missing and says so.
 */
export function goneFromDisk(change: CommitChangeDto): boolean {
  if (change.kind === 'deleted') return true;
  if (change.kind === 'untracked' || change.kind === 'conflicted') return false;
  return change.code.charAt(1) === 'D';
}

/** Every file under a folder row gone from disk: its folder most likely is too. */
function folderGoneFromDisk(model: CommitTreeModel, node: TreeNode): boolean {
  const refs = collectFiles(node).flatMap((p) => {
    const ref = model.files.get(p);
    return ref !== undefined ? [ref] : [];
  });
  return refs.length > 0 && refs.every((r) => goneFromDisk(r.change));
}

/**
 * POST-P14bq: what the reveal shortcut shows for the row the keyboard is on: a
 * file row's file, a folder row's folder; nothing for a changelist row. A
 * deleted file's row is sent anyway, and the host says it is no longer on disk:
 * a key that does nothing at all would look broken.
 *
 * POST-P14cb: a repository row shows its repository's folder, as its menu's
 * Reveal in File Explorer does, which names this key.
 */
export function revealRequestOf(model: CommitTreeModel, treePath: string): CommitRevealParamsDto | undefined {
  const file = model.files.get(treePath);
  if (file !== undefined) return { repoRoot: file.repoRoot, relPath: file.relPath };
  const folder = model.folders.get(treePath);
  if (folder !== undefined) return { repoRoot: folder.repoRoot, folder: folder.rel };
  const group = model.groups.get(treePath);
  if (group?.kind === 'repository' && group.repoRoot !== undefined) return { repoRoot: group.repoRoot, folder: '.' };
  return undefined;
}

export interface RepoCheckDelta {
  readonly repoRoot: string;
  readonly paths: string[];
  readonly checked: boolean;
}

/**
 * Splits a tree toggle into one host call per repository, dropping tree paths
 * that carry no checkbox (an Unversioned row must not silently become part of
 * a "check everything" gesture).
 */
export function splitDelta(
  delta: ToggleDelta,
  model: CommitTreeModel,
): RepoCheckDelta[] {
  const byRepo = new Map<string, string[]>();
  for (const treePath of delta.paths) {
    if (model.checkboxless.has(treePath)) continue;
    const ref = model.files.get(treePath);
    if (!ref) continue;
    const list = byRepo.get(ref.repoRoot);
    if (list) list.push(ref.relPath);
    else byRepo.set(ref.repoRoot, [ref.relPath]);
  }
  return [...byRepo].map(([repoRoot, paths]) => ({
    repoRoot,
    paths,
    checked: delta.next,
  }));
}

/**
 * POST-P14v: the native context payload for one file row.
 *
 * Built from the selection as it stands *when the menu opens*, because that is
 * what VS Code reads off `data-vscode-context` during the same contextmenu
 * event — a selection change made in response to the right-click has not
 * rendered yet and must never be relied on here. A click inside a
 * multi-selection therefore carries the whole selection; a click outside it
 * carries only the row under the cursor, which is also what the tree then
 * selects.
 *
 * Scoped to one repository: `gittree.*` file commands take a single
 * `repoRoot`, and a cross-repository selection silently acting on half of
 * itself is worse than acting on the clicked repository's half by contract.
 */
export function fileRowContext(
  model: CommitTreeModel,
  nodePath: string,
  selection: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const ref = model.files.get(nodePath);
  if (!ref) return undefined;
  // `model.files` is populated in tree-leaf order, so filtering it keeps the
  // payload in the order the rows are read on screen. A `Set` would not.
  const selected = selection.has(nodePath)
    ? [...model.files.entries()]
        .filter(([key, f]) => selection.has(key) && f.repoRoot === ref.repoRoot)
        .map(([, f]) => f)
    : [ref];
  const paths = selected.length > 1 ? selected : [ref];
  return {
    preventDefaultContextMenuItems: true,
    webviewSection: 'commitFile',
    repoRoot: ref.repoRoot,
    // Kept beside `relPaths` so every pre-existing single-file command keeps
    // working untouched; the clicked row is always the one it names.
    relPath: ref.relPath,
    relPaths: paths.map((f) => f.relPath),
    // Gates `Add to VCS` and `Add to .gitignore`: both are meaningless on a
    // file git already tracks, and a mixed selection would half-apply.
    fileUnversioned: paths.every((f) => f.change.kind === 'untracked'),
    // POST-QA: an unmerged file is in no changelist to move it from, and its
    // Rollback would throw the merge's side of it away unseen.
    ...(paths.some((f) => f.change.kind === 'conflicted') ? { fileConflicted: true } : {}),
    // POST-P14bq: the clicked row only, which is what Reveal in File Explorer
    // shows; the selection's other rows play no part in it.
    ...(goneFromDisk(ref.change) ? { fileDeleted: true } : {}),
    ...sideContext(fileSide(ref)),
  };
}

/** POST-P14cf: what the tick-all box says of the list: how many of its boxes are ticked. */
export interface TickAllState {
  /** The files with a box: every change listed but a merge conflict. */
  readonly total: number;
  readonly ticked: number;
  /** The box's own: none, some or all of them ticked. */
  readonly state: CheckState;
}

/**
 * POST-P14cf: the tick-all box on the counter, from the list as drawn. None with
 * the staging area, where no row has a box: a change goes in by being staged.
 */
export function tickAllState(model: CommitTreeModel): TickAllState | undefined {
  if (model.staging) return undefined;
  let total = 0;
  let ticked = 0;
  for (const path of model.files.keys()) {
    if (model.checkboxless.has(path)) continue;
    total++;
    if (model.checked.has(path)) ticked++;
  }
  const state: CheckState = ticked === 0 ? 'unchecked' : ticked === total ? 'checked' : 'partial';
  return { total, ticked, state };
}

/** Some row has rows under it to fold: what Expand All and Collapse All need. */
function hasFoldingRows(nodes: readonly TreeNode[]): boolean {
  return nodes.some((node) => node.kind === 'dir' && node.children.length > 0);
}

/**
 * POST-P14cf: the native context payload of the list's blank space (under the
 * rows, the "No changes." message, the filter bar): what its menu offers acts
 * on the whole list. A row's own payload overrides `webviewSection`, so its
 * menu is its own. `listRoots` are the repositories the list shows, which the
 * menu's ticks and stages reach.
 */
export function listContext(
  model: CommitTreeModel,
  opts: { readonly narrowed: boolean; readonly roots: readonly string[] },
): Record<string, unknown> {
  const tick = tickAllState(model);
  let canStage = false;
  let canUnstage = false;
  if (model.staging) {
    for (const ref of model.files.values()) {
      if (ref.side === 'staged') canUnstage = true;
      else if (ref.side === 'unstaged' || ref.side === 'unversioned') canStage = true;
    }
  }
  return {
    preventDefaultContextMenuItems: true,
    webviewSection: 'commitList',
    // Changelist rows drawn: New Changelist… is offered, as the owner asked.
    listShowsChangelists: !model.staging && model.groupBy !== 'none',
    listHasUnticked: tick !== undefined && tick.ticked < tick.total,
    listHasTicked: tick !== undefined && tick.ticked > 0,
    listCanStage: canStage,
    listCanUnstage: canUnstage,
    listCanFold: hasFoldingRows(model.nodes),
    listNarrowed: opts.narrowed,
    listRoots: [...opts.roots],
  };
}

export function iconFor(
  change: CommitChangeDto,
  overrides?: StatusColorOverrides,
): { codicon: string; color: string } {
  return { codicon: statusIcon(change.kind), color: statusColor(change.kind, overrides) };
}

/** `2 files` / `1 file` — the badge every IntelliJ tree node carries (S12). */
export function fileCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'file' : 'files'}`;
}

/**
 * `2 of 5 changes` — what a file row says when only part of it is going in
 * (P11-T3). Without it a ticked checkbox would imply the whole file.
 */
export function partialLabel(partial: { total: number; included: number }): string {
  return `${partial.included} of ${partial.total} ${partial.total === 1 ? 'change' : 'changes'}`;
}
