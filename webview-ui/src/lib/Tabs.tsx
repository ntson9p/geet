/**
 * Tabs (P11-T1): the `Commit | Shelf` and `Log | Console` strips (gap analysis
 * S13). Follows the ARIA tabs pattern — one tab stop, arrows move selection,
 * Home/End jump to the ends.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabDef {
  readonly id: string;
  readonly label: string;
  /** Codicon name without the `codicon-` prefix. */
  readonly icon?: string;
  /** Trailing count badge, e.g. unread console errors. */
  readonly badge?: string;
}

export interface TabsProps {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Rendered to the right of the tab strip — per-window actions. */
  actions?: ReactNode;
}

export function Tabs({ tabs, active, onChange, ariaLabel, actions }: TabsProps) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  const move = (delta: number): void => {
    if (tabs.length === 0) return;
    const at = tabs.findIndex((t) => t.id === active);
    const next = tabs[(at + delta + tabs.length) % tabs.length];
    if (next) {
      onChange(next.id);
      stripRef.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowRight':
        move(1);
        break;
      case 'ArrowLeft':
        move(-1);
        break;
      case 'Home': {
        const first = tabs[0];
        if (first) onChange(first.id);
        break;
      }
      case 'End': {
        const last = tabs[tabs.length - 1];
        if (last) onChange(last.id);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="gt-tabs-strip">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={ariaLabel}
        className="gt-tabs"
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-tab={tab.id}
              id={`gt-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`gt-tabpanel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              className={`gt-tab${selected ? ' gt-active' : ''}`}
              onClick={() => onChange(tab.id)}
            >
              {tab.icon !== undefined ? (
                <span className={`codicon codicon-${tab.icon}`} aria-hidden="true" />
              ) : null}
              <span>{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== '' ? (
                <span className="gt-tab-badge">{tab.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {actions !== undefined ? <div className="gt-tabs-actions">{actions}</div> : null}
    </div>
  );
}

export interface TabPanelProps {
  id: string;
  active: string;
  children: ReactNode;
  className?: string;
}

export function TabPanel({ id, active, children, className }: TabPanelProps) {
  if (id !== active) return null;
  return (
    <div
      role="tabpanel"
      id={`gt-tabpanel-${id}`}
      aria-labelledby={`gt-tab-${id}`}
      className={`gt-tabpanel${className !== undefined ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
