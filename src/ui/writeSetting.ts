/**
 * Writes a Geet (or VS Code) option the way `settingScope` decides: where
 * the user already keeps it, else in their own settings — never a new value in
 * the repository's `.vscode/settings.json` — and not at all when it would not
 * change (POST-QA).
 */
import * as vscode from 'vscode';
import { sameSettingValue, settingScope } from './settingScope';

export async function writeSetting(section: string, key: string, value: unknown): Promise<void> {
  const config = vscode.workspace.getConfiguration(section);
  if (value !== undefined && sameSettingValue(config.get(key), value)) return;
  const inspected = config.inspect(key);
  const target =
    settingScope(inspected) === 'workspace' && (vscode.workspace.workspaceFolders?.length ?? 0) > 0
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await config.update(key, value, target);
}
