/**
 * Tree ordering for `Paths ▾ · Select in Tree…` — the reference's tree chooser
 * flattened into the one list shape a QuickPick can render. Pure and
 * vscode-free so the ordering and the overflow rule are unit-testable without
 * a repository.
 *
 * A QuickPick cannot expand or collapse, so the tree is expressed as *order
 * plus depth*: every directory is immediately followed by its own contents,
 * directories before files at each level, each alphabetical. Reading top to
 * bottom gives exactly the tree the reference draws.
 */

export interface PathTreeItem {
  /** Repo-relative, forward slashes — the pathspec `git log -- …` receives. */
  path: string;
  kind: 'dir' | 'file';
  /** Nesting level; the label indents by it. Top level is 0. */
  depth: number;
  /** Last segment — what the row reads as, `path` being the description. */
  name: string;
}

export interface PathTree {
  items: PathTreeItem[];
  /** Directories + files the repository actually has, before any capping. */
  total: number;
  /**
   * `full` — everything fits. `dirsOnly` — too many entries, so files were
   * dropped wholesale rather than alphabetically: a cap applied mid-walk makes
   * the tail *unreachable by search*, which reads as "this repo has no such
   * file". Dropping a whole kind is at least a rule the title can state.
   * `truncated` — the directories alone overflow; nothing else is left to give.
   */
  mode: 'full' | 'dirsOnly' | 'truncated';
}

export const PATH_TREE_LIMIT = 20_000;

/**
 * Folds a tree pick back into the filter's paths.
 *
 * The tree owns what the tree can express, and nothing else. A glob
 * (`src/**​/*.ts`) has no row, and neither does a file the `dirsOnly` mode
 * withheld — neither was ever tickable, so an accepted pick must not be read
 * as having un-ticked them. Only paths the chooser actually *offered* are
 * replaced by what came back.
 */
export function mergeTreeSelection(
  current: readonly string[],
  offered: readonly string[],
  picked: readonly string[],
): string[] {
  const offerable = new Set(offered);
  return [...new Set([...current.filter((p) => !offerable.has(p)), ...picked])];
}

interface Node {
  dirs: Map<string, Node>;
  files: Set<string>;
}

function emptyNode(): Node {
  return { dirs: new Map(), files: new Set() };
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the tree-ordered item list from `git ls-files` output.
 *
 * @param paths repo-relative tracked paths, forward slashes.
 * @param limit how many rows the QuickPick may carry.
 */
export function buildPathTree(
  paths: readonly string[],
  limit: number = PATH_TREE_LIMIT,
): PathTree {
  const root = emptyNode();
  for (const raw of paths) {
    const segments = raw.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = emptyNode();
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.add(segments[segments.length - 1]!);
  }

  let dirCount = 0;
  let fileCount = 0;
  const count = (node: Node): void => {
    dirCount += node.dirs.size;
    fileCount += node.files.size;
    for (const child of node.dirs.values()) count(child);
  };
  count(root);
  const total = dirCount + fileCount;

  const mode: PathTree['mode'] =
    total <= limit ? 'full' : dirCount <= limit ? 'dirsOnly' : 'truncated';
  const withFiles = mode === 'full';

  const items: PathTreeItem[] = [];
  const walk = (node: Node, prefix: string, depth: number): void => {
    for (const name of sorted(node.dirs.keys())) {
      if (items.length >= limit) return;
      const full = prefix.length === 0 ? name : `${prefix}/${name}`;
      items.push({ path: full, kind: 'dir', depth, name });
      walk(node.dirs.get(name)!, full, depth + 1);
    }
    if (!withFiles) return;
    for (const name of sorted(node.files)) {
      if (items.length >= limit) return;
      items.push({
        path: prefix.length === 0 ? name : `${prefix}/${name}`,
        kind: 'file',
        depth,
        name,
      });
    }
  };
  walk(root, '', 0);

  return { items, total, mode };
}
