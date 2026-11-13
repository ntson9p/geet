/**
 * OverflowToolbar (POST-P14ca): a toolbar strip that keeps on its row the
 * actions that fit and folds the rest into a `⋯` menu, as VS Code's own view
 * toolbars do. The Commit tab's toolbar shares the tab row with the tabs, which
 * leaves it three or four buttons' room at the side bar's usual width.
 *
 * Every action keeps its label: a button's tooltip and accessible name, and the
 * menu row's text. A toggle reads as ticked in the menu; a dot on a folded
 * action (settings not at their defaults) shows on the `⋯`.
 */
import { useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Menu, type MenuItem } from './Menu';
import { ToolbarButton } from './Toolbar';
import { toolbarFit } from './toolbarFit';
import { ToolbarStrip } from './ToolbarStrip';
import { useElementSize } from './useElementSize';

export interface OverflowAction {
  readonly id: string;
  readonly label: string;
  /** Codicon name without the `codicon-` prefix. */
  readonly icon: string;
  /** Lower stays on the row longer: 0 is the last to fold into `⋯`. */
  readonly priority: number;
  readonly disabled?: boolean;
  readonly toggled?: boolean;
  /** IntelliJ's dot: the settings behind it are not their defaults. */
  readonly badge?: boolean;
  readonly busy?: boolean;
  /**
   * Run it. `anchor` is where a menu it opens belongs, in viewport px: under
   * its button, or under the `⋯` when it was picked from there.
   */
  readonly run: (anchor: { readonly x: number; readonly y: number }) => void;
}

/** A button's width, the gap between two, and the strip's padding, as `.gt-overflow-toolbar` draws them. */
export const OVERFLOW_BUTTON_PX = 26;
export const OVERFLOW_GAP_PX = 2;
export const OVERFLOW_PAD_PX = 4;

export interface OverflowToolbarProps {
  ariaLabel: string;
  actions: readonly OverflowAction[];
  className?: string;
}

const under = (e: ReactMouseEvent<HTMLElement>): { x: number; y: number } => {
  const box = e.currentTarget.getBoundingClientRect();
  return { x: box.left, y: box.bottom + 2 };
};

export function OverflowToolbar({ ariaLabel, actions, className }: OverflowToolbarProps) {
  const [hostRef, size] = useElementSize<HTMLDivElement>();
  const [menuAt, setMenuAt] = useState<{ readonly x: number; readonly y: number } | null>(null);
  // Unmeasured (0) stays 0, which keeps every button: see toolbarFit.
  const room = size.width > 0 ? Math.max(1, size.width - OVERFLOW_PAD_PX) : 0;
  const fit = toolbarFit(actions, room, OVERFLOW_BUTTON_PX, OVERFLOW_GAP_PX);
  const byId = new Map(actions.map((a) => [a.id, a]));
  const shown = fit.shown.flatMap((id) => byId.get(id) ?? []);
  const more = fit.more.flatMap((id) => byId.get(id) ?? []);

  const items: MenuItem[] = more.map((a) => ({
    kind: 'item',
    id: a.id,
    label: a.label,
    icon: a.icon,
    ...(a.disabled === true || a.busy === true ? { disabled: true } : {}),
    ...(a.toggled !== undefined ? { checked: a.toggled } : {}),
  }));

  return (
    <div ref={hostRef} className={`gt-overflow-toolbar${className !== undefined ? ` ${className}` : ''}`}>
      <ToolbarStrip ariaLabel={ariaLabel}>
        {shown.map((a) => (
          <ToolbarButton
            key={a.id}
            icon={a.icon}
            label={a.label}
            disabled={a.disabled}
            toggled={a.toggled}
            badge={a.badge}
            busy={a.busy}
            onClick={(e) => a.run(under(e))}
          />
        ))}
        {more.length > 0 ? (
          <ToolbarButton
            icon="ellipsis"
            label="More Actions"
            badge={more.some((a) => a.badge === true)}
            onClick={(e) => {
              const at = under(e);
              setMenuAt((open) => (open === null ? at : null));
            }}
          />
        ) : null}
      </ToolbarStrip>
      {menuAt !== null && more.length > 0 ? (
        <Menu
          items={items}
          at={menuAt}
          ariaLabel="More Actions"
          onSelect={(id) => {
            const at = menuAt;
            setMenuAt(null);
            byId.get(id)?.run(at);
          }}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
    </div>
  );
}
