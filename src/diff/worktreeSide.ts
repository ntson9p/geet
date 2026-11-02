/**
 * A diff whose right side is a file in the working tree. A walk reads a list made
 * earlier, so by the time it gets there that file can be gone, or not be text.
 */
import * as fsp from 'node:fs/promises';
import * as vscode from 'vscode';
import { EMPTY_SIDE_REF, makeRevUri, WORKTREE_STUB_REF } from '../core/vdocs/revContentProvider';
import type { DiffEntry } from './diffSession';

/**
 * What to show for `entry` now. Whether VS Code will show the file is VS Code's to
 * say, and asking it again each time is what notices a file deleted since the list
 * was read. Only when it refuses does the disk say which it was.
 */
export async function settleWorktreeSide(
  entry: DiffEntry,
  repoRoot: string,
  relPath: string,
): Promise<DiffEntry> {
  try {
    await vscode.workspace.openTextDocument(entry.modified);
    return entry;
  } catch {
    const present = await fsp.stat(entry.modified.fsPath).then(
      () => true,
      () => false,
    );
    const ref = present ? WORKTREE_STUB_REF : EMPTY_SIDE_REF;
    return { ...entry, modified: makeRevUri(repoRoot, relPath, ref) };
  }
}
