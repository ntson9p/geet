/**
 * POST-P14bq — the reveal key in the Commit window's change tree. Pure, so it
 * is unit-tested.
 *
 * The key is VS Code's own for Reveal in File Explorer, contributed as a
 * keybinding (`geet.revealFileInOS.*`, while `geet.commitTreeFocus`):
 * VS Code resolves it and the host asks the webview for the keyboard's row.
 *
 * Windows' Shift+Alt+R is answered here instead. A key a webview passes on to
 * VS Code arrives as an event that cannot be cancelled, so besides running the
 * keybinding, VS Code's menu bar takes Alt+R for its Run menu's mnemonic and
 * opens that menu, which takes the keyboard (seen in VS Code 1.144). Kept in
 * the tree, the key reaches neither. macOS (⌥⌘R, native menus) and Linux
 * (Ctrl+Alt+R: the menu bar ignores a chord with Ctrl) go through VS Code.
 */

/** The parts of a keydown the chord is read from. */
export interface RevealKeyEvent {
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/** Whether the webview runs on Windows, by its user agent (VS Code's `isWindows` is the same machine's). */
export function onWindows(userAgent: string): boolean {
  return /\bWindows\b/u.test(userAgent);
}

/** Windows' Shift+Alt+R, by the key's place on the keyboard, whatever the layout prints on it; a held key's repeats are not. */
export function isWindowsRevealChord(e: RevealKeyEvent): boolean {
  return e.code === 'KeyR' && e.shiftKey && e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat;
}

/**
 * How long after a key pressed in the tree the host's ask (`commit/revealRow`)
 * is still taken as that key's. The ask follows the key by milliseconds, but
 * by then focus may have moved: Alt can hand it to the menu bar.
 */
export const REVEAL_KEY_WINDOW_MS = 3000;

/** Whether the host's ask is answered: the tree has the keyboard, or a key was pressed in it just now. */
export function answersRevealAsk(treeFocused: boolean, lastTreeKeyAt: number, now: number): boolean {
  return treeFocused || now - lastTreeKeyAt < REVEAL_KEY_WINDOW_MS;
}
