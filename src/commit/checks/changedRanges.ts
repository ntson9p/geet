/**
 * Shared helper for range-scoped checks: changed line ranges of a file vs
 * HEAD (what this commit is about to introduce).
 */
import * as vscode from 'vscode';
import type { RepoHandle } from '../../core/core';
import { toBlobEol } from '../../core/patch/eol';
import { computeLineChanges } from '../../core/patch/lineDiff';
import type { LineChange } from '../../core/patch/patchBuilder';
import { repoRelative } from '../../core/util/paths';
import { revObjectSpec } from '../../core/vdocs/revContentProvider';

export async function headText(repo: RepoHandle, rel: string, rev = 'HEAD'): Promise<string> {
  const result = await repo.queue.enqueue({
    label: `show ${rev}:${rel}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['show', revObjectSpec(rev, rel)], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true, // absent at that rev → treat as empty (all-added)
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : '';
}

/**
 * `baseRev` defaults to HEAD — "what this commit is about to introduce". The
 * deferred post-commit pass (P11-T5) passes the new commit's parent instead:
 * after the commit, worktree↔HEAD is empty, and the thing to scan is what the
 * commit just added.
 */
export async function changesVsHead(
  repo: RepoHandle,
  uri: vscode.Uri,
  baseRev = 'HEAD',
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
  const base = await headText(repo, rel, baseRev);
  // On the blob's line endings, or a CRLF checkout counts every line as changed.
  return { doc, changes: computeLineChanges(base, toBlobEol(base, doc.getText()).text) };
}
