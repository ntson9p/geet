/**
 * treeModel (P11-T1): the pure, DOM-free tree math behind every IntelliJ-shaped
 * file tree in P11-P13 — the commit window, the push dialog, the log's Changed
 * Files pane. Kept free of React and of `vscode` so it unit-tests under the
 * root vitest suite.
 *
 * Two behaviours matter for fidelity (gap analysis S11/S12):
 *   - single-child directory chains collapse into one row (`src/main/java`),
 *     which is why IntelliJ's trees stay shallow;
 *   - every directory carries a file count, and a partially-ticked directory
 *     reports `partial` — the tri-state that `TreeItemCheckboxState` cannot.
 */

export type CheckState = 'checked' | 'unchecked' | 'partial';

export interface TreeFileNode {
  readonly kind: 'file';
  /** Normalized full path — the identity used by checked/selected sets. */
  readonly path: string;
  /** Display label (last segment). */
  readonly name: string;
  readonly depth: number;
}

export interface TreeDirNode {
  readonly kind: 'dir';
  /** Normalized directory path, no trailing slash — also the expansion key. */
  readonly path: string;
  /** Display label; spans several segments when a chain was collapsed. */
  readonly name: string;
  readonly depth: number;
  readonly children: readonly TreeNode[];
  /** Files in the whole subtree, not just direct children. */
  readonly fileCount: number;
}

export type TreeNode = TreeDirNode | TreeFileNode;

export interface BuildTreeOptions {
  /** Wrap everything in a synthetic top node (a repo row or a changelist group). */
  readonly root?: { readonly path: string; readonly name: string };
  /** Collapse single-child directory chains. IntelliJ does; default true. */
  readonly collapseChains?: boolean;
  /**
   * Namespace applied to every node's `path` — identity only, never the label.
   * Two changelists in one repo can both contain `api/`, and without this their
   * directory rows would share an expansion key and a rollup.
   */
  readonly pathPrefix?: string;
}

/** Path→segments, tolerant of Windows separators and redundant slashes. */
function segments(raw: string): string[] {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.');
}

/**
 * Deterministic across locales and Node/browser: case-insensitive first, then
 * raw as a tie-break so `README` and `readme` never swap between runs.
 */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

interface Trie {
  readonly dirs: Map<string, Trie>;
  readonly files: Set<string>;
}

function emptyTrie(): Trie {
  return { dirs: new Map(), files: new Set() };
}

function join(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * Builds the display tree from a flat path list. Paths are normalized and
 * de-duplicated; order of the input does not affect the result.
 */
export function buildTree(paths: readonly string[], options: BuildTreeOptions = {}): TreeNode[] {
  const collapse = options.collapseChains ?? true;
  const trie = emptyTrie();

  for (const raw of paths) {
    const parts = segments(raw);
    if (parts.length === 0) continue;
    const fileName = parts[parts.length - 1] as string;
    let node = trie;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] as string;
      let next = node.dirs.get(seg);
      if (!next) {
        next = emptyTrie();
        node.dirs.set(seg, next);
      }
      node = next;
    }
    node.files.add(fileName);
  }

  const top = toNodes(trie, options.pathPrefix ?? '', options.root ? 1 : 0, collapse);
  if (!options.root) return top;
  return [
    {
      kind: 'dir',
      path: options.root.path,
      name: options.root.name,
      depth: 0,
      children: top,
      fileCount: top.reduce((n, c) => n + countFiles(c), 0),
    },
  ];
}

function toNodes(trie: Trie, prefix: string, depth: number, collapse: boolean): TreeNode[] {
  const dirs: TreeDirNode[] = [];
  for (const name of [...trie.dirs.keys()].sort(compareNames)) {
    let label = name;
    let path = join(prefix, name);
    let sub = trie.dirs.get(name) as Trie;
    // Collapse `a` → `a/b` → `a/b/c` while each level holds exactly one
    // directory and no files of its own.
    while (collapse && sub.files.size === 0 && sub.dirs.size === 1) {
      const onlyName = [...sub.dirs.keys()][0] as string;
      label = `${label}/${onlyName}`;
      path = `${path}/${onlyName}`;
      sub = sub.dirs.get(onlyName) as Trie;
    }
    const children = toNodes(sub, path, depth + 1, collapse);
    dirs.push({
      kind: 'dir',
      path,
      name: label,
      depth,
      children,
      fileCount: children.reduce((n, c) => n + countFiles(c), 0),
    });
  }

  const files: TreeFileNode[] = [...trie.files].sort(compareNames).map((name) => ({
    kind: 'file' as const,
    path: join(prefix, name),
    name,
    depth,
  }));

  // Directories before files — IntelliJ's ordering.
  return [...dirs, ...files];
}

/** Files in the subtree; 1 for a file node. */
export function countFiles(node: TreeNode): number {
  return node.kind === 'file' ? 1 : node.fileCount;
}

/** Every file path under `node`, in display order. */
export function collectFiles(node: TreeNode, out: string[] = []): string[] {
  if (node.kind === 'file') {
    out.push(node.path);
    return out;
  }
  for (const child of node.children) collectFiles(child, out);
  return out;
}

/** Depth-first walk over a forest, in display order. */
export function walk(nodes: readonly TreeNode[], visit: (node: TreeNode) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'dir') walk(node.children, visit);
  }
}

export function findNode(nodes: readonly TreeNode[], path: string): TreeNode | undefined {
  let found: TreeNode | undefined;
  walk(nodes, (n) => {
    if (found === undefined && n.path === path) found = n;
  });
  return found;
}

/**
 * Tri-state rollup. A directory with no files is `unchecked` (there is nothing
 * to include), which keeps empty group rows from rendering as ticked.
 */
export function rollup(node: TreeNode, checked: ReadonlySet<string>): CheckState {
  if (node.kind === 'file') return checked.has(node.path) ? 'checked' : 'unchecked';
  let total = 0;
  let hit = 0;
  walk(node.children, (n) => {
    if (n.kind !== 'file') return;
    total++;
    if (checked.has(n.path)) hit++;
  });
  if (total === 0 || hit === 0) return 'unchecked';
  return hit === total ? 'checked' : 'partial';
}

export interface ToggleDelta {
  /** Every file the click applies to — send verbatim to the host. */
  readonly paths: string[];
  readonly next: boolean;
}

/**
 * What a checkbox click means. Clicking a partially-ticked directory ticks the
 * whole subtree (IntelliJ behaviour), never the reverse.
 */
export function toggle(node: TreeNode, state: CheckState): ToggleDelta {
  return { paths: collectFiles(node), next: state !== 'checked' };
}

export interface FlatRow {
  readonly node: TreeNode;
  /** A directory with children — i.e. the row draws a twistie. */
  readonly expandable: boolean;
  readonly expanded: boolean;
}

/** Flattens the visible rows for windowed rendering. */
export function flatten(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): FlatRow[] {
  const rows: FlatRow[] = [];
  const push = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      const expandable = node.kind === 'dir' && node.children.length > 0;
      const isOpen = expandable && expanded.has(node.path);
      rows.push({ node, expandable, expanded: isOpen });
      if (isOpen && node.kind === 'dir') push(node.children);
    }
  };
  push(nodes);
  return rows;
}

/** Every directory path in the forest — the "expand all" set. */
export function allDirPaths(nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  walk(nodes, (n) => {
    if (n.kind === 'dir') out.push(n.path);
  });
  return out;
}

/**
 * Index of the row that owns `path`, or -1. Used to restore focus after the
 * tree is rebuilt by a status refresh.
 */
export function rowIndexOf(rows: readonly FlatRow[], path: string): number {
  return rows.findIndex((r) => r.node.path === path);
}
