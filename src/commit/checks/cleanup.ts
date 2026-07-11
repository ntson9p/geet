/**
 * Cleanup check (P3-T7 step 6): apply `source.fixAll` per committed file.
 * Shares the code-action machinery with optimize-imports.
 */
import * as vscode from 'vscode';
import type { CheckContext, CommitCheck } from './pipeline';

export async function applyCodeActionKind(ctx: CheckContext, kind: vscode.CodeActionKind): Promise<void> {
  for (const uri of ctx.files) {
    if (ctx.token.isCancellationRequested) return;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      continue;
    }
    const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
    let actions: vscode.CodeAction[] | undefined;
    try {
      actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        fullRange,
        kind.value,
        3,
      );
    } catch {
      continue;
    }
    for (const action of actions ?? []) {
      if (action.disabled !== undefined) continue;
      if (action.edit) await vscode.workspace.applyEdit(action.edit);
      if (action.command) {
        const args: unknown[] = action.command.arguments ?? [];
        await vscode.commands.executeCommand(action.command.command, ...args);
      }
    }
    const after = await vscode.workspace.openTextDocument(uri);
    if (after.isDirty) await after.save();
  }
}

export const cleanupCheck: CommitCheck = {
  id: 'cleanup',
  label: vscode.l10n.t('Cleanup (fix all)'),
  configKey: 'cleanup',
  async run(ctx) {
    await applyCodeActionKind(ctx, vscode.CodeActionKind.SourceFixAll);
    return { ok: true };
  },
};
