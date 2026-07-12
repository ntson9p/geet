/**
 * Modal confirmation helper. Integration tests cannot click native dialogs,
 * so the harness sets GITTREE_TEST_AUTOCONFIRM=1 to make destructive-op
 * confirmations auto-accept, or =0 to auto-decline (refusal paths) — the ops
 * under test still take their P9 snapshots, only the dialog is skipped.
 */
import * as vscode from 'vscode';

export async function confirmModal(message: string, detail: string, button: string): Promise<boolean> {
  if (process.env['GITTREE_TEST_AUTOCONFIRM'] === '1') return true;
  if (process.env['GITTREE_TEST_AUTOCONFIRM'] === '0') return false;
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
  return choice === button;
}
