import { describe, expect, it } from 'vitest';
import {
  answersRevealAsk,
  isWindowsRevealChord,
  onWindows,
  REVEAL_KEY_WINDOW_MS,
} from '../../../webview-ui/src/commit/revealKey';

/**
 * POST-P14bq — the reveal key in the Commit window's tree. Windows' Shift+Alt+R
 * is answered in the webview: passed on, VS Code also opened its Run menu.
 */
describe('the reveal key in the change tree', () => {
  const key = (over: Partial<Parameters<typeof isWindowsRevealChord>[0]> = {}) => ({
    code: 'KeyR',
    shiftKey: true,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    repeat: false,
    ...over,
  });

  it('tells Windows from the user agent VS Code’s webview reports', () => {
    expect(onWindows('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Code/1.144.0 Electron/37')).toBe(true);
    expect(onWindows('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Code/1.144.0')).toBe(false);
    expect(onWindows('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Code/1.144.0')).toBe(false);
  });

  it('is Shift+Alt+R exactly, by the key’s place whatever the layout prints on it', () => {
    expect(isWindowsRevealChord(key())).toBe(true);
    expect(isWindowsRevealChord(key({ shiftKey: false }))).toBe(false);
    expect(isWindowsRevealChord(key({ altKey: false }))).toBe(false);
    // Ctrl+Alt is AltGr on many layouts: a typed character, never this key.
    expect(isWindowsRevealChord(key({ ctrlKey: true }))).toBe(false);
    expect(isWindowsRevealChord(key({ metaKey: true }))).toBe(false);
    expect(isWindowsRevealChord(key({ code: 'KeyT' }))).toBe(false);
  });

  it('answers a held key once, not once per repeat', () => {
    expect(isWindowsRevealChord(key({ repeat: true }))).toBe(false);
  });

  it("answers the host's ask while the tree has the keyboard, or just after a key pressed in it", () => {
    const now = 100_000;
    expect(answersRevealAsk(true, Number.NEGATIVE_INFINITY, now)).toBe(true);
    // Focus moved on (Alt can hand it to the menu bar) right after the key.
    expect(answersRevealAsk(false, now - 40, now)).toBe(true);
    expect(answersRevealAsk(false, now - REVEAL_KEY_WINDOW_MS + 1, now)).toBe(true);
    // Long after, or never: nobody is looking at the tree.
    expect(answersRevealAsk(false, now - REVEAL_KEY_WINDOW_MS, now)).toBe(false);
    expect(answersRevealAsk(false, Number.NEGATIVE_INFINITY, now)).toBe(false);
  });
});
