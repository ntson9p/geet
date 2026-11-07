/**
 * `Files Merged with Conflicts` dialog (P13-T8 · S7): the gate IntelliJ shows
 * the moment a merge produces conflicts — a file list with `Accept Yours`,
 * `Accept Theirs`, resolve-all-simple and `Merge…`.
 *
 * IntelliJ gates on the modal; the `gittree.conflicts` **tree view stays** as
 * the persistent surface for ongoing work, exactly as the phase plan specifies.
 * The dialog is shown once per session and can be turned off entirely with
 * `gittree.merge.conflictsDialog` — an editor-area panel opening by itself is
 * more intrusive than IntelliJ's modal, so it needs an off switch.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import { filesCount } from '../ui/counts';
import type { Core } from '../core/core';
import type {
  ConflictsDialogParamsDto,
  ConflictsDialogResultDto,
} from '../shared/protocol';
import { openDialog } from '../ui/dialogHost';
import { statusColorOverrides } from '../ui/statusColors';
import { isSpecialConflict, type ConflictSession } from './conflictSession';

export interface ConflictsDialogDeps {
  core: Core;
  extensionUri: vscode.Uri;
  trace?: (line: string) => void;
}

export function buildConflictsParams(session: ConflictSession): ConflictsDialogParamsDto {
  return {
    repoRoot: session.repo.root,
    repoLabel: path.basename(session.repo.root),
    operation: session.source,
    files: session.files().map((f) => ({
      path: f.path,
      kind: f.kind,
      mergeable: !isSpecialConflict(f.kind),
    })),
    colors: statusColorOverrides(),
  };
}

/**
 * The accept half. Every action routes through the same commands the tree view
 * uses, so the dialog and the view cannot behave differently — which is the
 * acceptance line's "resolve-all-simple matches the tree view's behaviour".
 */
export async function applyConflictsResult(
  session: ConflictSession,
  result: ConflictsDialogResultDto,
): Promise<string> {
  const paths = result.paths.filter((p) => session.files().some((f) => f.path === p));
  if (result.action === 'resolveSimple') {
    await vscode.commands.executeCommand('gittree.merge.magicWandSession', {
      repoRoot: session.repo.root,
    });
    return vscode.l10n.t('Resolved the simple conflicts.');
  }
  if (result.action === 'merge') {
    const first = paths[0];
    if (first === undefined) return vscode.l10n.t('No file selected to merge.');
    // The same `ConflictNode` shape the tree view dispatches with.
    await vscode.commands.executeCommand('gittree.merge.open', {
      session,
      path: first,
      kind: session.files().find((f) => f.path === first)?.kind,
    });
    return vscode.l10n.t('Opened {0} in the merge editor.', first);
  }
  if (paths.length === 0) return vscode.l10n.t('No files selected.');
  await session.acceptSide(paths, result.action === 'acceptYours' ? 'ours' : 'theirs');
  return result.action === 'acceptYours'
    ? vscode.l10n.t('Accepted your version for {0}.', filesCount(paths.length))
    : vscode.l10n.t('Accepted their version for {0}.', filesCount(paths.length));
}

/**
 * True when the S7 gate is enabled (default on).
 *
 * Suppressed under the integration harness: the gate opens a webview panel by
 * itself the moment conflicts appear, which takes editor focus and breaks every
 * editor-based assertion in a suite that creates conflict sessions (it did —
 * P6-T4's chevron test). The dialog's own halves (`buildConflictsParams`,
 * `applyConflictsResult`) are driven directly by the P13 suite, and
 * `GITTREE_TEST_CONFLICTS_DIALOG=1` re-arms the auto-open for anyone who wants
 * to exercise the whole path.
 */
export function conflictsDialogEnabled(): boolean {
  if (process.env['GITTREE_TEST'] === '1' && process.env['GITTREE_TEST_CONFLICTS_DIALOG'] !== '1') {
    return false;
  }
  return vscode.workspace
    .getConfiguration('gittree.merge')
    .get<boolean>('conflictsDialog', true);
}

export async function showConflictsDialog(
  deps: ConflictsDialogDeps,
  session: ConflictSession,
): Promise<string | undefined> {
  const params = buildConflictsParams(session);
  if (params.files.length === 0) return undefined;
  const result = await openDialog<ConflictsDialogParamsDto, ConflictsDialogResultDto>({
    app: 'dialogs',
    dialog: 'conflicts',
    title: vscode.l10n.t('Files Merged with Conflicts — {0}', params.repoLabel),
    params,
    extensionUri: deps.extensionUri,
    ...(deps.trace ? { trace: deps.trace } : {}),
  });
  if (!result) return undefined;
  const message = await applyConflictsResult(session, result);
  void vscode.window.showInformationMessage(message);
  return message;
}
