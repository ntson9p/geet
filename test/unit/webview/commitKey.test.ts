import { describe, expect, it } from 'vitest';
import { answersCommitAsk, isCommitChord, onMac } from '../../../webview-ui/src/commit/commitKey';

/**
 * POST-P14bs — Ctrl+Enter (⌘Enter on macOS) in the Commit window's message box
 * commits, as VS Code's Source Control box does. Bound to `focusedView`, the
 * key never fired: VS Code clears it once focus is inside a webview.
 */
describe('the commit key in the message box', () => {
  const key = (over: Partial<Parameters<typeof isCommitChord>[0]> = {}) => ({
    key: 'Enter',
    shiftKey: false,
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    ...over,
  });

  it('tells macOS from the user agent VS Code’s webview reports', () => {
    expect(
      onMac(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.144.0 Chrome/138.0.0.0 Electron/37.0.0 Safari/537.36',
      ),
    ).toBe(true);
    expect(onMac('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Code/1.144.0 Electron/37')).toBe(false);
    expect(onMac('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Code/1.144.0')).toBe(false);
  });

  it('is Ctrl+Enter on Windows and Linux, the keybinding’s key', () => {
    expect(isCommitChord(key(), false)).toBe(true);
    // Enter alone, and Shift+Enter, are a new line in the message.
    expect(isCommitChord(key({ ctrlKey: false }), false)).toBe(false);
    expect(isCommitChord(key({ shiftKey: true }), false)).toBe(false);
    // Ctrl+Alt is AltGr on many layouts: a typed character, never this key.
    expect(isCommitChord(key({ altKey: true }), false)).toBe(false);
    expect(isCommitChord(key({ metaKey: true }), false)).toBe(false);
    expect(isCommitChord(key({ ctrlKey: false, metaKey: true }), false)).toBe(false);
    expect(isCommitChord(key({ key: 'a' }), false)).toBe(false);
  });

  it('is ⌘Enter on macOS, the keybinding’s mac', () => {
    expect(isCommitChord(key({ ctrlKey: false, metaKey: true }), true)).toBe(true);
    // Ctrl+Enter is not the Mac key: the box keeps it.
    expect(isCommitChord(key(), true)).toBe(false);
    expect(isCommitChord(key({ metaKey: true }), true)).toBe(false);
    expect(isCommitChord(key({ ctrlKey: false, metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isCommitChord(key({ ctrlKey: false, metaKey: true, altKey: true }), true)).toBe(false);
  });

  it('answers the host’s ask only as the Commit button would, and only while the box has the keyboard', () => {
    const ready = { messageFocused: true, composing: false, canCommit: true };
    expect(answersCommitAsk(ready)).toBe(true);
    // The button is disabled: no message, nothing ticked, or a commit running.
    expect(answersCommitAsk({ ...ready, canCommit: false })).toBe(false);
    // A late ask that finds the keyboard elsewhere was not meant for it.
    expect(answersCommitAsk({ ...ready, messageFocused: false })).toBe(false);
    // An IME's text the box has not taken yet would be missing from the commit.
    expect(answersCommitAsk({ ...ready, composing: true })).toBe(false);
  });
});
