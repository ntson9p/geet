/**
 * Peek-widget hunk actions (P1-T3): rollback / stage / open-commit-view on
 * the native dirty-diff peek toolbar (menus.scm/change/title). Handlers
 * receive (uri, changes, index) from the peek widget.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Core, RepoHandle } from '../core/core';
import { applyLineChanges, buildPatch, complementChanges, type LineChange } from '../core/patch/patchBuilder';
import { revObjectSpec } from '../core/vdocs/revContentProvider';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
import { quickDiffBase } from './quickDiff';

function isLineChange(x: unknown): x is LineChange {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as LineChange).originalStartLineNumber === 'number' &&
    typeof (x as LineChange).modifiedStartLineNumber === 'number'
  );
}

interface HunkArgs {
  repo: RepoHandle;
  uri: vscode.Uri;
  rel: string;
  changes: LineChange[];
  index: number;
}

function parseArgs(core: Core, args: unknown[]): HunkArgs | undefined {
  const [uri, changes, index] = args;
  if (!(uri instanceof vscode.Uri) || !Array.isArray(changes)) return undefined;
  const repo = core.repoForUri(uri);
  if (!repo) return undefined;
  const rel = path.relative(repo.root, uri.fsPath).replace(/\\/g, '/');
  if (rel.startsWith('..')) return undefined;
  const lineChanges = changes.filter(isLineChange);
  const i = typeof index === 'number' ? index : 0;
  if (lineChanges.length === 0 || i < 0 || i >= lineChanges.length) return undefined;
  return { repo, uri, rel, changes: lineChanges, index: i };
}

/** The quick-diff base text the gutter bars were computed against. */
async function readBaseText(repo: RepoHandle, rel: string): Promise<string | undefined> {
  const ref = quickDiffBase() === 'head' ? 'HEAD' : ':0';
  const result = await repo.queue.enqueue({
    label: `show base for ${rel}`,
    kind: 'read',
    run: (git, token) =>
      git.exec(repo.root, ['show', revObjectSpec(ref, rel)], {
        structured: true,
        noOptionalLocks: true,
        allowNonZeroExit: true,
        token,
      }),
  });
  return result.exitCode === 0 ? result.stdout : undefined;
}

export function registerHunkActions(context: vscode.ExtensionContext, core: Core): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gittree.hunk.rollback', async (...args: unknown[]) => {
      const parsed = parseArgs(core, args);
      if (!parsed) return;
      const doc = await vscode.workspace.openTextDocument(parsed.uri);
      const original = await readBaseText(parsed.repo, parsed.rel);
      if (original === undefined) return;

      await parsed.repo.queue.enqueue({
        label: vscode.l10n.t('Rollback hunk in {0}', path.basename(parsed.rel)),
        kind: 'mutate',
        isDestructive: true,
        snapshotLabel: SNAPSHOT_LABELS.rollback,
        snapshotPaths: [parsed.uri.fsPath],
        run: async () => {
          // Revert = re-apply every change EXCEPT the rolled-back one. A
          // single full-document replace keeps the editor undo stack intact
          // (Ctrl+Z restores the hunk — IntelliJ parity).
          const reverted = applyLineChanges(
            original,
            doc.getText(),
            complementChanges(parsed.changes, [parsed.index]),
          );
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
          edit.replace(parsed.uri, fullRange, reverted);
          const ok = await vscode.workspace.applyEdit(edit);
          if (!ok) throw new Error('rollback edit was not applied');
        },
      });
    }),

    vscode.commands.registerCommand('gittree.hunk.stage', async (...args: unknown[]) => {
      const parsed = parseArgs(core, args);
      if (!parsed) return;
      const doc = await vscode.workspace.openTextDocument(parsed.uri);
      if (doc.isDirty) {
        await doc.save(); // stage what the user sees
      }
      // The peek's LineChanges were computed against the quick-diff base —
      // the patch must use the same text or the @@ offsets won't align.
      // (With base=index this is exactly `git apply --cached` semantics; with
      // base=HEAD and a divergent index, git rejects the patch cleanly.)
      const baseText = await readBaseText(parsed.repo, parsed.rel);
      if (baseText === undefined) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Cannot stage a hunk of an untracked file — stage the whole file instead.'),
        );
        return;
      }
      const change = parsed.changes[parsed.index]!;
      const patch = buildPatch({
        relPath: parsed.rel,
        originalText: baseText,
        modifiedText: doc.getText(),
        changes: [change],
      });
      await parsed.repo.queue.enqueue({
        label: vscode.l10n.t('Stage hunk in {0}', path.basename(parsed.rel)),
        kind: 'mutate',
        run: async (git, token) => {
          await git.exec(parsed.repo.root, ['apply', '--cached', '--unidiff-zero', '-'], {
            stdin: patch,
            token,
          });
        },
      });
    }),

    vscode.commands.registerCommand('gittree.hunk.openCommitView', async () => {
      await vscode.commands.executeCommand('workbench.view.scm');
    }),
  );
}
