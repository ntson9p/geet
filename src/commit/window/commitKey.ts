/**
 * POST-P14bs — Ctrl+Enter (⌘Enter on macOS) in the Commit window's message box
 * commits, as the window's Commit button does. VS Code's Source Control box
 * takes the key the same way, and only there: the owner's choice, where
 * IntelliJ also takes it in the change tree (deviation D42).
 *
 * The key is a keybinding, so it can be rebound: `gittree.commit.fromMessageBox`
 * while `gittree.commitMessageFocus`. Two things it must not do:
 *
 * - Rely on `focusedView`. VS Code clears it once focus is inside a webview,
 *   whose iframe lives in an overlay outside its view pane, so the key bound
 *   to `focusedView == 'gittree.commit'` never committed. The webview says when
 *   its box has the keyboard (`commit/messageFocus`), and that sets the key.
 * - Commit from here. The bare `gittree.commit` reads the host's copy of the
 *   message, which trails the box by its 250 ms persist debounce, and skips the
 *   window's busy guard. So the command asks the window (`commit/commitKey`),
 *   which sends the message as typed and commits through the button's path.
 */
import * as vscode from 'vscode';

/** The command the key runs. Kept out of the Command Palette: it needs the box. */
export const COMMIT_FROM_MESSAGE_COMMAND = 'gittree.commit.fromMessageBox';

/** Whether the Commit window's message box has the keyboard: the key's `when`. */
export const MESSAGE_FOCUS_CONTEXT_KEY = 'gittree.commitMessageFocus';

let messageFocused = false;

/** Sets `gittree.commitMessageFocus`; a repeat of the last value sends nothing. */
export function setMessageFocus(focused: boolean): void {
  if (messageFocused === focused) return;
  messageFocused = focused;
  void vscode.commands.executeCommand('setContext', MESSAGE_FOCUS_CONTEXT_KEY, focused);
}
