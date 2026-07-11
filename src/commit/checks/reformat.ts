/**
 * Reformat check (P3-T7 step 2): format ONLY the modified ranges of each
 * file — IntelliJ's "Reformat code (changed lines)". Files without a
 * formatter are skipped silently.
 */
import * as vscode from 'vscode';
import { modifiedRanges } from '../../core/patch/lineDiff';
import { changesVsHead } from './changedRanges';
import type { CommitCheck } from './pipeline';

export const reformatCheck: CommitCheck = {
  id: 'reformat',
  label: vscode.l10n.t('Reformat modified lines'),
  configKey: 'reformat',
  async run(ctx) {
    for (const uri of ctx.files) {
      if (ctx.token.isCancellationRequested) break;
      const target = await changesVsHead(ctx.repo, uri);
      if (!target) continue;
      const ranges = modifiedRanges(target.changes);
      if (ranges.length === 0) continue;

      const edit = new vscode.WorkspaceEdit();
      for (const [startLine, endLine] of ranges) {
        const range = new vscode.Range(
          startLine,
          0,
          Math.min(endLine, target.doc.lineCount - 1),
          target.doc.lineAt(Math.min(endLine, target.doc.lineCount - 1)).text.length,
        );
        let edits: vscode.TextEdit[] | undefined;
        try {
          edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatRangeProvider',
            uri,
            range,
            { tabSize: 4, insertSpaces: true } satisfies vscode.FormattingOptions,
          );
        } catch {
          edits = undefined; // no formatter for this language — skip silently
        }
        for (const e of edits ?? []) {
          // Keep strictly inside the modified range: a formatter may return
          // whole-document edits; those would violate "changed lines only".
          if (range.contains(e.range) || range.isEqual(e.range)) {
            edit.replace(uri, e.range, e.newText);
          }
        }
      }
      if (edit.size > 0) {
        await vscode.workspace.applyEdit(edit);
        const doc = await vscode.workspace.openTextDocument(uri);
        if (doc.isDirty) await doc.save();
      }
    }
    return { ok: true };
  },
};
