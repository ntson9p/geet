/**
 * Peek-widget hunk actions (P1-T3): rollback / stage / open-commit-view on
 * the native dirty-diff peek toolbar (menus.scm/change/title). Handlers
 * receive (uri, changes, index) from the peek widget.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { reportStageOutcome } from '../commit/staging/stageMessages';
import { stageWorktreeLines } from '../commit/staging/stageLines';
import type { Core, RepoHandle } from '../core/core';
import { toBlobEol } from '../core/patch/eol';
import {
  applyLineChanges,
  complementChanges,
  correspondingChanges,
  type LineChange,
} from '../core/patch/patchBuilder';
import { repoRelative } from '../core/util/paths';
import { SNAPSHOT_LABELS } from '../localHistory/hooks';
// P14-T3: one base-text read, shared with the change bars and the popup.
import { readBaseText } from './gutter/baseText';

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
  const rel = repoRelative(repo.root, uri.fsPath);
  if (rel === undefined) return undefined;
  const lineChanges = changes.filter(isLineChange);
  const i = typeof index === 'number' ? index : 0;
  if (lineChanges.length === 0 || i < 0 || i >= lineChanges.length) return undefined;
  return { repo, uri, rel, changes: lineChanges, index: i };
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
          // (Ctrl+Z restores the hunk — IntelliJ parity). The bars were
          // measured on the blob's line endings, so the text is too; the
          // editor puts its own line endings back on whatever it is given.
          const reverted = applyLineChanges(
            original,
            toBlobEol(original, doc.getText()).text,
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
      // The bar was measured against the change-bar base, which may be HEAD
      // and may be a moment old; staging works on the index as it is now, so
      // the clicked change is matched onto a fresh index diff of the same
      // working-tree lines (POST-QA F1).
      const picked = parsed.changes[parsed.index]!;
      const outcome = await parsed.repo.queue.enqueue({
        label: vscode.l10n.t('Stage hunk in {0}', path.basename(parsed.rel)),
        kind: 'mutate',
        run: (git, token) =>
          stageWorktreeLines(
            git,
            parsed.repo.root,
            parsed.rel,
            doc.getText(),
            (fresh) => correspondingChanges(fresh, picked),
            token,
          ),
      });
      reportStageOutcome(outcome);
    }),

    vscode.commands.registerCommand('gittree.hunk.openCommitView', async () => {
      // P14-T1: GitTree's views moved out of VS Code's SCM container into our
      // own; reveal the container so whichever commit surface is visible shows.
      await vscode.commands.executeCommand('workbench.view.extension.gittree');
    }),
  );
}
