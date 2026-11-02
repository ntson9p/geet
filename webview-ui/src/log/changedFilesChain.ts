/**
 * The files a diff opened from the Changed Files pane walks through. Pure, so
 * the rule is tested without a webview.
 *
 * It is IntelliJ's `VcsTreeModelData.getListSelectionOrAll`: with several rows
 * selected, those; otherwise every file. Either way in the order the tree shows
 * them, which is not the order git listed them: folders sort before files.
 */
import type { CommitFileDto } from '../../../src/shared/protocol';
import { collectFiles, type TreeNode } from '../lib/treeModel';

export function diffChain(
  nodes: readonly TreeNode[],
  byPath: ReadonlyMap<string, CommitFileDto>,
  selection: ReadonlySet<string>,
  target: CommitFileDto,
): CommitFileDto[] {
  const shown: CommitFileDto[] = [];
  for (const node of nodes) {
    for (const path of collectFiles(node)) {
      const file = byPath.get(path);
      if (file) shown.push(file);
    }
  }
  const selected = shown.filter((f) => selection.has(f.path));
  // A row opened from outside the selection is a row on its own.
  return selected.length > 1 && selected.includes(target) ? selected : shown;
}

/** The folder rows a file sits under, so that it can be brought into view. */
export function ancestorDirs(nodes: readonly TreeNode[], path: string): string[] {
  const out: string[] = [];
  const visit = (list: readonly TreeNode[]): boolean => {
    for (const node of list) {
      if (node.kind === 'file') {
        if (node.path === path) return true;
      } else if (visit(node.children)) {
        out.push(node.path);
        return true;
      }
    }
    return false;
  };
  visit(nodes);
  return out;
}
