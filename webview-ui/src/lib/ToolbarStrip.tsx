/**
 * ToolbarStrip (P11-T1): the per-pane icon strips that make IntelliJ's tool
 * windows feel like tool windows (gap analysis S1/S2) — the commit window's
 * eight icons, the log panes' own toolbars.
 *
 * Roving tabindex per the ARIA toolbar pattern: the strip is one tab stop and
 * arrows move between controls, so a keyboard user does not have to tab
 * through eight buttons to reach the tree.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Menu, type MenuItem } from './Menu';

export interface ToolbarStripProps {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
}

export function ToolbarStrip({ ariaLabel, children, className }: ToolbarStripProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') {
      return;
    }
    const host = hostRef.current;
    if (!host) return;
    const buttons = [...host.querySelectorAll<HTMLElement>('button:not(:disabled)')];
    if (buttons.length === 0) return;
    const at = buttons.findIndex((b) => b === document.activeElement);
    let next: number;
    switch (e.key) {
      case 'ArrowLeft':
        next = at <= 0 ? buttons.length - 1 : at - 1;
        break;
      case 'ArrowRight':
        next = at === -1 || at === buttons.length - 1 ? 0 : at + 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = buttons.length - 1;
        break;
    }
    buttons[next]?.focus();
    e.preventDefault();
  };

  return (
    <div
      ref={hostRef}
      role="toolbar"
      aria-label={ariaLabel}
      className={`gt-toolbar gt-toolbar-strip${className !== undefined ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

export function ToolbarSeparator() {
  return <span className="gt-toolbar-sep" role="separator" aria-orientation="vertical" />;
}

/** Pushes everything after it to the right-hand end of the strip. */
export function ToolbarSpacer() {
  return <span className="gt-toolbar-spacer" />;
}

export interface ToolbarDropdownProps {
  /** Current value shown on the button, e.g. `All` for `Push tags: [All v]`. */
  label: string;
  ariaLabel: string;
  items: readonly MenuItem[];
  onSelect: (id: string) => void;
  icon?: string;
  disabled?: boolean;
}

/** The `[Something v]` control the IntelliJ dialogs and log filter row use. */
export function ToolbarDropdown({
  label,
  ariaLabel,
  items,
  onSelect,
  icon,
  disabled,
}: ToolbarDropdownProps) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="gt-toolbar-button gt-dropdown"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        disabled={disabled}
        onClick={() => {
          const box = btnRef.current?.getBoundingClientRect();
          setAt(box ? { x: box.left, y: box.bottom } : { x: 0, y: 0 });
        }}
      >
        {icon !== undefined ? <span className={`codicon codicon-${icon}`} aria-hidden="true" /> : null}
        <span className="gt-toolbar-button-label">{label}</span>
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {at !== null ? (
        <Menu
          items={items}
          at={at}
          ariaLabel={ariaLabel}
          onSelect={onSelect}
          onClose={() => setAt(null)}
        />
      ) : null}
    </>
  );
}
