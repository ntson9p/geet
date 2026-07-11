/**
 * Optimize-imports check (P3-T7 step 3): apply `source.organizeImports` per
 * committed file, then save.
 */
import * as vscode from 'vscode';
import { applyCodeActionKind } from './cleanup';
import type { CommitCheck } from './pipeline';

export const optimizeImportsCheck: CommitCheck = {
  id: 'optimizeImports',
  label: vscode.l10n.t('Optimize imports'),
  configKey: 'optimizeImports',
  async run(ctx) {
    await applyCodeActionKind(ctx, vscode.CodeActionKind.SourceOrganizeImports);
    return { ok: true };
  },
};
