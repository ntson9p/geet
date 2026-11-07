/**
 * What a row of the Commit window compares when it opens as a diff. Pure, so the
 * rule is tested without an editor.
 *
 * Changelists bypass the index: `git commit --only` takes worktree content, so
 * HEAD against the worktree is exactly what the commit will produce, and what the
 * preview pane beside the tree shows (`fileDiff.ts`). Comparing against the index
 * instead would show a file someone staged by hand as having no changes at all.
 *
 * With staging the index does count, and the row is one line for what can be two
 * changes. It opens on the one still to deal with: what is not staged yet, whose
 * diff carries the `Stage hunk` lenses, or else what is staged.
 */
import type { StatusEntry } from '../../core/model/statusEntry';
import type { StagingSide } from '../../shared/protocol';

export interface LocalDiffSides {
  readonly left: { readonly relPath: string; readonly ref: string };
  /** The file itself, or the index. */
  readonly right: 'worktree' | 'index';
  readonly titleKind: 'working-tree' | 'index';
}

export function localDiffSides(
  relPath: string,
  entry: StatusEntry | undefined,
  paradigm: 'changelists' | 'staging',
  side?: StagingSide,
): LocalDiffSides {
  const head = { relPath: entry?.origPath ?? relPath, ref: 'HEAD' };
  // POST-QA F5: a staging row names its half — the Staged row of a file staged
  // in part opens HEAD against the index, its Unstaged row the index against
  // the file, as IntelliJ's two nodes do.
  if (paradigm === 'staging' && side === 'staged') return { left: head, right: 'index', titleKind: 'index' };
  if (paradigm === 'staging' && side === 'unstaged') {
    return { left: { relPath, ref: ':0' }, right: 'worktree', titleKind: 'working-tree' };
  }
  // An untracked or a conflicted file has nothing in the index to compare with.
  const usesIndex =
    paradigm === 'staging' &&
    entry !== undefined &&
    entry.kind !== 'untracked' &&
    entry.kind !== 'unmerged';
  if (!usesIndex) return { left: head, right: 'worktree', titleKind: 'working-tree' };
  if (entry.y !== '.') {
    return { left: { relPath, ref: ':0' }, right: 'worktree', titleKind: 'working-tree' };
  }
  return { left: head, right: 'index', titleKind: 'index' };
}
