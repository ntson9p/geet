/**
 * commitTree (P11-T2): turns a `CommitStateDto` into the tree the commit
 * window renders — one group row per changelist (plus Unversioned Files),
 * IntelliJ folder rows beneath, files at the leaves.
 *
 * Pure so the identity rules are unit-tested rather than discovered in the UI:
 *   - node paths are namespaced per repo and per group, because two
 *     changelists in one repo may both contain `api/` and must not share an
 *     expansion key or a checkbox rollup;
 *   - the returned `files` map is the only way back from a tree path to
 *     `(repoRoot, relPath)`, so a folder toggle can be split into one host call
 *     per repository.
 */
import type { CommitChangeDto, CommitStateDto } from '../../../src/shared/protocol';
import { statusColor, statusIcon, type StatusColorOverrides, type StatusKind } from '../lib/status';
import { buildTree, collectFiles, type ToggleDelta, type TreeNode } from '../lib/treeModel';

export interface CommitFileRef {
  readonly repoRoot: string;
  readonly relPath: string;
  readonly change: CommitChangeDto;
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
  /**
   * P11-T8: dir/group node path → the statuses of its descendants. One status
   * colors the folder with it; mixed folders read as plain modified (IntelliJ).
   */
  readonly dirKinds: Map<string, ReadonlySet<StatusKind>>;
}

/** Stable, collision-free identity for a group row. */
function groupKey(repoRoot: string, groupId: string): string {
  return `@g:${repoRoot}:${groupId}`;
}

export function assembleCommitTree(state: CommitStateDto): CommitTreeModel {
  const nodes: TreeNode[] = [];
  const checked = new Set<string>();
  const checkboxless = new Set<string>();
  const files = new Map<string, CommitFileRef>();
  const groupPaths: string[] = [];
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

  for (const repo of state.repos) {
    for (const group of repo.groups) {
      if (group.changes.length === 0 && !group.isDefault) continue;
      const key = groupKey(repo.root, group.id);
      // In a multi-root workspace the repo becomes a real folder row inside the
      // group, which is how IntelliJ shows `demo-git  1 file  demo-git`.
      const prefix = multiRepo ? `${repo.label}/` : '';
      const built = buildTree(
        group.changes.map((c) => `${prefix}${c.path}`),
        { root: { path: key, name: group.name }, pathPrefix: key },
      );
      const root = built[0];
      if (!root) continue;
      nodes.push(root);
      groupPaths.push(key);
      if (!group.checkable) checkboxless.add(key);

      // buildTree sorts and may collapse chains, so re-derive the leaf order
      // from the built tree rather than assuming it matches `group.changes`.
      const leaves = collectFiles(root);
      const byPath = new Map(group.changes.map((c) => [`${prefix}${c.path}`, c]));
      for (const leaf of leaves) {
        const source = leaf.slice(key.length + 1);
        const change = byPath.get(source);
        if (!change) continue;
        files.set(leaf, { repoRoot: repo.root, relPath: change.path, change });
        if (change.checked) checked.add(leaf);
        if (!group.checkable) checkboxless.add(leaf);
      }
      annotate(root);
    }
  }

  return { nodes, checked, checkboxless, files, groupPaths, dirKinds };
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
