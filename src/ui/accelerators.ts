/**
 * IntelliJ's accelerators — Ctrl+T, Ctrl+K, Ctrl+Shift+K, Ctrl+Alt+N,
 * Ctrl+Alt+Z, Alt+` — are bound only with `geet.keymap.intellij` on
 * (package.json `keybindings`), and it is off by default. A menu that named
 * one named a key that did nothing, or did VS Code's own thing: Ctrl+Shift+K
 * deletes a line (POST-QA). vscode-free; the setting is read by the caller.
 */

/** The accelerator to show beside an item: the key, if it is bound. */
export function shownAccelerator(accelerator: string | undefined, intellijKeymap: boolean): string | undefined {
  return intellijKeymap ? accelerator : undefined;
}

/** The setting, relative to the `geet` section. */
export const INTELLIJ_KEYMAP_SETTING = 'keymap.intellij';
