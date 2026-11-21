/**
 * "What's new" notification (P10-T3 step 4): once per MINOR version bump,
 * setting-gated (`geet.whatsNew.enabled`) and dismissible — any outcome
 * marks the minor as seen. "Show" opens the changelog in VS Code's own
 * markdown preview (the reused renderer): `changelog.md` in an installed
 * extension, as vsce names it, `CHANGELOG.md` in a development host.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { changelogName, whatsNewDecision } from './whatsNewGate';

const SEEN_KEY = 'geet.whatsNew.seenMinor';

export async function maybeShowWhatsNew(context: vscode.ExtensionContext): Promise<void> {
  const enabled = vscode.workspace
    .getConfiguration('geet')
    .get<boolean>('whatsNew.enabled', true);
  if (!enabled) return;

  const version = (context.extension.packageJSON as { version: string }).version;
  const { minor, show } = whatsNewDecision(context.globalState.get<string>(SEEN_KEY), version);
  if (context.globalState.get<string>(SEEN_KEY) !== minor) {
    await context.globalState.update(SEEN_KEY, minor);
  }
  if (!show) return;

  const showChangelog = vscode.l10n.t("What's New");
  const choice = await vscode.window.showInformationMessage(
    vscode.l10n.t('Geet updated to {0}.', version),
    showChangelog,
  );
  if (choice === showChangelog) {
    // `changelog.md` as installed, `CHANGELOG.md` in a development host (POST-P14cr).
    const name = changelogName((n) => fs.existsSync(path.join(context.extensionUri.fsPath, n)));
    if (name === undefined) return;
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, name));
  }
}
