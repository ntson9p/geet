/**
 * Dialog (P11-T1): the frame every P11-P13 dialog wears (gap analysis S4) —
 * title row, scrollable body, footer with `?` on the left and right-aligned
 * actions, matching the IntelliJ layouts transcribed in the gap analysis §2A.
 *
 * Deviation, recorded in docs/deviations.md (D2): this is **not OS-modal**.
 * VS Code has no modal webview, so a dialog is a focus-trapped editor-area
 * panel. It behaves modally within its own panel — `aria-modal`, trapped Tab,
 * Escape cancels, Enter fires the default action.
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Menu, type MenuItem } from './Menu';

export interface DialogButton {
  readonly id: string;
  readonly label: string;
  /** `default` is the Enter action and gets the accent style. */
  readonly variant?: 'default' | 'secondary';
  readonly disabled?: boolean;
  /** Adds a `v` split affordance, e.g. the Push dialog's `[Push v]`. */
  readonly menu?: readonly MenuItem[];
}

export interface DialogProps {
  title: string;
  children: ReactNode;
  buttons: readonly DialogButton[];
  onAction: (id: string) => void;
  onCancel: () => void;
  /** Shows the `?` affordance in the footer's left corner. */
  onHelp?: () => void;
  /** Extra footer content beside `?` — the option checkboxes IntelliJ puts there. */
  footerLeft?: ReactNode;
  className?: string;
}

const FOCUSABLE_PARTS = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
];
const FOCUSABLE = FOCUSABLE_PARTS.join(',');
/** Each part must carry the scope — a bare `,` list would match outside the body. */
const FOCUSABLE_IN_BODY = FOCUSABLE_PARTS.map((p) => `.gt-dialog-body ${p}`).join(',');

export function Dialog({
  title,
  children,
  buttons,
  onAction,
  onCancel,
  onHelp,
  footerLeft,
  className,
}: DialogProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [splitAt, setSplitAt] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const first = host.querySelector<HTMLElement>(FOCUSABLE_IN_BODY);
    (first ?? host.querySelector<HTMLElement>('.gt-dialog-default') ?? host).focus();
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Enter') {
      const el = e.target as HTMLElement;
      const tag = el.tagName.toLowerCase();
      // A multi-line editor owns Enter; so does any button the user has focused.
      if (tag === 'textarea' || tag === 'button' || tag === 'a' || tag === 'select') return;
      const def = buttons.find((b) => b.variant === 'default' && b.disabled !== true);
      if (!def) return;
      e.preventDefault();
      onAction(def.id);
      return;
    }
    if (e.key !== 'Tab') return;
    const host = hostRef.current;
    if (!host) return;
    const items = [...host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const firstEl = items[0] as HTMLElement;
    const lastEl = items[items.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  };

  return (
    <div
      ref={hostRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      className={`gt-dialog${className !== undefined ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      <div className="gt-dialog-title">
        <span className="gt-dialog-title-text">{title}</span>
        <button
          type="button"
          className="gt-toolbar-button gt-dialog-close"
          aria-label="Close"
          onClick={onCancel}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>

      <div className="gt-dialog-body">{children}</div>

      <div className="gt-dialog-footer">
        <div className="gt-dialog-footer-left">
          {onHelp ? (
            <button
              type="button"
              className="gt-toolbar-button"
              aria-label="Help"
              onClick={onHelp}
            >
              <span className="codicon codicon-question" aria-hidden="true" />
            </button>
          ) : null}
          {footerLeft}
        </div>
        <div className="gt-dialog-actions">
          {buttons.map((b) => {
            const isDefault = b.variant === 'default';
            return (
              <span key={b.id} className="gt-dialog-action">
                <button
                  type="button"
                  className={`gt-button${isDefault ? ' gt-primary gt-dialog-default' : ''}`}
                  disabled={b.disabled}
                  onClick={() => onAction(b.id)}
                >
                  {b.label}
                </button>
                {b.menu !== undefined && b.menu.length > 0 ? (
                  <button
                    type="button"
                    className={`gt-button gt-split-arrow${isDefault ? ' gt-primary' : ''}`}
                    aria-label={`${b.label} options`}
                    aria-haspopup="menu"
                    aria-expanded={splitAt?.id === b.id}
                    disabled={b.disabled}
                    onClick={(e) => {
                      const box = e.currentTarget.getBoundingClientRect();
                      setSplitAt({ id: b.id, x: box.left, y: box.top });
                    }}
                  >
                    <span className="codicon codicon-chevron-up" aria-hidden="true" />
                  </button>
                ) : null}
              </span>
            );
          })}
        </div>
      </div>

      {splitAt !== null
        ? (() => {
            const owner = buttons.find((b) => b.id === splitAt.id);
            if (!owner?.menu) return null;
            return (
              <Menu
                items={owner.menu}
                at={{ x: splitAt.x, y: splitAt.y }}
                ariaLabel={`${owner.label} options`}
                onSelect={onAction}
                onClose={() => setSplitAt(null)}
              />
            );
          })()
        : null}
    </div>
  );
}
