/**
 * Shared helper for range-scoped checks: changed line ranges of a file vs
 * HEAD (what this commit is about to introduce).
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../../core/core';
import { computeLineChanges } from '../../core/patch/lineDiff';
import type { LineChange } from '../../core/patch/patchBuilder';
import { repoRelative } from '../../core/util/paths';
import { revObjectSpec } from '../../core/vdocs/revContentProvider';

export async function headText(repo: RepoHandle, rel: string): Promise<string> {
  const result = await repo.queue.enqueue({
    label: `show HEAD:${rel}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['show', revObjectSpec('HEAD', rel)], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : '';
}

export async function changesVsHead(
  repo: RepoHandle,
  uri: vscode.Uri,
): Promise<{ doc: vscode.TextDocument; changes: LineChange[] } | undefined> {
  if (uri.scheme !== 'file') return undefined;
  const rel = repoRelative(repo.root, uri.fsPath);
  if (rel === undefined) return undefined;
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined; // deleted/binary
  }
  const base = await headText(repo, rel);
  return { doc, changes: computeLineChanges(base, doc.getText()) };
}
