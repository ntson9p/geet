/**
 * Tabs (P11-T1): the `Commit | Shelf` and `Log | Console` strips (gap analysis
 * S13). Follows the ARIA tabs pattern — one tab stop, arrows move selection,
 * Home/End jump to the ends. A tab can be closable (the Git tool window's
 * extra Log tabs): a `×` on it, middle-click, or the strip's own menu.
 */
import {
  useRef,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

export interface TabDef {
  readonly id: string;
  readonly label: string;
  /** Codicon name without the `codicon-` prefix. */
  readonly icon?: string;
  /** Trailing count badge, e.g. unread console errors. */
  readonly badge?: string;
  /** Shows a `×`, and middle-click closes it. Needs `onClose`. */
  readonly closable?: boolean;
  /** Hover text; a long label is cut short in the strip, so this carries all of it. */
  readonly title?: string;
}

export interface TabsProps {
  tabs: readonly TabDef[];
  active: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  /** Rendered to the right of the tab strip — per-window actions. */
  actions?: ReactNode;
  /** Rendered right after the last tab, as IntelliJ's `+` is. */
  trailing?: ReactNode;
  onClose?: (id: string) => void;
  /** Right-click (or the context-menu key) on a tab, at viewport coordinates. */
  onTabContextMenu?: (id: string, at: { x: number; y: number }) => void;
}

export function Tabs({
  tabs,
  active,
  onChange,
  ariaLabel,
  actions,
  trailing,
  onClose,
  onTabContextMenu,
}: TabsProps) {
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

  const openMenu = (id: string, e: ReactMouseEvent<HTMLElement>): void => {
    if (!onTabContextMenu) return;
    // Handled here, so VS Code's own webview menu (Cut/Copy/Paste) stays shut.
    e.preventDefault();
    // The context-menu key reports no pointer; open under the tab instead.
    const box = e.currentTarget.getBoundingClientRect();
    const keyboard = e.clientX === 0 && e.clientY === 0;
    onTabContextMenu(id, keyboard ? { x: box.left, y: box.bottom } : { x: e.clientX, y: e.clientY });
  };

  return (
    <div className="gt-tabs-strip">
      <div
        ref={stripRef}
        role="tablist"
        aria-label={ariaLabel}
        className={`gt-tabs${trailing !== undefined ? ' gt-tabs-fit' : ''}`}
        onKeyDown={onKeyDown}
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const closable = tab.closable === true && onClose !== undefined;
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
              title={tab.title}
              className={`gt-tab${selected ? ' gt-active' : ''}${closable ? ' gt-closable' : ''}`}
              onClick={() => onChange(tab.id)}
              onMouseDown={(e) => {
                // A middle press would start the browser's autoscroll.
                if (e.button === 1 && closable) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1 || !closable) return;
                e.preventDefault();
                onClose(tab.id);
              }}
              onContextMenu={(e) => openMenu(tab.id, e)}
            >
              {tab.icon !== undefined ? (
                <span className={`codicon codicon-${tab.icon}`} aria-hidden="true" />
              ) : null}
              <span className="gt-tab-label">{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== '' ? (
                <span className="gt-tab-badge">{tab.badge}</span>
              ) : null}
              {closable ? (
                // Not a button of its own: a button inside the tab would be a
                // second tab stop per tab. The keyboard closes through the menu.
                <span
                  className="codicon codicon-close gt-tab-close"
                  aria-hidden="true"
                  title="Close Tab"
                  data-testid={`tab-close-${tab.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(tab.id);
                  }}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      {trailing}
      {trailing !== undefined ? <span className="gt-tabs-spacer" /> : null}
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
