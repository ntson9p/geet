/**
 * Menu (P11-T1): context menus and the `>` submenus the IntelliJ branch rows
 * and tree rows need (gap analysis S3). Keyboard model per the ARIA menu
 * pattern: arrows move, Right opens a submenu, Left/Escape closes one, Escape
 * at the top level dismisses and returns focus to whatever opened the menu.
 *
 * Used where VS Code's native context menus cannot reach — inside a webview,
 * `data-vscode-context` only works for menus contributed to `webview/context`,
 * which cannot carry dynamic, per-row labels like
 * `Merge 'feature/f1-1' into 'master'`.
 *
 * A menu is drawn inside its webview and cannot leave it, so it is never
 * taller or wider than the webview: past that it scrolls, and its labels end
 * in `…` (new-way-6). A branch's menu across twenty repositories ran off the
 * foot of the sidebar, its last rows out of the pointer's reach. The arrows
 * bring the row they reach into view; a submenu whose row scrolls away closes.
 *
 * It closes as VS Code's own menus do: on a click outside it, in its webview or
 * anywhere else in VS Code, or when its webview loses focus (`useDismiss`).
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { placeMenu } from './menuPlace';
import { useDismiss } from './useDismiss';

export type MenuItem =
  | {
      readonly kind: 'item';
      readonly id: string;
      readonly label: string;
      /** Codicon name without the `codicon-` prefix. */
      readonly icon?: string;
      /** Right-aligned shortcut hint, e.g. `Ctrl+T` or `F2`. */
      readonly accelerator?: string;
      readonly disabled?: boolean;
      readonly checked?: boolean;
      /**
       * One of a run of choices only one of which holds (View Options › Group By):
       * announced as a radio item, ticked like a checkbox.
       */
      readonly radio?: boolean;
      /** Hover text — what IntelliJ's action description says, e.g. why it is disabled. */
      readonly title?: string;
    }
  | {
      readonly kind: 'submenu';
      readonly id: string;
      readonly label: string;
      readonly icon?: string;
      readonly items: readonly MenuItem[];
      readonly disabled?: boolean;
    }
  | { readonly kind: 'separator'; readonly id: string }
  /**
   * A group's caption, IntelliJ's `Show` / `Highlight` above a run of toggles.
   * Not an item: the pointer and the arrow keys pass over it.
   */
  | { readonly kind: 'header'; readonly id: string; readonly label: string };

export interface MenuProps {
  items: readonly MenuItem[];
  /**
   * Viewport coordinates to open at. A submenu also has `flipX`, its parent's
   * left edge: with no room on the right it opens leftwards from there, as
   * VS Code's own submenus do, rather than over the row that opened it.
   */
  at: { readonly x: number; readonly y: number; readonly flipX?: number };
  onSelect: (id: string) => void;
  onClose: () => void;
  ariaLabel: string;
  /** The item the keyboard starts on, such as the choice that holds; the first enabled one otherwise. */
  activeId?: string;
  /** Internal: submenus skip the dismissal (`useDismiss`) and focus-restore handling. */
  nested?: boolean;
}

function isEnabled(item: MenuItem): boolean {
  return (item.kind === 'item' || item.kind === 'submenu') && item.disabled !== true;
}

export function Menu({ items, at, onSelect, onClose, ariaLabel, activeId, nested }: MenuProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  /** The open submenu, drawn beside this menu rather than inside it. */
  const subRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [pos, setPos] = useState(at);
  const [active, setActive] = useState<number>(() => {
    const wanted = activeId !== undefined ? items.findIndex((i) => isEnabled(i) && i.id === activeId) : -1;
    return wanted >= 0 ? wanted : items.findIndex(isEnabled);
  });
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number; flipX: number } | null>(null);
  /**
   * The keyboard (or the opening, on `activeId`) moved the active row: bring
   * it into view. The pointer's row is in view already, and scrolling under
   * it would close the submenu it has just opened.
   */
  const reveal = useRef(true);

  // Focus restoration is the top-level menu's job; a submenu returns focus to
  // its parent menu simply by unmounting. Not once focus has gone elsewhere in
  // VS Code: taking it back would undo the click that closed the menu.
  useEffect(() => {
    if (nested === true) return undefined;
    restoreRef.current = document.activeElement as HTMLElement | null;
    return () => {
      if (document.hasFocus()) restoreRef.current?.focus?.();
    };
  }, [nested]);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    setPos(
      placeMenu(
        { x: at.x, y: at.y, ...(at.flipX !== undefined ? { flipX: at.flipX } : {}) },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [at.x, at.y, at.flipX, items]);

  useLayoutEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const host = hostRef.current;
    const row = host?.querySelector<HTMLElement>(`[data-menu-index="${active}"]`);
    if (!host || !row || host.scrollHeight <= host.clientHeight) return;
    // The first row shows the menu from its top, a heading above it included.
    const top = active === items.findIndex(isEnabled) ? 0 : row.offsetTop;
    const bottom = row.offsetTop + row.offsetHeight;
    if (top < host.scrollTop) host.scrollTop = top;
    else if (bottom > host.scrollTop + host.clientHeight) host.scrollTop = bottom - host.clientHeight;
  }, [active, items]);

  useEffect(() => {
    // Only while the webview has focus: taking it from an unfocused webview
    // could take it from the editor the user has just clicked.
    if (document.hasFocus()) hostRef.current?.focus();
  }, []);

  // A click elsewhere in this webview or anywhere in VS Code, or the webview
  // losing focus, closes the menu and its submenu (`useDismiss`). A press in a
  // submenu is a press in the menu: missing that, the menu closed under the
  // press, and a click never picked a submenu's item.
  useDismiss([hostRef, subRef], onClose, nested !== true);

  const step = useCallback(
    (delta: number): void => {
      if (items.length === 0) return;
      let i = active;
      for (let n = 0; n < items.length; n++) {
        i = (i + delta + items.length) % items.length;
        const item = items[i];
        if (item && isEnabled(item)) {
          setActive(i);
          setOpenSub(null);
          return;
        }
      }
    },
    [active, items],
  );

  const openSubmenuAt = useCallback(
    (index: number): void => {
      const el = hostRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
      const box = el?.getBoundingClientRect();
      const host = hostRef.current?.getBoundingClientRect();
      setOpenSub({
        index,
        x: (host?.right ?? pos.x) - 2,
        y: box?.top ?? pos.y,
        flipX: (host?.left ?? pos.x) + 2,
      });
    },
    [pos.x, pos.y],
  );

  const activate = useCallback(
    (index: number): void => {
      const item = items[index];
      if (!item || !isEnabled(item)) return;
      if (item.kind === 'submenu') {
        openSubmenuAt(index);
        return;
      }
      onSelect(item.id);
      onClose();
    },
    [items, onClose, onSelect, openSubmenuAt],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') reveal.current = true;
    switch (e.key) {
      case 'ArrowDown':
        step(1);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'Home':
        setActive(items.findIndex(isEnabled));
        break;
      case 'End':
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          if (item && isEnabled(item)) {
            setActive(i);
            break;
          }
        }
        break;
      case 'ArrowRight': {
        const item = items[active];
        if (item?.kind === 'submenu') openSubmenuAt(active);
        else return;
        break;
      }
      case 'ArrowLeft':
      case 'Escape':
        onClose();
        break;
      case 'Enter':
      case ' ':
        activate(active);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const sub = openSub === null ? undefined : items[openSub.index];

  return (
    <>
      <div
        ref={hostRef}
        role="menu"
        aria-label={ariaLabel}
        tabIndex={-1}
        className="gt-menu"
        style={{ left: pos.x, top: pos.y }}
        onKeyDown={onKeyDown}
        // A submenu stands beside its row; scrolled, the row moves on without it.
        onScroll={() => setOpenSub(null)}
      >
        {items.map((item, index) => {
          if (item.kind === 'separator') {
            return <div key={item.id} role="separator" className="gt-menu-sep" />;
          }
          if (item.kind === 'header') {
            return (
              <div key={item.id} role="presentation" className="gt-menu-header">
                {item.label}
              </div>
            );
          }
          const isActive = index === active;
          const checkedState = item.kind === 'item' ? item.checked : undefined;
          const radio = item.kind === 'item' && item.radio === true;
          return (
            <div
              key={item.id}
              role={radio ? 'menuitemradio' : checkedState === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={radio ? checkedState === true : checkedState}
              aria-disabled={item.disabled === true}
              aria-haspopup={item.kind === 'submenu' ? 'menu' : undefined}
              aria-expanded={item.kind === 'submenu' ? openSub?.index === index : undefined}
              data-menu-index={index}
              title={item.kind === 'item' ? item.title : undefined}
              className={`gt-menu-item${isActive ? ' gt-active' : ''}${item.disabled === true ? ' gt-disabled' : ''}`}
              onMouseMove={(e) => {
                // The row the pointer moved onto, not one that came under a
                // pointer standing still: the menu opened beneath it, or the
                // keyboard scrolled it. Chrome then sends a move of no distance,
                // and taking it stole the keyboard's row (new-way-6).
                if (e.movementX === 0 && e.movementY === 0) return;
                if (!isEnabled(item)) return;
                if (index !== active) setActive(index);
                if (item.kind === 'submenu') {
                  if (openSub?.index !== index) openSubmenuAt(index);
                } else if (openSub !== null) setOpenSub(null);
              }}
              onClick={() => activate(index)}
            >
              <span className="gt-menu-icon" aria-hidden="true">
                {checkedState === true ? (
                  <span className="codicon codicon-check" />
                ) : item.icon !== undefined ? (
                  <span className={`codicon codicon-${item.icon}`} />
                ) : null}
              </span>
              <span className="gt-menu-label">{item.label}</span>
              {item.kind === 'item' && item.accelerator !== undefined ? (
                <span className="gt-menu-accel">{item.accelerator}</span>
              ) : null}
              {item.kind === 'submenu' ? (
                <span className="codicon codicon-chevron-right gt-menu-chevron" aria-hidden="true" />
              ) : null}
            </div>
          );
        })}
      </div>
      {openSub !== null && sub?.kind === 'submenu' ? (
        // No box of its own (each menu is fixed in place): only for `contains`.
        <div ref={subRef} style={{ display: 'contents' }}>
          <Menu
            nested
            items={sub.items}
            at={{ x: openSub.x, y: openSub.y, flipX: openSub.flipX }}
            ariaLabel={sub.label}
            onSelect={(id) => {
              onSelect(id);
              onClose();
            }}
            onClose={() => {
              setOpenSub(null);
              hostRef.current?.focus();
            }}
          />
        </div>
      ) : null}
    </>
  );
}
