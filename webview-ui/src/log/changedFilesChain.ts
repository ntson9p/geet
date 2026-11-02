/**
 * The files a diff opened from the Changed Files pane walks through, as the
 * pane's own records. Pure, so the rule is tested without a webview.
 */
import type { CommitFileDto } from '../../../src/shared/protocol';
import { diffWalk, type TreeNode } from '../lib/treeModel';

export function diffChain(
  nodes: readonly TreeNode[],
  byPath: ReadonlyMap<string, CommitFileDto>,
  selection: ReadonlySet<string>,
  target: CommitFileDto,
): CommitFileDto[] {
  const out: CommitFileDto[] = [];
  for (const path of diffWalk(nodes, selection, target.path).files) {
    const file = byPath.get(path);
    if (file) out.push(file);
  }
  return out;
}
