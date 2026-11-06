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
 * Pure so the identity rules are unit-tested rather than discovered in the UI:
 *   - node paths are namespaced per group and per repo, because two changelists
 *     may both contain `api/` and must not share an expansion key or a checkbox
 *     rollup, and neither may two repositories inside one group;
 *   - the returned `files` map is the only way back from a tree path to
 *     `(repoRoot, relPath)`, so a folder toggle can be split into one host call
 *     per repository.
 */
import {
  UNVERSIONED_GROUP_ID,
  type CommitChangeDto,
  type CommitDiffFileDto,
  type CommitGroupDto,
  type CommitRepoDto,
  type CommitStateDto,
} from '../../../src/shared/protocol';
import { statusColor, statusIcon, type StatusColorOverrides, type StatusKind } from '../lib/status';
import {
  buildTree,
  collectFiles,
  countFiles,
  diffWalk,
  type ToggleDelta,
  type TreeNode,
} from '../lib/treeModel';

export interface CommitFileRef {
  readonly repoRoot: string;
  readonly relPath: string;
  readonly change: CommitChangeDto;
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
  readonly kind: 'group' | 'repo';
  readonly targets: readonly CommitListTarget[];
  readonly isDefault: boolean;
  readonly checkable: boolean;
  readonly repoRoot?: string;
  readonly listId?: string;
  /**
   * A `repo` row's palette slot: it wears its repository's colour, as IntelliJ's
   * repository node wears the log's root colour, not its files' status.
   */
  readonly colorIdx?: number;
}

export interface CommitTreeModel {
  readonly nodes: TreeNode[];
  /** Tree paths of the ticked files. */
  readonly checked: Set<string>;
  /** Node paths that must render no checkbox at all (Unversioned until T3). */
  readonly checkboxless: Set<string>;
  /** Tree path → the change it stands for. Directories are absent. */
  readonly files: Map<string, CommitFileRef>;
  /** Group node paths, so callers can default them to expanded. */
  readonly groupPaths: string[];
  /** Group and repository row paths → the changelist they stand for. */
  readonly groups: Map<string, CommitGroupRef>;
  /**
   * P11-T8: dir/group node path → the statuses of its descendants. One status
   * colors the folder with it; mixed folders read as plain modified (IntelliJ).
   */
  readonly dirKinds: Map<string, ReadonlySet<StatusKind>>;
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
  return `name:${group.name}`;
}

/** Group row path. Repo rows hang off it, and files off those. */
function groupKey(mergeKey: string): string {
  return `@g:${mergeKey}`;
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
  const dirKinds = new Map<string, ReadonlySet<StatusKind>>();
  const multiRepo = state.repos.length > 1;

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
  // IntelliJ's: the default list first, user lists in first-appearance order,
  // Unversioned Files last.
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
          order: key === '@default' ? -1 : key === '@unversioned' ? Number.MAX_SAFE_INTEGER : seq++,
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
    const built = buildTree(
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
      files.set(leaf, { repoRoot: repo.root, relPath: change.path, change });
      if (change.checked) checked.add(leaf);
      if (!checkable) checkboxless.add(leaf);
    }
    return root;
  };

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
          targets: [{ repoRoot: repo.root, listId: group.id }],
          isDefault: m.isDefault,
          checkable: m.checkable,
          repoRoot: repo.root,
          listId: group.id,
          // Defensive: it crosses postMessage, where nothing checks the DTO.
          colorIdx: repo.colorIdx ?? 0,
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

  return { nodes, checked, checkboxless, files, groupPaths, groups, dirKinds };
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
    if (ref) files.push({ repoRoot: ref.repoRoot, path: ref.relPath });
  }
  return { files, explicit: walk.explicit };
}

/** Every file in the list, in tree order. `model.files` is populated in that order. */
export function allDiffFiles(model: CommitTreeModel): CommitDiffFileDto[] {
  return [...model.files.values()].map((f) => ({ repoRoot: f.repoRoot, path: f.relPath }));
}

/** The row showing a file. A file sits in one changelist, so there is one. */
export function treePathOf(model: CommitTreeModel, file: CommitDiffFileDto): string | undefined {
  for (const [treePath, ref] of model.files) {
    if (ref.repoRoot === file.repoRoot && ref.relPath === file.path) return treePath;
  }
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
