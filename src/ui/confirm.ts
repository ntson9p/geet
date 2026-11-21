/**
 * Modal confirmation helper. Integration tests cannot click native dialogs,
 * so the harness sets GEET_TEST_AUTOCONFIRM=1 to make destructive-op
 * confirmations auto-accept, or =0 to auto-decline (refusal paths) — the ops
 * under test still take their P9 snapshots, only the dialog is skipped.
 */
import * as vscode from 'vscode';

export async function confirmModal(message: string, detail: string, button: string): Promise<boolean> {
  if (process.env['GEET_TEST_AUTOCONFIRM'] === '1') return true;
  if (process.env['GEET_TEST_AUTOCONFIRM'] === '0') return false;
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
  return choice === button;
}

/**
 * Typed confirmation for irreversible bulk destruction (P7 "Clear All"):
 * the user must type `word` exactly. Honors the same test seam.
 */
export async function typedConfirm(message: string, word: string): Promise<boolean> {
  if (process.env['GEET_TEST_AUTOCONFIRM'] === '1') return true;
  if (process.env['GEET_TEST_AUTOCONFIRM'] === '0') return false;
  const typed = await vscode.window.showInputBox({
    prompt: message,
    placeHolder: vscode.l10n.t('Type {0} to confirm', word),
    validateInput: (v) => (v === word ? undefined : vscode.l10n.t('Type {0} to confirm', word)),
  });
  return typed === word;
}
