/**
 * POST-P14bs — the commit key in the Commit window's message box: Ctrl+Enter,
 * ⌘Enter on macOS, as VS Code's Source Control box takes it. Pure, so it is
 * unit-tested.
 *
 * The key is a VS Code keybinding (`gittree.commit.fromMessageBox`, while
 * `gittree.commitMessageFocus`), so it can be rebound. VS Code resolves it from
 * the key the webview passes on, and the host asks the webview to commit
 * (`commit/commitKey`), which it does as its Commit button does: the message
 * as typed this instant, which the host's copy may not have yet.
 *
 * The box keeps the chord from typing a line break: VS Code passes on a key
 * the webview cancelled all the same. It holds the chord back from VS Code
 * while an IME is composing, whose text the box has not taken yet, and while
 * the key is held down, so that one press asks once.
 */

/** The parts of a keydown the chord is read from. */
export interface CommitKeyEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** Whether the webview runs on macOS, by its user agent (VS Code's `isMac` is the same machine's). */
export function onMac(userAgent: string): boolean {
  return /\bMacintosh\b|\bMac OS X\b/u.test(userAgent);
}

/**
 * The default chord, as the keybinding's `key` and `mac` name it: Ctrl+Enter,
 * ⌘Enter on macOS. The keypad's Enter too, as VS Code resolves it.
 */
export function isCommitChord(e: CommitKeyEvent, mac: boolean): boolean {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** What the host's ask is answered from. */
export interface CommitAskState {
  /** The message box has the keyboard. */
  readonly messageFocused: boolean;
  /** An IME is composing in it: text the box has not taken yet. */
  readonly composing: boolean;
  /** The Commit button is enabled. */
  readonly canCommit: boolean;
}

/**
 * Whether the host's ask commits: only as the Commit button would, and only
 * while the box has the keyboard, which a key bound to it implies. A late ask
 * that finds the keyboard gone was not meant for whatever has it now.
 */
export function answersCommitAsk(state: CommitAskState): boolean {
  return state.messageFocused && !state.composing && state.canCommit;
}
