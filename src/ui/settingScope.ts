/**
 * Where a GitTree option is written (POST-QA): never into the repository.
 *
 * In a single-folder workspace, VS Code's *Workspace* settings are the
 * folder's own `.vscode/settings.json`, a file in the user's repository that
 * teams commit and share. GitTree wrote its remembered choices there — the
 * Push dialog's tag mode on every push, the commit paradigm, view toggles, the
 * diff editor's whitespace option — so a plain push left a new untracked file
 * behind, or changed a shared one.
 *
 * The rule now: a setting the user already keeps in the workspace is updated
 * there, so the change takes effect; anything else goes to the user's own
 * settings, as VS Code's own toggles do. And nothing is written when the value
 * would not change. Pure and vscode-free.
 */

/** The parts of `WorkspaceConfiguration.inspect()` the choice depends on. */
export interface InspectedScopes {
  readonly globalValue?: unknown;
  readonly workspaceValue?: unknown;
  readonly workspaceFolderValue?: unknown;
}

export function settingScope(inspected: InspectedScopes | undefined): 'workspace' | 'global' {
  return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined
    ? 'workspace'
    : 'global';
}

/** Structural equality for setting values: booleans, strings, numbers, arrays and plain objects. */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
