/**
 * Toolbar (master §9 shared lib): themed via --vscode-* variables only,
 * fully keyboard-operable, codicon-friendly.
 */
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';

export interface ToolbarProps {
  ariaLabel: string;
  children: ReactNode;
}

export function Toolbar({ ariaLabel, children }: ToolbarProps) {
  return (
    <div className="gt-toolbar" role="toolbar" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export interface ToolbarButtonProps {
  label: string;
  /** Codicon name without the `codicon-` prefix, e.g. "refresh". */
  icon?: string;
  /** A drawing of its own, for the few IntelliJ icons no codicon resembles. */
  glyph?: ReactNode;
  /**
   * IntelliJ's dot in the icon's corner: the settings behind this button are
   * not their defaults.
   */
  badge?: boolean;
  /** Show the text label next to the icon. */
  showLabel?: boolean;
  disabled?: boolean;
  toggled?: boolean;
  /**
   * The work this button started is running: its icon turns (a Refresh, a
   * Fetch) and clicks are ignored until it ends. Not `disabled` — a dimmed
   * icon would hide the very motion that says it is working.
   */
  busy?: boolean;
  /** The event is passed through so dropdowns can anchor to the button. */
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function ToolbarButton({
  label,
  icon,
  glyph,
  badge,
  showLabel,
  disabled,
  toggled,
  busy,
  onClick,
}: ToolbarButtonProps) {
  const drawn = icon !== undefined || glyph !== undefined;
  return (
    <button
      type="button"
      className={`gt-toolbar-button${toggled ? ' gt-toggled' : ''}${busy === true ? ' gt-busy' : ''}`}
      aria-label={label}
      aria-pressed={toggled}
      aria-busy={busy === true ? true : undefined}
      title={label}
      disabled={disabled}
      onClick={busy === true ? undefined : onClick}
    >
      {icon ? (
        <span
          className={`codicon codicon-${icon}${busy === true ? ' gt-spin' : ''}`}
          aria-hidden="true"
        />
      ) : null}
      {glyph !== undefined ? (
        <span className="gt-toolbar-glyph" aria-hidden="true">
          {glyph}
        </span>
      ) : null}
      {badge === true ? <span className="gt-toolbar-badge" aria-hidden="true" /> : null}
      {showLabel || !drawn ? <span className="gt-toolbar-button-label">{label}</span> : null}
    </button>
  );
}

export interface FilterChipProps {
  label: string;
  active: boolean;
  onToggle: (active: boolean) => void;
}

/** Toggleable filter pill used by the log filter bar (P4) and PR lists (P8). */
export function FilterChip({ label, active, onToggle }: FilterChipProps) {
  return (
    <button
      type="button"
      className={`gt-filter-chip${active ? ' gt-active' : ''}`}
      role="switch"
      aria-checked={active}
      onClick={() => onToggle(!active)}
    >
      {label}
    </button>
  );
}
