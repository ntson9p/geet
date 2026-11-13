/**
 * Commit message editor (P11-T4). Master §6 rejected a webview commit dialog
 * over "IME/undo quirks"; this component is where those objections are paid
 * off rather than dismissed:
 *
 * - The textarea is **uncontrolled**. React never writes `value`, so the
 *   browser's native undo stack and composition state are never clobbered by a
 *   re-render. All listeners are attached natively in a mount effect; renders
 *   only touch attributes.
 * - Programmatic writes (history pick, amend prefill, post-commit clear) go
 *   through `setRangeText` + a dispatched `input` event, which lands the edit
 *   *on* the undo stack — Ctrl+Z after a history pick restores what was typed.
 * - Composition (`compositionstart`/`compositionend`) suspends the mirror and
 *   the debounced persist entirely; `compositionend` runs the catch-up, which
 *   also covers Chromium's fire-order (final `input` arrives *before*
 *   `compositionend`).
 * - Persist is debounced 250 ms; `flush()` (also wired to blur) forces it so a
 *   commit can never race a half-typed message.
 * - POST-P14bs: Ctrl+Enter (⌘Enter) commits, through VS Code's keybinding and
 *   back (`commitKey.ts`). The box only keeps the chord from typing a line
 *   break, holds it back while an IME is composing or the key is held, and
 *   says when it gains or loses the keyboard, which that keybinding's `when` reads.
 *
 * The subject-length hint is a direct DOM update for the same reason: a
 * per-keystroke React state change would re-render this subtree.
 *
 * POST-P14ca: the box no longer grows as you type. The window gives it a height
 * (the divider above the Amend row sets it), and a longer message scrolls
 * inside; until then it shows `MESSAGE_LINES` lines.
 */
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';
import { MESSAGE_LINES } from './commitLayout';
import { isCommitChord, onMac } from './commitKey';

export interface MessageEditorHandle {
  /** User-initiated insert (history/amend pick): undoable, takes focus. */
  insert(text: string): void;
  /** Host-initiated write (`commit/message` event): undoable, keeps focus put. */
  setProgrammatic(text: string): void;
  /**
   * Adopt the host's value unless the user is actively typing here — used only
   * for the init snapshot and an active-repo switch.
   */
  adoptExternal(text: string): void;
  /** Fire a pending debounced persist immediately. */
  flush(): void;
  /** POST-P14bs: an IME is composing here — text not taken yet, which a commit must wait for. */
  composing(): boolean;
  value(): string;
  focus(): void;
  /** POST-P14ca: the box's sizes as drawn, for the divider; undefined before it is. */
  metrics(): MessageMetrics | undefined;
}

/** POST-P14ca: what the divider needs to know about the box, all in px. */
export interface MessageMetrics {
  /** One line of text. */
  readonly line: number;
  /** The least the box is drawn at: one line, its padding and border. */
  readonly min: number;
  /** Its first height: `MESSAGE_LINES` lines, its padding and border. */
  readonly natural: number;
}

export interface MessageEditorProps {
  /** First-render value (webview state survives a reload; host init corrects). */
  initial: string;
  disabled: boolean;
  /** Immediate mirror for `canCommit` and webview-state persistence. */
  onInput: (value: string) => void;
  /** Debounced 250 ms — posts `commit/setMessage`. */
  onPersist: (value: string) => void;
  /** POST-P14bs: the box gained or lost the keyboard, which the commit key is bound to. */
  onFocusChange?: (focused: boolean) => void;
  /** POST-P14ca: the box's height in px, as the divider left it; its `MESSAGE_LINES` lines until then. */
  height?: number;
}

const PERSIST_DEBOUNCE_MS = 250;
/** POST-P14bs: the commit key is ⌘Enter there, Ctrl+Enter elsewhere, as the keybinding's `mac` and `key`. */
const ON_MAC = onMac(navigator.userAgent);
const SUBJECT_SOFT_LIMIT = 72;

/** The box's line height and the room its padding and border take, as drawn. */
export function measureMessageBox(el: HTMLTextAreaElement): MessageMetrics | undefined {
  const s = getComputedStyle(el);
  const px = (v: string): number => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  // `normal` has no number; the CSS sets one, so this is only a fallback.
  const line = px(s.lineHeight) || px(s.fontSize) * 1.4;
  if (line <= 0) return undefined;
  const chrome = px(s.paddingTop) + px(s.paddingBottom) + px(s.borderTopWidth) + px(s.borderBottomWidth);
  return { line, min: Math.ceil(line + chrome), natural: Math.ceil(MESSAGE_LINES * line + chrome) };
}

export const MessageEditor = memo(
  forwardRef<MessageEditorHandle, MessageEditorProps>(function MessageEditor(
    { initial, disabled, onInput, onPersist, onFocusChange, height },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const counterRef = useRef<HTMLSpanElement | null>(null);
    const composing = useRef(false);
    const dirty = useRef(false);
    const timer = useRef<number | undefined>(undefined);
    // Callbacks live in a ref so the mount-only listener effect never re-runs.
    const cb = useRef({ onInput, onPersist, onFocusChange });
    cb.current = { onInput, onPersist, onFocusChange };

    useEffect(() => {
      const el = taRef.current;
      if (!el) return undefined;

      const updateCounter = (): void => {
        const c = counterRef.current;
        if (!c) return;
        const subject = el.value.split('\n', 1)[0] ?? '';
        if (subject.length > SUBJECT_SOFT_LIMIT) {
          c.hidden = false;
          c.textContent = String(subject.length);
          c.title = `Subject is ${subject.length} characters (aim ≤ ${SUBJECT_SOFT_LIMIT})`;
        } else {
          c.hidden = true;
          c.textContent = '';
        }
      };

      const persistNow = (): void => {
        if (!dirty.current) return;
        dirty.current = false;
        cb.current.onPersist(el.value);
      };

      const changed = (): void => {
        if (composing.current) return;
        updateCounter();
        cb.current.onInput(el.value);
        dirty.current = true;
        if (timer.current !== undefined) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          timer.current = undefined;
          persistNow();
        }, PERSIST_DEBOUNCE_MS);
      };

      const flushNow = (): void => {
        if (timer.current !== undefined) {
          window.clearTimeout(timer.current);
          timer.current = undefined;
        }
        persistNow();
      };

      const onCompositionStart = (): void => {
        composing.current = true;
      };
      const onCompositionEnd = (): void => {
        composing.current = false;
        // Chromium fires the final `input` *before* `compositionend`, so the
        // catch-up has to happen here or the composed text never persists.
        changed();
      };

      // POST-P14bs: the commit key's `when` follows the keyboard in and out.
      const focused = (): void => cb.current.onFocusChange?.(true);
      const blurred = (): void => cb.current.onFocusChange?.(false);

      // POST-P14bs: the commit chord. VS Code resolves the keybinding from the
      // key it is passed on; all the box decides is what else the key does.
      const onKeyDown = (e: KeyboardEvent): void => {
        if (!isCommitChord(e, ON_MAC)) return;
        if (e.isComposing || composing.current) {
          // The IME's key, over text the box has not taken yet: VS Code must
          // not commit without it.
          e.stopPropagation();
          return;
        }
        // Never a line break: the key is the Commit button's. VS Code passes
        // on a cancelled key all the same.
        e.preventDefault();
        // A held key asks once.
        if (e.repeat) e.stopPropagation();
      };

      el.addEventListener('input', changed);
      el.addEventListener('compositionstart', onCompositionStart);
      el.addEventListener('compositionend', onCompositionEnd);
      el.addEventListener('blur', flushNow);
      el.addEventListener('focus', focused);
      el.addEventListener('blur', blurred);
      el.addEventListener('keydown', onKeyDown);
      updateCounter();
      return () => {
        el.removeEventListener('input', changed);
        el.removeEventListener('compositionstart', onCompositionStart);
        el.removeEventListener('compositionend', onCompositionEnd);
        el.removeEventListener('blur', flushNow);
        el.removeEventListener('focus', focused);
        el.removeEventListener('blur', blurred);
        el.removeEventListener('keydown', onKeyDown);
        if (timer.current !== undefined) window.clearTimeout(timer.current);
        // Unmounting fires no blur, so the box says it here; a box that did
        // not have the keyboard repeats what was said, which sends nothing.
        blurred();
      };
    }, []);

    /**
     * Programmatic write that lands on the undo stack. The plan named
     * `setRangeText`, but Chromium does not record it in undo history
     * (verified: Ctrl+Z after a setRangeText insert restores nothing) —
     * `document.execCommand('insertText')` is the API that does, and it also
     * fires the native `input` event our listeners hang off. Deprecated but
     * load-bearing in Chromium/Electron, which is the only runtime webviews
     * have; setRangeText stays as the functional (non-undoable) fallback.
     */
    const write = (text: string, keepFocus: HTMLElement | null): void => {
      const el = taRef.current;
      if (!el || el.value === text) return;
      el.focus(); // execCommand acts on the focused editable
      el.select();
      const ok =
        text.length > 0
          ? document.execCommand('insertText', false, text)
          : document.execCommand('delete', false);
      if (!ok || el.value !== text) {
        el.setRangeText(text, 0, el.value.length, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (keepFocus && keepFocus !== el) keepFocus.focus();
    };

    useImperativeHandle(ref, () => ({
      insert(text: string): void {
        const el = taRef.current;
        if (!el || el.disabled) return;
        write(text, null); // a pick moves focus into the editor, like IntelliJ
      },
      setProgrammatic(text: string): void {
        // Host-initiated: whatever the user had focused keeps focus.
        write(text, document.activeElement as HTMLElement | null);
      },
      adoptExternal(text: string): void {
        const el = taRef.current;
        if (!el || composing.current) return;
        // Focused *and* the webview owns focus means the user is typing here;
        // a focused element in a blurred document (a QuickPick is up) is safe.
        if (document.activeElement === el && document.hasFocus()) return;
        write(text, document.activeElement as HTMLElement | null);
      },
      flush(): void {
        const el = taRef.current;
        if (timer.current !== undefined) {
          window.clearTimeout(timer.current);
          timer.current = undefined;
        }
        if (dirty.current && el) {
          dirty.current = false;
          cb.current.onPersist(el.value);
        }
      },
      composing(): boolean {
        return composing.current;
      },
      value(): string {
        return taRef.current?.value ?? '';
      },
      focus(): void {
        taRef.current?.focus();
      },
      metrics(): MessageMetrics | undefined {
        const el = taRef.current;
        return el ? measureMessageBox(el) : undefined;
      },
    }));

    return (
      <div className="gt-commit-message-wrap">
        <textarea
          ref={taRef}
          className="gt-input gt-commit-message"
          aria-label="Commit message"
          data-testid="commit-message"
          rows={MESSAGE_LINES}
          defaultValue={initial}
          disabled={disabled}
          placeholder="Commit message"
          // React writes the style, never the value: the box stays uncontrolled.
          style={height !== undefined ? { height: `${height}px` } : undefined}
        />
        <span
          ref={counterRef}
          hidden
          className="gt-commit-subject-len"
          data-testid="subject-length"
          aria-live="polite"
        />
      </div>
    );
  }),
);
