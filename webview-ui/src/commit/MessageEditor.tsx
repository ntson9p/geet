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
 *
 * The subject-length hint and autogrow are direct DOM updates for the same
 * reason: a per-keystroke React state change would re-render this subtree.
 */
import { forwardRef, memo, useEffect, useImperativeHandle, useRef } from 'react';

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
  value(): string;
  focus(): void;
}

export interface MessageEditorProps {
  /** First-render value (webview state survives a reload; host init corrects). */
  initial: string;
  disabled: boolean;
  /** Immediate mirror for `canCommit` and webview-state persistence. */
  onInput: (value: string) => void;
  /** Debounced 250 ms — posts `commit/setMessage`. */
  onPersist: (value: string) => void;
}

const PERSIST_DEBOUNCE_MS = 250;
const SUBJECT_SOFT_LIMIT = 72;
const MAX_HEIGHT_PX = 320;

export const MessageEditor = memo(
  forwardRef<MessageEditorHandle, MessageEditorProps>(function MessageEditor(
    { initial, disabled, onInput, onPersist },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const counterRef = useRef<HTMLSpanElement | null>(null);
    const composing = useRef(false);
    const dirty = useRef(false);
    const timer = useRef<number | undefined>(undefined);
    // Callbacks live in a ref so the mount-only listener effect never re-runs.
    const cb = useRef({ onInput, onPersist });
    cb.current = { onInput, onPersist };

    useEffect(() => {
      const el = taRef.current;
      if (!el) return undefined;

      const autosize = (): void => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight + 2, MAX_HEIGHT_PX)}px`;
      };

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
        autosize();
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

      el.addEventListener('input', changed);
      el.addEventListener('compositionstart', onCompositionStart);
      el.addEventListener('compositionend', onCompositionEnd);
      el.addEventListener('blur', flushNow);
      autosize();
      updateCounter();
      return () => {
        el.removeEventListener('input', changed);
        el.removeEventListener('compositionstart', onCompositionStart);
        el.removeEventListener('compositionend', onCompositionEnd);
        el.removeEventListener('blur', flushNow);
        if (timer.current !== undefined) window.clearTimeout(timer.current);
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
      value(): string {
        return taRef.current?.value ?? '';
      },
      focus(): void {
        taRef.current?.focus();
      },
    }));

    return (
      <div className="gt-commit-message-wrap">
        <textarea
          ref={taRef}
          className="gt-input gt-commit-message"
          aria-label="Commit message"
          data-testid="commit-message"
          rows={6}
          defaultValue={initial}
          disabled={disabled}
          placeholder="Commit message"
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
